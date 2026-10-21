import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { findExecutable, spawnable } from './executable.js'
import { SERVERS } from './lsp.js'
import type { LspManager, ServerSpec, ServerState } from './lsp.js'

const execFileAsync = promisify(execFile)

// csharp-ls (0.28+) runs on .NET 10, so `dotnet tool install` needs that SDK.
const CSHARP_LS_MIN_SDK = 10
const DOTNET_DOWNLOAD_URL = 'https://dotnet.microsoft.com/download'
const MAX_PROJECT_FILES = 200
const FIX_TIMEOUT_MS = 10 * 60_000

export interface ToolingFix {
  /** What to do, in a sentence. */
  description: string
  /** Shell command the user can run themselves. */
  command?: string
  /** Where the command runs: the repo root, or anywhere for global installs. */
  runIn?: 'repo' | 'anywhere'
  url?: string
  /** diffloupe can run `command` itself via POST /api/tooling/fix. */
  runnable: boolean
}

export interface ToolingCheck {
  id: string
  label: string
  /** 'ok', 'missing' (blocks exact results) or 'warning' (may degrade them). */
  status: 'ok' | 'missing' | 'warning'
  detail: string
  fix?: ToolingFix
}

export interface LanguageTooling {
  id: string
  label: string
  server: string
  /** All required checks pass; exact navigation can work. */
  ready: boolean
  checks: ToolingCheck[]
  serverState: ServerState
}

/** A fix diffloupe is allowed to run: a fixed argv, never user input. */
interface RunnableFix {
  command: string
  args: string[]
  cwd: string
}

async function run(command: string, args: string[], cwd: string): Promise<string | null> {
  try {
    const { command: file, shell } = spawnable(command)
    const { stdout } = await execFileAsync(file, args, { cwd, shell, timeout: 15_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true })
    return stdout
  } catch {
    return null
  }
}

async function listFiles(root: string, pathspecs: string[]): Promise<string[]> {
  const out = await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs], root)
  return out ? [...new Set(out.split('\0').filter(Boolean))] : []
}

function findDotnet(): string | null {
  return findExecutable('dotnet', [
    ...(process.env.DOTNET_ROOT ? [process.env.DOTNET_ROOT] : []),
    join(homedir(), '.dotnet'),
    ...(process.env.ProgramFiles ? [join(process.env.ProgramFiles, 'dotnet')] : []),
    '/usr/local/share/dotnet',
    '/usr/share/dotnet',
    '/opt/homebrew/bin',
  ])
}

const parseVersion = (v: string) => v.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)

/** Highest `netX.Y` major across the projects' target frameworks, plus any .NET Framework targets. */
function readTargetFrameworks(root: string, projects: string[]) {
  let maxMajor = 0
  const legacy = new Set<string>()
  for (const project of projects.slice(0, MAX_PROJECT_FILES)) {
    let xml: string
    try {
      xml = readFileSync(join(root, project), 'utf-8')
    } catch {
      continue
    }
    for (const match of xml.matchAll(/<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/g)) {
      for (const tfm of match[1].split(';').map((t) => t.trim())) {
        const modern = /^net(?:coreapp)?(\d+)\.\d/.exec(tfm)
        if (modern) maxMajor = Math.max(maxMajor, Number(modern[1]))
        else if (/^net\d{2,3}$/.test(tfm)) legacy.add(tfm)
      }
    }
  }
  return { maxMajor, legacy: [...legacy] }
}

/** Whether `installed` satisfies a global.json `sdk.version` with the default `latestPatch` roll-forward. */
function satisfiesGlobalJson(requested: string, installed: string[]): boolean {
  const [major, minor, patch] = parseVersion(requested)
  return installed.some((v) => {
    const [ma, mi, pa] = parseVersion(v)
    return ma === major && mi === minor && Math.floor(pa / 100) === Math.floor(patch / 100) && pa >= patch
  })
}

