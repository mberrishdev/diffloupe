import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { LOG_FILE } from './daemon.js'

/**
 * Runs the background server as a login service, so it starts when you log in
 * and restarts if it crashes: a LaunchAgent on macOS, a systemd user unit on Linux.
 */

const LABEL = 'com.github.mberrishdev.diffloupe'
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const UNIT_NAME = 'diffloupe.service'
const UNIT = join(homedir(), '.config', 'systemd', 'user', UNIT_NAME)

export type Platform = 'launchd' | 'systemd'

export function servicePlatform(): Platform | null {
  if (process.platform === 'darwin') return 'launchd'
  if (process.platform === 'linux') return 'systemd'
  return null
}

export function serviceFile(platform: Platform): string {
  return platform === 'launchd' ? PLIST : UNIT
}

export function isServiceInstalled(): boolean {
  const platform = servicePlatform()
  return platform !== null && existsSync(serviceFile(platform))
}

/** The command the service runs: this node binary and CLI, as `diffloupe serve`. */
function serveCommand(port: number): string[] {
  return [process.execPath, ...process.execArgv, process.argv[1], 'serve', '--port', String(port)]
}

/**
 * PATH for the service, so it finds git and language servers like your shell
 * does. Drops the project-local bin folders npm/npx/pnpm add when running scripts.
 */
function servicePath(): string {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((d) => d && !/node_modules[\\/]/.test(d))
  return [...new Set(dirs)].join(delimiter) || '/usr/bin:/bin'
}

const run = (command: string, args: string[]) => execFileSync(command, args, { stdio: 'pipe', windowsHide: true })
const runQuietly = (command: string, args: string[]) => {
  try {
    run(command, args)
  } catch {
    // e.g. unloading a service that isn't loaded
  }
}

/** Writes the service definition and starts it. Replaces an existing one. */
export function installService(platform: Platform, port: number): void {
  const file = serviceFile(platform)
  mkdirSync(dirname(file), { recursive: true })
  if (platform === 'launchd') {
    const domain = `gui/${userInfo().uid}`
    runQuietly('launchctl', ['bootout', `${domain}/${LABEL}`])
    writeFileSync(file, launchAgentPlist(serveCommand(port)))
    run('launchctl', ['bootstrap', domain, file])
  } else {
    writeFileSync(file, systemdUnit(serveCommand(port)))
    run('systemctl', ['--user', 'daemon-reload'])
    run('systemctl', ['--user', 'enable', UNIT_NAME])
    run('systemctl', ['--user', 'restart', UNIT_NAME])
  }
}

/** Starts an installed service that was stopped, e.g. by `diffloupe stop`. */
export function startService(platform: Platform): void {
  if (platform === 'launchd') run('launchctl', ['kickstart', `gui/${userInfo().uid}/${LABEL}`])
  else run('systemctl', ['--user', 'start', UNIT_NAME])
}

/** Stops the service and removes its definition. */
export function uninstallService(platform: Platform): void {
  if (platform === 'launchd') {
    runQuietly('launchctl', ['bootout', `gui/${userInfo().uid}/${LABEL}`])
    rmSync(PLIST, { force: true })
  } else {
    runQuietly('systemctl', ['--user', 'disable', '--now', UNIT_NAME])
    rmSync(UNIT, { force: true })
    runQuietly('systemctl', ['--user', 'daemon-reload'])
  }
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function launchAgentPlist(command: string[]): string {
  const strings = (values: string[]) => values.map((v) => `    <string>${escapeXml(v)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings(command)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(servicePath())}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${escapeXml(homedir())}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <!-- Restart after a crash, but not after \`diffloupe stop\`. -->
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(LOG_FILE)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(LOG_FILE)}</string>
</dict>
</plist>
`
}

function systemdUnit(command: string[]): string {
  const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return `[Unit]
Description=diffloupe background server

[Service]
ExecStart=${command.map(quote).join(' ')}
WorkingDirectory=%h
Environment=${quote(`PATH=${servicePath()}`)}
# Restart after a crash, but not after \`diffloupe stop\`.
Restart=on-failure
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=default.target
`
}
