import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getWorktreeFileContent } from '../git.js'
import { LspClient } from './lspClient.js'
import { clipLine } from './types.js'
import type { LspNavResponse, NavLocation } from './types.js'

export interface ServerSpec {
  /** Stable id used by the API ('csharp', 'typescript'). */
  id: string
  name: string
  command: string
  args: string[]
  /** File extension → LSP languageId. */
  languages: Record<string, string>
  installHint: string
  /** Directories searched before PATH (tools often install outside it). */
  extraDirs(root: string): string[]
}

export const SERVERS: ServerSpec[] = [
  {
    id: 'csharp',
    name: 'csharp-ls',
    command: 'csharp-ls',
    args: [],
    languages: { '.cs': 'csharp' },
    installHint: 'dotnet tool install --global csharp-ls',
    extraDirs: () => [join(homedir(), '.dotnet', 'tools')],
  },
  {
    id: 'typescript',
    name: 'typescript-language-server',
    command: 'typescript-language-server',
    args: ['--stdio'],
    languages: {
      '.ts': 'typescript',
      '.mts': 'typescript',
      '.cts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.jsx': 'javascriptreact',
    },
    installHint: 'npm install --global typescript-language-server typescript',
    extraDirs: (root) => [join(root, 'node_modules', '.bin')],
  },
]

// Language servers answer slowly while they load the project (a large .NET
// solution can take a minute); past this, the caller keeps the text results.
const REQUEST_TIMEOUT_MS = 60_000
// After opening a file, how long to give the server to start reporting progress.
const SETTLE_MS = 400

export function findExecutable(command: string, extraDirs: string[] = []): string | null {
  const dirs = [...extraDirs, ...(process.env.PATH ?? '').split(delimiter)].filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, command)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // not here
    }
  }
  return null
}

interface LspPosition {
  line: number
  character: number
}
interface LspLocation {
  uri: string
  range: { start: LspPosition }
}
interface LspLocationLink {
  targetUri: string
  targetSelectionRange: { start: LspPosition }
}
type LspLocationResponse = LspLocation | LspLocation[] | LspLocationLink[] | null

function toArray(response: LspLocationResponse): (LspLocation | LspLocationLink)[] {
  if (!response) return []
  return Array.isArray(response) ? response : [response]
}

export type ServerState =
  | { status: 'stopped' }
  | { status: 'starting' }
  /** Running, but still loading the project (reported via LSP progress). */
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string }

/** Starts language servers on demand, one per repo and language, and keeps them warm. */
export class LspManager {
  private clients = new Map<string, Promise<LspClient>>()
  private live = new Map<string, LspClient>()
  private startErrors = new Map<string, string>()

  /** Lifecycle of a repo's server, for the setup UI. */
  state(root: string, spec: ServerSpec): ServerState {
    const key = `${root}\0${spec.name}`
    const client = this.live.get(key)
    if (!client) {
      const error = this.startErrors.get(key)
      return error ? { status: 'error', message: error } : { status: 'stopped' }
    }
    if (client.exited) return { status: 'error', message: client.exitReason ?? 'language server stopped' }
    if (!client.initialized) return { status: 'starting' }
    return client.busy ? { status: 'loading' } : { status: 'ready' }
  }

  /** Starts the server ahead of the first lookup, so large projects are loaded by then. */
  async warm(root: string, spec: ServerSpec): Promise<void> {
    const executable = findExecutable(spec.command, spec.extraDirs(root))
    if (!executable) throw new Error(`${spec.name} is not installed`)
    await this.getClient(root, spec, executable)
  }