async function csharpChecks(root: string, spec: ServerSpec): Promise<{ checks: ToolingCheck[]; fixes: Map<string, RunnableFix> }> {
  const checks: ToolingCheck[] = []
  const fixes = new Map<string, RunnableFix>()
  const [solutions, projects] = await Promise.all([
    listFiles(root, ['*.sln', '*.slnx']),
    listFiles(root, ['*.csproj']),
  ])
  const { maxMajor, legacy } = readTargetFrameworks(root, projects)
  const neededMajor = Math.max(CSHARP_LS_MIN_SDK, maxMajor)

  // .NET SDK
  const dotnet = findDotnet()
  const sdks = dotnet
    ? ((await run(dotnet, ['--list-sdks'], root)) ?? '')
        .split('\n')
        .map((line) => line.split(' ')[0])
        .filter(Boolean)
    : []
  const hasSdk = sdks.some((v) => parseVersion(v)[0] >= neededMajor)
  const why = maxMajor > CSHARP_LS_MIN_SDK
    ? `your projects target net${maxMajor}.0`
    : `csharp-ls needs .NET ${CSHARP_LS_MIN_SDK}${maxMajor ? `; your projects target up to net${maxMajor}.0` : ''}`
  checks.push({
    id: 'dotnet-sdk',
    label: `.NET SDK ${neededMajor} or newer`,
    status: hasSdk ? 'ok' : 'missing',
    detail: dotnet
      ? `Installed: ${sdks.length ? sdks.join(', ') : 'no SDKs'} (${why})`
      : `The dotnet command was not found (${why})`,
    fix: hasSdk
      ? undefined
      : {
          description: `Install the .NET ${neededMajor} SDK from Microsoft, then reload this page.`,
          command: process.platform === 'darwin' ? 'brew install --cask dotnet-sdk' : undefined,
          runIn: 'anywhere',
          url: `${DOTNET_DOWNLOAD_URL}/dotnet/${neededMajor}.0`,
          runnable: false,
        },
  })

  // global.json pins an SDK; MSBuild fails to load the solution without it.
  if (existsSync(join(root, 'global.json'))) {
    let requested: string | undefined
    try {
      requested = JSON.parse(readFileSync(join(root, 'global.json'), 'utf-8'))?.sdk?.version
    } catch {
      // unreadable global.json: nothing to check
    }
    if (requested) {
      const ok = satisfiesGlobalJson(requested, sdks)
      checks.push({
        id: 'global-json',
        label: `SDK pinned by global.json (${requested})`,
        status: ok ? 'ok' : 'warning',
        detail: ok ? 'A matching SDK is installed.' : 'No installed SDK matches; the solution may fail to load.',
        fix: ok
          ? undefined
          : {
              description: `Install .NET SDK ${requested} (or a later patch in the same feature band).`,
              url: `${DOTNET_DOWNLOAD_URL}/dotnet/${requested.split('.').slice(0, 2).join('.')}`,
              runnable: false,
            },
      })
    }
  }

  // csharp-ls
  const serverPath = findExecutable(spec.command, spec.extraDirs(root))
  checks.push({
    id: 'server',
    label: 'csharp-ls (C# language server)',
    status: serverPath ? 'ok' : 'missing',
    detail: serverPath ? `Found at ${serverPath}` : 'Not installed. It gives exact Go to Definition and Find All References.',
    fix: serverPath
      ? undefined
      : {
          description: hasSdk
            ? 'Install it as a global .NET tool.'
            : `Install it as a global .NET tool once the .NET ${CSHARP_LS_MIN_SDK} SDK is installed.`,
          command: 'dotnet tool install --global csharp-ls',
          runIn: 'anywhere',
          runnable: hasSdk && !!dotnet,
        },
  })
  if (dotnet && hasSdk) fixes.set('server', { command: dotnet, args: ['tool', 'install', '--global', 'csharp-ls'], cwd: homedir() })

  // Solution / project
  const entry = solutions.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0] ?? projects[0]
  checks.push({
    id: 'solution',
    label: 'Solution or project file',
    status: entry ? 'ok' : 'missing',
    detail: entry
      ? solutions.length > 1
        ? `${solutions.length} solutions found; csharp-ls loads one of them (likely ${entry}).`
        : `Found ${entry}`
      : 'No .sln, .slnx or .csproj file in this repository, so there is no project to load.',
  })

  // NuGet restore: without project.assets.json, package references don't resolve.
  if (projects.length > 0) {
    const unrestored = projects.filter((p) => !existsSync(join(root, dirname(p), 'obj', 'project.assets.json')))
    checks.push({
      id: 'restore',
      label: 'NuGet packages restored',
      status: unrestored.length === 0 ? 'ok' : 'warning',
      detail:
        unrestored.length === 0
          ? `All ${projects.length} project${projects.length === 1 ? '' : 's'} restored.`
          : `${unrestored.length} of ${projects.length} project${projects.length === 1 ? '' : 's'} not restored; types from packages won't resolve.`,
      fix:
        unrestored.length === 0
          ? undefined
          : {
              description: 'Restore packages for the solution.',
              command: `dotnet restore${entry ? ` ${entry}` : ''}`,
              runIn: 'repo',
              runnable: !!dotnet && !!entry,
            },
    })
    if (dotnet && entry) fixes.set('restore', { command: dotnet, args: ['restore', entry], cwd: root })
  }

  if (legacy.length > 0) {
    checks.push({
      id: 'legacy-framework',
      label: '.NET Framework projects',
      status: 'warning',
      detail: `Some projects target ${legacy.join(', ')}. These load poorly outside Windows, so results may be incomplete.`,
    })
  }

  return { checks, fixes }
}

function detectPackageManager(root: string): { command: string; args: string[] } {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return { command: 'pnpm', args: ['install'] }
  if (existsSync(join(root, 'yarn.lock'))) return { command: 'yarn', args: ['install'] }
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return { command: 'bun', args: ['install'] }
  return { command: 'npm', args: ['install'] }
}

