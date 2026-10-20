import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const CONFIG_DIR = join(homedir(), '.config', 'diffloupe')
const LEGACY_CONFIG_DIR = join(homedir(), '.config', 'diffx')

// Carry over settings and recent repos saved before the rename from diffx.
if (!existsSync(CONFIG_DIR) && existsSync(LEGACY_CONFIG_DIR)) {
  try {
    cpSync(LEGACY_CONFIG_DIR, CONFIG_DIR, { recursive: true })
  } catch {}
}
const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json')

export interface Settings {
  staged: boolean
  untracked: boolean
  diffStyle: 'split' | 'unified'
  defaultTabSize: number
  browser?: string
}

const DEFAULTS: Settings = {
  staged: true,
  untracked: true,
  diffStyle: 'split',
  defaultTabSize: 4,
}

export function loadSettings(): Settings {
  try {
    const data = readFileSync(SETTINGS_FILE, 'utf-8')
    return { ...DEFAULTS, ...JSON.parse(data) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(settings: Partial<Settings>): Settings {
  const current = loadSettings()
  const merged = { ...current, ...settings }
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2))
  return merged
}
