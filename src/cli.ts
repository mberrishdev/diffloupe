#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import getPort from 'get-port'
import { RepoRegistry } from './repos.js'
import { startServer } from './server.js'
import { rememberRepos } from './recent.js'
import { loadSettings } from './settings.js'

const { values, tokens } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    'no-open': { type: 'boolean', default: false },
    help: { type: 'boolean' },
    version: { type: 'boolean', short: 'v' },
  },
  allowPositionals: true,
  tokens: true,
})

if (values.help) {
  console.log(`diffx - Local code review tool for git diffs

Usage: diffx [options] [<repo path>...] [-- <git diff args>]

With no paths, diffx reviews the current repository (or, outside any
repository, opens a picker). Pass several paths to review them in one
session. Repos can also be added and removed from the repo menu in the UI,
which suggests nearby repos, git worktrees and recently used repos.

Options:
  -p, --port <port>  Port to run the server on (default: random available port)
  --host <host>      Host address to bind to (default: 127.0.0.1). Pass
                     0.0.0.0 to expose the server to the local network.
                     Adding/removing repos from the UI is then disabled.
  --no-open          Don't open the browser automatically
  -v, --version      Show version number
  -h, --help         Show this help message

Examples:
  diffx                        Review uncommitted changes
  diffx -- --staged            Review staged changes
  diffx -- HEAD~3              Review last 3 commits
  diffx -- main..feature       Compare branches
  diffx ../api ../web          Review two repositories in one session
  diffx ../api ../web -- HEAD~1
                               Same git diff args applied to every repo
  diffx --host 0.0.0.0         Allow other machines on the LAN to review`)
  process.exit(0)
}

if (values.version) {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'))
  console.log(pkg.version)
  process.exit(0)
}

// Positionals before -- are repo paths; everything after -- becomes custom
// git diff args (including any further `--`).
const repoPaths: string[] = []
const diffArgs: string[] = []
let afterTerminator = false
for (const token of tokens) {
  if (token.kind === 'option-terminator') afterTerminator = true
  else if (token.kind === 'positional') (afterTerminator ? diffArgs : repoPaths).push(token.value)
}
const customDiffArgs = diffArgs.length > 0 ? diffArgs : undefined

const host = values.host ?? '127.0.0.1'
// Adding repos from the browser would let anyone who can reach the server
// read any repo on this machine, so it is only allowed on loopback hosts.
const canManageRepos = ['127.0.0.1', 'localhost', '::1'].includes(host)

const repos = new RepoRegistry()
try {
  for (const path of repoPaths) repos.add(path)
} catch (err) {
  console.error(`Error: ${(err as Error).message}`)
  console.error('To pass git diff arguments, put them after --, e.g. diffx -- HEAD~3')
  process.exit(1)
}
if (repoPaths.length === 0) {
  try {
    repos.add(process.cwd())
  } catch {
    // Outside a repository: start empty and let the user pick in the browser.
    if (!canManageRepos) {
      console.error('Error: not inside a git repository')
      process.exit(1)
    }
  }
}
rememberRepos(repos.list().map((r) => r.root))

const port = await getPort(values.port ? { port: parseInt(values.port, 10) } : undefined)

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientDir = resolve(__dirname, 'client')
const { existsSync } = await import('node:fs')
const resolvedClientDir = existsSync(clientDir)
  ? clientDir
  : resolve(process.cwd(), 'dist/client')

const { port: actualPort } = await startServer({
  port,
  host,
  clientDir: resolvedClientDir,
  repos,
  customDiffArgs,
  canManageRepos,
  launchDir: process.cwd(),
})

const localUrl = `http://${host}:${actualPort}`

console.log(`diffx server running at ${localUrl}`)
if (repos.list().length === 0) {
  console.log('No repository open yet. Pick one in the browser.')
} else if (repos.list().length > 1) {
  console.log('Reviewing repositories:')
  for (const repo of repos.list()) console.log(`  ${repo.name}  ${repo.root}`)
}

if (!values['no-open']) {
  const settings = loadSettings()
  const openHost = host === '0.0.0.0' ? '127.0.0.1' : host
  const openUrl = `http://${openHost}:${actualPort}`
  const openModule = await import('open')
  let appName: string | readonly string[] | undefined
  if (settings.browser) {
    const apps = openModule.apps as Record<string, string | readonly string[]>
    appName = apps[settings.browser] || settings.browser
  }
  const options = appName ? { app: { name: appName } } : {}
  openModule.default(openUrl, options)
}

process.on('SIGINT', () => {
  console.log('\nShutting down...')
  process.exit(0)
})