async function typescriptChecks(root: string, spec: ServerSpec): Promise<{ checks: ToolingCheck[]; fixes: Map<string, RunnableFix> }> {
  const checks: ToolingCheck[] = []
  const fixes = new Map<string, RunnableFix>()
  const npm = findExecutable('npm')

  const serverPath = findExecutable(spec.command, spec.extraDirs(root))
  checks.push({
    id: 'server',
    label: 'typescript-language-server',
    status: serverPath ? 'ok' : 'missing',
    detail: serverPath ? `Found at ${serverPath}` : 'Not installed. It gives exact Go to Definition and Find All References.',
    fix: serverPath
      ? undefined
      : {
          description: 'Install it globally with npm (TypeScript is installed alongside it).',
          command: spec.installHint,
          runIn: 'anywhere',
          runnable: !!npm,
        },
  })
  if (npm) fixes.set('server', { command: npm, args: ['install', '--global', 'typescript-language-server', 'typescript'], cwd: homedir() })

  const localTs = existsSync(join(root, 'node_modules', 'typescript', 'package.json'))
  const globalRoot = npm ? (await run(npm, ['root', '--global'], root))?.trim() : undefined
  const globalTs = !!globalRoot && existsSync(join(globalRoot, 'typescript', 'package.json'))
  checks.push({
    id: 'typescript',
    label: 'TypeScript',
    status: localTs || globalTs ? 'ok' : 'missing',
    detail: localTs ? "Using the repo's node_modules/typescript." : globalTs ? 'Using the global typescript package.' : 'The typescript package was not found.',
    fix:
      localTs || globalTs
        ? undefined
        : { description: 'Install TypeScript globally.', command: 'npm install --global typescript', runIn: 'anywhere', runnable: !!npm },
  })
  if (npm) fixes.set('typescript', { command: npm, args: ['install', '--global', 'typescript'], cwd: homedir() })

  if (existsSync(join(root, 'package.json'))) {
    const installed = existsSync(join(root, 'node_modules'))
    const pm = detectPackageManager(root)
    const pmPath = findExecutable(pm.command)
    checks.push({
      id: 'dependencies',
      label: 'Dependencies installed',
      status: installed ? 'ok' : 'warning',
      detail: installed ? 'node_modules is present.' : "node_modules is missing; imports from packages won't resolve.",
      fix: installed
        ? undefined
        : { description: 'Install the project dependencies.', command: `${pm.command} ${pm.args.join(' ')}`, runIn: 'repo', runnable: !!pmPath },
    })
    if (pmPath) fixes.set('dependencies', { command: pmPath, args: pm.args, cwd: root })
  }

  return { checks, fixes }
}

const LANGUAGES = [
  {
    id: 'csharp',
    label: 'C# / .NET',
    pathspecs: ['*.cs', '*.csproj', '*.sln', '*.slnx'],
    checks: csharpChecks,
  },
  {
    id: 'typescript',
    label: 'TypeScript / JavaScript',
    pathspecs: ['*.ts', '*.tsx', '*.mts', '*.cts', 'tsconfig.json', 'jsconfig.json'],
    checks: typescriptChecks,
  },
]

const specFor = (id: string) => SERVERS.find((s) => s.id === id)!

/** Languages used in the repo and what each needs for exact code navigation. */
export async function detectTooling(root: string, lsp: LspManager): Promise<LanguageTooling[]> {
  const result: LanguageTooling[] = []
  for (const language of LANGUAGES) {
    const files = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...language.pathspecs], root)
    if (!files?.trim()) continue
    const spec = specFor(language.id)
    const { checks } = await language.checks(root, spec)
    result.push({
      id: language.id,
      label: language.label,
      server: spec.name,
      ready: checks.every((c) => c.status !== 'missing'),
      checks,
      serverState: lsp.state(root, spec),
    })
  }
  return result
}

/**
 * Runs the fix for one check, if it is one diffloupe may run. The command is
 * chosen here from a fixed list; nothing from the request reaches argv.
 */
export async function runFix(root: string, languageId: string, checkId: string): Promise<{ ok: boolean; output: string }> {
  const language = LANGUAGES.find((l) => l.id === languageId)
  if (!language) return { ok: false, output: `Unknown language: ${languageId}` }
  const { checks, fixes } = await language.checks(root, specFor(language.id))
  const check = checks.find((c) => c.id === checkId)
  const fix = fixes.get(checkId)
  if (!check || !fix || !check.fix?.runnable) return { ok: false, output: 'This step has to be done by hand.' }

  return new Promise((resolve) => {
    const { command: file, shell } = spawnable(fix.command)
    const child = spawn(file, fix.args, { cwd: fix.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell, windowsHide: true })
    let output = ''
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => child.kill(), FIX_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, output: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output: output.trim() || (code === 0 ? 'Done.' : `Exited with code ${code}`) })
    })
  })
}
