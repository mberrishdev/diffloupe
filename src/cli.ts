#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import getPort from 'get-port'
import { RepoRegistry, expandPath } from './repos.js'
import { startServer } from './server.js'
import { rememberRepos } from './recent.js'
import { LspManager } from './navigation/lsp.js'
import { loadSettings } from './settings.js'
import { findRepoRoot } from './git.js'
import * as daemon from './daemon.js'
import * as service from './service.js'

const COMMANDS = ['start', 'stop', 'restart', 'status', 'serve', 'service']
/** The background server shuts down language servers that haven't been used for this long. */
const LSP_IDLE_TIMEOUT_MS = 30 * 60_000

const { values, tokens } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    'no-open': { type: 'boolean', default: false },
    foreground: { type: 'boolean', short: 'f', default: false },
    // Internal: lets `serve` fall back to a random port when the default is taken.
    'any-port': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
  allowPositionals: true,
  tokens: true,
})

const HELP = `diffloupe - Local code review tool for git diffs

Usage: diffloupe [options] [<repo path>...] [-- <git diff args>]
       diffloupe <command>

By default diffloupe runs a background server at a fixed URL
(http://127.0.0.1:${daemon.DEFAULT_PORT}), adds the current repository (or the given
paths) to it, opens the browser and returns. Run it again in another repo to
add that repo to the same session. Outside a repository it opens the picker.

Commands:
  start              Start the background server
  stop               Stop the background server
  restart            Restart the background server (e.g. after upgrading)
  status             Show whether the background server is running and its repos
  service install    Start the background server automatically when you log in
  service uninstall  Stop starting it at login
  service status     Show whether the login service is installed

Options:
  -p, --port <port>  Port for the background server (default: ${daemon.DEFAULT_PORT}).
                     With --foreground: port for this session (default: random)
  -f, --foreground   Run a separate server in this terminal until Ctrl+C,
                     like earlier versions. Implied by --host and by git diff args
  --host <host>      Host address to bind to (default: 127.0.0.1). Pass
                     0.0.0.0 to expose the server to the local network.
                     Adding/removing repos from the UI is then disabled.
  --no-open          Don't open the browser automatically
  -v, --version      Show version number
  -h, --help         Show this help message

Examples:
  diffloupe                        Review uncommitted changes
  diffloupe ../api ../web          Add two repositories to the session
  diffloupe -- --staged            Review staged changes (runs in the foreground)
  diffloupe -- HEAD~3              Review last 3 commits (runs in the foreground)
  diffloupe -- main..feature       Compare branches (runs in the foreground)
  diffloupe --host 0.0.0.0         Allow other machines on the LAN to review`

if (values.help) {
  console.log(HELP)
  process.exit(0)
}

const VERSION: string = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8'),
).version

if (values.version) {
  console.log(VERSION)
  process.exit(0)
}

// Positionals before -- are repo paths (or a command); everything after --
// becomes custom git diff args (including any further `--`).
const positionals: string[] = []
const diffArgs: string[] = []
let afterTerminator = false
for (const token of tokens) {
  if (token.kind === 'option-terminator') afterTerminator = true
  else if (token.kind === 'positional') (afterTerminator ? diffArgs : positionals).push(token.value)
}

function fail(message: string): never {
  console.error(`Error: ${message}`)
  process.exit(1)
}

function parsePort(): number | undefined {
  if (values.port === undefined) return undefined
  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`invalid port: ${values.port}`)
  return port
}

async function openBrowser(url: string) {
  const settings = loadSettings()
  const openModule = await import('open')
  let appName: string | readonly string[] | undefined
  if (settings.browser) {
    const apps = openModule.apps as Record<string, string | readonly string[]>
    appName = apps[settings.browser] || settings.browser
  }
  const options = appName ? { app: { name: appName } } : {}
  await openModule.default(url, options)
}

function resolveClientDir(): string {
  const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), 'client')
  return existsSync(clientDir) ? clientDir : resolve(process.cwd(), 'dist/client')
}

