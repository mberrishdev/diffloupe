import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from './settings.js'

/**
 * The background server: one long-running diffloupe server on a fixed port
 * that `diffloupe` adds repos to, so the review URL stays the same.
 */

export const DEFAULT_PORT = 4747
export const STATE_FILE = join(CONFIG_DIR, 'server.json')
export const LOG_FILE = join(CONFIG_DIR, 'server.log')
const HOST = '127.0.0.1'

export interface ServerInfo {
  pid: number
  port: number
  version: string
}

export const serverUrl = (port: number) => `http://${HOST}:${port}`

/** Called by the background server once it is listening. */
export function writeState(info: ServerInfo): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(info, null, 2))
}

/** Called on exit; only removes the file if it still describes this process. */
export function clearState(pid: number): void {
  if (readState()?.pid === pid) rmSync(STATE_FILE, { force: true })
}

function readState(): ServerInfo | null {
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
    return typeof data.pid === 'number' && typeof data.port === 'number' ? data : null
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function health(port: number): Promise<{ pid: number; version: string } | null> {
  try {
    const res = await fetch(`${serverUrl(port)}/api/health`, { signal: AbortSignal.timeout(1000) })
    const data = (await res.json()) as { app?: string; pid?: number; version?: string }
    return data.app === 'diffloupe' && typeof data.pid === 'number' ? { pid: data.pid, version: data.version ?? '' } : null
  } catch {
    return null
  }
}

/** The running background server, or null. Cleans up a state file left by a crashed server. */
export async function findServer(): Promise<ServerInfo | null> {
  const state = readState()
  if (!state) return null
  if (isAlive(state.pid)) {
    const live = await health(state.port)
    if (live?.pid === state.pid) return { ...state, version: live.version }
  }
  rmSync(STATE_FILE, { force: true })
  return null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Re-runs this CLI as `diffloupe serve`, detached, with output going to the log file. */
export async function startServer(port: number, strictPort: boolean): Promise<ServerInfo> {
  mkdirSync(CONFIG_DIR, { recursive: true })
  const log = openSync(LOG_FILE, 'a')
  const args = [...process.execArgv, process.argv[1], 'serve', '--port', String(port)]
  if (!strictPort) args.push('--any-port')
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], cwd: process.cwd() })
  closeSync(log)
  let exitCode: number | null = null
  child.on('exit', (code) => (exitCode = code ?? 1))
  child.unref()

  for (let waited = 0; waited < 10_000; waited += 100) {
    await sleep(100)
    const server = await findServer()
    if (server && server.pid === child.pid) return server
    if (exitCode !== null) break
  }
  throw new Error(`the background server didn't start. See ${LOG_FILE}:\n${tail(LOG_FILE, 5)}`)
}

/** Stops the background server, waiting up to 5s before force-killing it. */
export async function stopServer(server: ServerInfo): Promise<void> {
  process.kill(server.pid, 'SIGTERM')
  for (let waited = 0; waited < 5000; waited += 100) {
    await sleep(100)
    if (!isAlive(server.pid)) return
  }
  process.kill(server.pid, 'SIGKILL')
  clearState(server.pid)
}

export interface RepoInfo {
  id: string
  name: string
  root: string
  branch: string
}

export async function listRepos(server: ServerInfo): Promise<RepoInfo[]> {
  const res = await fetch(`${serverUrl(server.port)}/api/repos`)
  return ((await res.json()) as { repos: RepoInfo[] }).repos
}

/** Adds a repo to the background server. `path` must be absolute: the server runs in another directory. */
export async function addRepo(server: ServerInfo, path: string): Promise<RepoInfo> {
  const res = await fetch(`${serverUrl(server.port)}/api/repos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  const data = (await res.json()) as RepoInfo & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

function tail(file: string, lines: number): string {
  try {
    return readFileSync(file, 'utf-8').trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return '(no log output)'
  }
}