  async navigate(root: string, path: string, line: number, column: number, symbol: string): Promise<LspNavResponse> {
    const ext = extname(path).toLowerCase()
    const spec = SERVERS.find((s) => ext in s.languages)
    if (!spec) return { status: 'unsupported' }
    const executable = findExecutable(spec.command, spec.extraDirs(root))
    if (!executable) return { status: 'unavailable', server: spec.name, installHint: spec.installHint }

    // The position comes from the diff; make sure it still points at the
    // symbol in the file on disk before asking the server about it.
    const text = getWorktreeFileContent(root, path)
    const lineText = text?.split('\n')[line - 1]
    if (text == null || lineText == null) return { status: 'stale', server: spec.name }
    let character = column
    if (lineText.slice(column, column + symbol.length) !== symbol) {
      character = lineText.search(new RegExp(`(?<![\\w$])${symbol.replace(/\$/g, '\\$')}(?![\\w$])`))
      if (character === -1) return { status: 'stale', server: spec.name }
    }

    try {
      const client = await this.getClient(root, spec, executable)
      const uri = pathToFileURL(resolve(root, path)).href
      if (client.syncDocument(uri, spec.languages[ext], text)) {
        await client.waitUntilIdle(SETTLE_MS, REQUEST_TIMEOUT_MS)
      }
      const params = { textDocument: { uri }, position: { line: line - 1, character } }
      const [definitions, implementations, references] = await Promise.all([
        client.request<LspLocationResponse>('textDocument/definition', params, REQUEST_TIMEOUT_MS),
        client
          .request<LspLocationResponse>('textDocument/implementation', params, REQUEST_TIMEOUT_MS)
          .catch(() => null),
        client.request<LspLocationResponse>(
          'textDocument/references',
          { ...params, context: { includeDeclaration: false } },
          REQUEST_TIMEOUT_MS,
        ),
      ])
      // An exact server always resolves something for a real symbol; nothing
      // at all means it is still loading the project.
      if (toArray(definitions).length === 0 && toArray(references).length === 0) {
        return { status: 'loading', server: spec.name }
      }
      const reader = new LineReader(root)
      const definitionLocations = reader.locations(definitions)
      const isDefinition = (l: NavLocation) => definitionLocations.some((d) => d.path === l.path && d.line === l.line)
      return {
        status: 'ok',
        server: spec.name,
        symbol,
        definitions: definitionLocations,
        // For a concrete member, "implementation" is just its own definition.
        implementations: reader.locations(implementations).filter((l) => !isDefinition(l)),
        references: reader.locations(references),
        truncated: false,
      }
    } catch (err) {
      const message = (err as Error).message
      if (/timed out/.test(message)) return { status: 'loading', server: spec.name }
      return { status: 'error', server: spec.name, message }
    }
  }

  disposeRoot(root: string) {
    for (const [key, client] of this.clients) {
      if (key.startsWith(`${root}\0`)) {
        this.clients.delete(key)
        this.live.delete(key)
        client.then((c) => c.dispose()).catch(() => {})
      }
    }
  }

  /** Kills every server synchronously; safe to call from a process 'exit' handler. */
  killAll() {
    for (const client of this.live.values()) client.kill()
    this.live.clear()
    this.clients.clear()
  }

  private getClient(root: string, spec: ServerSpec, executable: string): Promise<LspClient> {
    const key = `${root}\0${spec.name}`
    const existing = this.clients.get(key)
    if (existing) {
      return existing.then((client) => {
        if (!client.exited) return client
        this.clients.delete(key)
        return this.getClient(root, spec, executable)
      })
    }
    const starting = (async () => {
      const client = new LspClient(executable, spec.args, root)
      this.live.set(key, client)
      this.startErrors.delete(key)
      await client.initialize()
      return client
    })()
    starting.catch((err: Error) => {
      this.clients.delete(key)
      this.live.get(key)?.kill()
      this.live.delete(key)
      this.startErrors.set(key, err.message)
    })
    this.clients.set(key, starting)
    return starting
  }
}

/** Converts LSP locations to repo-relative locations with their line text. */
class LineReader {
  private files = new Map<string, string[] | null>()

  constructor(private root: string) {}

  locations(response: LspLocationResponse): NavLocation[] {
    const seen = new Set<string>()
    const result: NavLocation[] = []
    for (const item of toArray(response)) {
      const uri = 'targetUri' in item ? item.targetUri : item.uri
      const start = 'targetUri' in item ? item.targetSelectionRange.start : item.range.start
      const path = this.relativePath(uri)
      if (!path) continue
      const key = `${path}:${start.line}:${start.character}`
      if (seen.has(key)) continue
      seen.add(key)
      const lines = this.read(path)
      result.push({ path, line: start.line + 1, column: start.character, text: clipLine(lines?.[start.line] ?? '') })
    }
    return result.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  }

  // Locations outside the repo (framework metadata, node_modules typings
  // outside the work tree, decompiled sources) are dropped.
  private relativePath(uri: string): string | null {
    if (!uri.startsWith('file:')) return null
    let absolute = fileURLToPath(uri)
    let rel = relative(this.root, absolute)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      try {
        absolute = realpathSync(absolute)
        rel = relative(this.root, absolute)
      } catch {
        return null
      }
      if (rel.startsWith('..') || isAbsolute(rel)) return null
    }
    return rel.split('\\').join('/')
  }

  private read(path: string): string[] | null {
    if (!this.files.has(path)) {
      try {
        this.files.set(path, readFileSync(join(this.root, path), 'utf-8').split('\n'))
      } catch {
        this.files.set(path, null)
      }
    }
    return this.files.get(path)!
  }
}