/** Adds repo paths to a registry; with none, the current directory if it is in a repo. */
function addStartupRepos(repos: RepoRegistry, paths: string[]) {
  for (const path of paths) {
    try {
      repos.add(path)
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`)
      console.error('To pass git diff arguments, put them after --, e.g. diffloupe -- HEAD~3')
      process.exit(1)
    }
  }
  if (paths.length === 0) {
    try {
      repos.add(process.cwd())
    } catch {
      // Outside a repository: start empty and let the user pick in the browser.
    }
  }
  rememberRepos(repos.list().map((r) => r.root))
}

/** A server for this terminal only, on its own port, until Ctrl+C. */
async function runForeground(paths: string[]) {
  const host = values.host ?? '127.0.0.1'
  // Adding repos from the browser would let anyone who can reach the server
  // read any repo on this machine, so it is only allowed on loopback hosts.
  const canManageRepos = ['127.0.0.1', 'localhost', '::1'].includes(host)

  const repos = new RepoRegistry()
  addStartupRepos(repos, paths)
  if (repos.list().length === 0 && !canManageRepos) fail('not inside a git repository')

  const lsp = new LspManager()
  process.on('exit', () => lsp.killAll())

  const requestedPort = parsePort()
  const port = await getPort(requestedPort ? { port: requestedPort } : undefined)
  const { port: actualPort } = await startServer({
    port,
    host,
    clientDir: resolveClientDir(),
    repos,
    customDiffArgs: diffArgs.length > 0 ? diffArgs : undefined,
    canManageRepos,
    launchDir: process.cwd(),
    lsp,
    version: VERSION,
  })

  console.log(`diffloupe server running at http://${host}:${actualPort}`)
  if (repos.list().length === 0) {
    console.log('No repository open yet. Pick one in the browser.')
  } else if (repos.list().length > 1) {
    console.log('Reviewing repositories:')
    for (const repo of repos.list()) console.log(`  ${repo.name}  ${repo.root}`)
  }

  if (!values['no-open']) {
    const openHost = host === '0.0.0.0' ? '127.0.0.1' : host
    await openBrowser(`http://${openHost}:${actualPort}`)
  }

  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    process.exit(0)
  })
}

