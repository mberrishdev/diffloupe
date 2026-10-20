import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from './settings.js'

const RECENT_FILE = join(CONFIG_DIR, 'recent-repos.json')
const MAX_RECENT = 20

/** Repo roots reviewed in earlier sessions, most recent first. Missing directories are skipped. */
export function loadRecentRepos(): string[] {
  try {
    const data = JSON.parse(readFileSync(RECENT_FILE, 'utf-8'))
    return Array.isArray(data) ? data.filter((p): p is string => typeof p === 'string' && existsSync(p)) : []
  } catch {
    return []
  }
}

export function rememberRepos(roots: string[]): void {
  if (roots.length === 0) return
  const merged = [...new Set([...roots, ...loadRecentRepos()])].slice(0, MAX_RECENT)
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(RECENT_FILE, JSON.stringify(merged, null, 2))
  } catch {
    // Recents are a convenience; never fail a request over them.
  }
}
