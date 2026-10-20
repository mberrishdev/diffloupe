import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface JsonRpcMessage {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { message: string }
}

/**
 * A minimal Language Server Protocol client over stdio: enough to ask for
 * definitions, implementations and references in one workspace.
 */
export class LspClient {
  private proc: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private buffer = Buffer.alloc(0)
  private openDocuments = new Map<string, { version: number; text: string }>()
  private stderrTail = ''
  /** Work-done progress tokens that have begun but not ended (e.g. project loading). */
  private activeProgress = new Set<string | number>()
  private idleWaiters: (() => void)[] = []
  exited = false
  /** Why the process exited, when it did so on its own. */
  exitReason: string | null = null
  initialized = false

  constructor(command: string, args: string[], private root: string) {
    this.proc = spawn(command, args, { cwd: root, stdio: 'pipe', windowsHide: true })
    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000)
    })
    const onExit = (reason: string) => {
      if (this.exited) return
      this.exited = true
      this.exitReason = `${basename(command)} ${reason}${this.stderrTail ? `: ${this.stderrTail.trim().split('\n').pop()}` : ''}`
      for (const request of this.pending.values()) {
        clearTimeout(request.timer)
        request.reject(new Error(this.exitReason))
      }
      this.pending.clear()
    }
    this.proc.on('error', (err) => onExit(`failed to start (${err.message})`))
    this.proc.on('exit', (code) => onExit(`exited with code ${code}`))
  }

  async initialize(): Promise<void> {
    const rootUri = pathToFileURL(this.root).href
    await this.request(
      'initialize',
      {
        processId: process.pid,
        rootUri,
        rootPath: this.root,
        workspaceFolders: [{ uri: rootUri, name: basename(this.root) }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: false },
            definition: { linkSupport: true },
            implementation: { linkSupport: true },
            references: {},
          },
          workspace: { workspaceFolders: true, configuration: true },
          window: { workDoneProgress: true },
        },
      },
      120_000,
    )
    this.notify('initialized', {})
    this.initialized = true
  }

  /** True while the server reports work in progress, such as loading the project. */
  get busy(): boolean {
    return this.activeProgress.size > 0
  }

  /**
   * Opens the document, or sends its latest text if it is already open.
   * Returns true when the document was newly opened.
   */
  syncDocument(uri: string, languageId: string, text: string): boolean {
    const open = this.openDocuments.get(uri)
    if (!open) {
      this.openDocuments.set(uri, { version: 1, text })
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } })
      return true
    }
    if (open.text !== text) {
      open.version++
      open.text = text
      this.notify('textDocument/didChange', {
        textDocument: { uri, version: open.version },
        contentChanges: [{ text }],
      })
    }
    return false
  }

  /**
   * Resolves once the server reports no work in progress. Servers answer
   * requests while still loading the project, with incomplete results (e.g.
   * missing references), so callers wait here after opening a document.
   * `settleMs` gives the server a moment to start reporting progress.
   */
  async waitUntilIdle(settleMs: number, timeoutMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, settleMs))
    if (this.activeProgress.size === 0 || this.exited) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeoutMs)
      function done() {
        clearTimeout(timer)
        resolve()
      }
      this.idleWaiters.push(done)
    })
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.exited) return Promise.reject(new Error('language server is not running'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.send({ id, method, params })
    })
  }

  notify(method: string, params: unknown) {
    if (!this.exited) this.send({ method, params })
  }

  async dispose() {
    if (this.exited) return
    try {
      await this.request('shutdown', null, 2000)
      this.notify('exit', null)
    } catch {
      // fall through to kill
    }
    setTimeout(() => this.proc.kill(), 500).unref()
  }

  /** Synchronous last resort for process exit, where async shutdown can't run. */
  kill() {
    if (!this.exited) this.proc.kill()
  }

  private send(message: object) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf-8')
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    this.proc.stdin.write(body)
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1])
      if (!Number.isFinite(length)) {
        // Unparseable header: drop it and resynchronise on the next one.
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const start = headerEnd + 4
      if (this.buffer.length < start + length) return
      const body = this.buffer.subarray(start, start + length).toString('utf-8')
      this.buffer = this.buffer.subarray(start + length)
      try {
        this.onMessage(JSON.parse(body))
      } catch {
        // ignore malformed messages
      }
    }
  }

  private onMessage(message: JsonRpcMessage) {
    if (message.method && message.id !== undefined) {
      // Requests from the server must be answered or some servers stall.
      // We advertise no client features, so null/empty answers are correct.
      const result =
        message.method === 'workspace/configuration'
          ? ((message.params as { items?: unknown[] })?.items ?? []).map(() => null)
          : message.method === 'workspace/workspaceFolders'
            ? [{ uri: pathToFileURL(this.root).href, name: basename(this.root) }]
            : null
      this.send({ id: message.id, result })
      return
    }
    if (message.method === '$/progress') {
      const { token, value } = message.params as { token: string | number; value?: { kind?: string } }
      if (value?.kind === 'begin') this.activeProgress.add(token)
      else if (value?.kind === 'end') this.activeProgress.delete(token)
      if (this.activeProgress.size === 0) this.idleWaiters.splice(0).forEach((done) => done())
      return
    }
    if (typeof message.id !== 'number') return
    const request = this.pending.get(message.id)
    if (!request) return
    this.pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  }
}