/** `diffloupe serve`: the background server process itself, started by `start` or the login service. */
async function serve(paths: string[]) {
  const running = await daemon.findServer()
  if (running) {
    // Exit cleanly so a login service doesn't treat this as a crash and retry.
    console.log(`The background server is already running at ${daemon.serverUrl(running.port)}`)
    process.exit(0)
  }

  const repos = new RepoRegistry()
  addStartupRepos(repos, paths)

  const lsp = new LspManager(LSP_IDLE_TIMEOUT_MS)
  process.on('exit', () => {
    lsp.killAll()
    daemon.clearState(process.pid)
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => process.exit(0))

  const requestedPort = parsePort() ?? daemon.DEFAULT_PORT
  const port = values['any-port'] ? await getPort({ port: requestedPort }) : requestedPort
  let actualPort: number
  try {
    ;({ port: actualPort } = await startServer({
      port,
      host: '127.0.0.1',
      clientDir: resolveClientDir(),
      repos,
      canManageRepos: true,
      launchDir: process.cwd(),
      lsp,
      version: VERSION,
    }))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    fail(code === 'EADDRINUSE' ? `port ${port} is already in use; pick another with --port` : (err as Error).message)
  }
  daemon.writeState({ pid: process.pid, port: actualPort, version: VERSION })
  console.log(`[${new Date().toISOString()}] diffloupe ${VERSION} background server running at ${daemon.serverUrl(actualPort)}`)
}

/** The running background server, starting it if needed. */
async function ensureServer(): Promise<{ server: daemon.ServerInfo; started: boolean }> {
  const running = await daemon.findServer()
  if (running) return { server: running, started: false }
  const platform = service.servicePlatform()
  if (platform && service.isServiceInstalled()) {
    try {
      service.startService(platform)
    } catch (err) {
      fail(`couldn't start the login service: ${(err as Error).message}`)
    }
    return { server: await waitForServer(), started: true }
  }
  const requestedPort = parsePort()
  try {
    return { server: await daemon.startServer(requestedPort ?? daemon.DEFAULT_PORT, requestedPort !== undefined), started: true }
  } catch (err) {
    fail((err as Error).message)
  }
}

function warnIfOutdated(server: daemon.ServerInfo) {
  if (server.version && server.version !== VERSION) {
    console.log(`Note: the background server is running diffloupe ${server.version}; you have ${VERSION}. Run \`diffloupe restart\` to update it.`)
  }
}

/** Default command: add repos to the background server and open the browser. */
async function review(paths: string[]) {
  // Resolve paths here: the server runs in a different directory.
  const targets = paths.length > 0 ? paths.map(expandPath) : findRepoRoot(process.cwd()) ? [process.cwd()] : []
  for (const path of targets) {
    if (!findRepoRoot(path)) fail(`not inside a git repository: ${path}\nTo pass git diff arguments, put them after --, e.g. diffloupe -- HEAD~3`)
  }

  const { server, started } = await ensureServer()
  const url = daemon.serverUrl(server.port)
  if (started) console.log(`Started the diffloupe background server at ${url} (stop it with \`diffloupe stop\`)`)
  else {
    console.log(`diffloupe is running at ${url}`)
    warnIfOutdated(server)
  }
  const requestedPort = parsePort()
  if (requestedPort !== undefined && requestedPort !== server.port) {
    console.log(`Note: --port ${requestedPort} ignored; the background server is already on port ${server.port}. Use \`diffloupe restart -p ${requestedPort}\` to move it.`)
  }

  const added: daemon.RepoInfo[] = []
  for (const path of targets) {
    try {
      const repo = await daemon.addRepo(server, path)
      added.push(repo)
      console.log(`Reviewing ${repo.name}  ${repo.root}`)
    } catch (err) {
      fail((err as Error).message)
    }
  }
  if (added.length === 0) console.log('No repository given. Pick one in the browser.')

  const pageUrl = added.length > 0 ? `${url}/?repo=${encodeURIComponent(added[0].id)}` : url
  if (!values['no-open']) await openBrowser(pageUrl)
  else console.log(pageUrl)
}

async function start() {
  const running = await daemon.findServer()
  if (running) {
    console.log(`diffloupe is already running at ${daemon.serverUrl(running.port)}`)
    warnIfOutdated(running)
    return
  }
  const { server } = await ensureServer()
  console.log(`Started the diffloupe background server at ${daemon.serverUrl(server.port)}`)
}

async function stop(): Promise<daemon.ServerInfo | null> {
  const running = await daemon.findServer()
  if (!running) {
    console.log('diffloupe is not running')
    return null
  }
  await daemon.stopServer(running)
  console.log(`Stopped the diffloupe background server (port ${running.port})`)
  return running
}

async function restart() {
  const running = await daemon.findServer()
  // Reopen the same repos afterwards; the list only lives in the server's memory.
  const openRepos = running ? await daemon.listRepos(running) : []
  const stopped = await stop()
  const port = parsePort() ?? stopped?.port ?? daemon.DEFAULT_PORT
  let server: daemon.ServerInfo
  try {
    if (service.isServiceInstalled()) {
      // Reinstalling points the service at this version of diffloupe.
      service.installService(service.servicePlatform()!, port)
      server = await waitForServer()
    } else {
      server = await daemon.startServer(port, parsePort() !== undefined || stopped !== null)
    }
  } catch (err) {
    fail((err as Error).message)
  }
  console.log(`Started the diffloupe background server at ${daemon.serverUrl(server.port)}`)
  for (const repo of openRepos) {
    await daemon.addRepo(server, repo.root).catch((err: Error) => console.log(`Couldn't reopen ${repo.root}: ${err.message}`))
  }
  if (openRepos.length > 0) console.log(`Reopened ${openRepos.length} ${openRepos.length === 1 ? 'repository' : 'repositories'}`)
}

async function status() {
  const running = await daemon.findServer()
  if (!running) console.log('diffloupe is not running. Start it with `diffloupe start` or just run `diffloupe` in a repo.')
  else {
    console.log(`diffloupe ${running.version} is running at ${daemon.serverUrl(running.port)} (pid ${running.pid})`)
    warnIfOutdated(running)
    const repos = await daemon.listRepos(running)
    if (repos.length === 0) console.log('No repositories open.')
    else {
      console.log('Repositories:')
      for (const repo of repos) console.log(`  ${repo.name}  ${repo.root}`)
    }
  }
  console.log(`Login service: ${service.isServiceInstalled() ? 'installed (starts at login)' : 'not installed'}`)
  console.log(`Log: ${daemon.LOG_FILE}`)
}

async function waitForServer(): Promise<daemon.ServerInfo> {
  for (let waited = 0; waited < 10_000; waited += 200) {
    const server = await daemon.findServer()
    if (server) return server
    await new Promise((r) => setTimeout(r, 200))
  }
  fail(`the login service didn't start the server. See ${daemon.LOG_FILE}`)
}

async function serviceCommand(action: string | undefined) {
  const platform = service.servicePlatform()
  if (!platform) fail('the login service is only supported on macOS and Linux')
  const file = service.serviceFile(platform)

  if (action === 'install') {
    // A server started with `diffloupe start` would hold the port the service needs.
    const running = await daemon.findServer()
    if (running) await daemon.stopServer(running)
    const port = parsePort() ?? running?.port ?? daemon.DEFAULT_PORT
    try {
      service.installService(platform, port)
    } catch (err) {
      fail(`couldn't install the login service: ${(err as Error).message}`)
    }
    const server = await waitForServer()
    console.log(`Installed the login service (${file})`)
    console.log(`diffloupe now starts when you log in and is running at ${daemon.serverUrl(server.port)}`)
  } else if (action === 'uninstall') {
    if (!service.isServiceInstalled()) {
      console.log('The login service is not installed')
      return
    }
    service.uninstallService(platform)
    console.log(`Removed the login service (${file}). The background server has stopped.`)
  } else if (action === 'status' || action === undefined) {
    console.log(service.isServiceInstalled() ? `Login service installed: ${file}` : 'Login service not installed. Install it with `diffloupe service install`.')
  } else {
    fail(`unknown service command: ${action} (use install, uninstall or status)`)
  }
}

const [command, ...rest] = positionals
if (command !== undefined && COMMANDS.includes(command)) {
  if (diffArgs.length > 0) fail(`\`diffloupe ${command}\` doesn't take git diff arguments`)
  if (command === 'serve') await serve(rest)
  else if (command === 'service') await serviceCommand(rest[0])
  else {
    if (rest.length > 0) fail(`\`diffloupe ${command}\` doesn't take arguments`)
    if (command === 'start') await start()
    else if (command === 'stop') await stop()
    else if (command === 'restart') await restart()
    else if (command === 'status') await status()
  }
} else if (values.foreground || values.host !== undefined || diffArgs.length > 0) {
  // git diff args and --host apply to a whole session, so they get their own server.
  await runForeground(positionals)
} else {
  await review(positionals)
}
