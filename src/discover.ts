import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdirSync, existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Repo } from './repos.js'

const execFileAsync = promisify(execFile)

export interface RepoSuggestion {
  root: string
  name: string
  /** Why it was suggested: a worktree of an open repo, used before, or next to an open repo. */
  source: 'worktree' | 'recent' | 'nearby'
  /** Whether the work tree has uncommitted changes. */
  changed: boolean
}

const SOURCE_ORDER: RepoSuggestion['source'][] = ['worktree', 'recent', 'nearby']
const MAX_DIR_ENTRIES = 300
const STATUS_TIMEOUT_MS = 3000
const STATUS_CONCURRENCY = 8

async function listWorktrees(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: root })
    return stdout
      .split('\n\n')
      .filter((block) => !/^bare$/m.test(block))
      .map((block) => block.match(/^worktree (.+)$/m)?.[1])
      .filter((path): path is string => !!path)
  } catch {
    return []
  }
}

/** Direct child directories of `dir` that are git work tree roots. */
function listChildRepos(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .slice(0, MAX_DIR_ENTRIES)
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => join(dir, entry.name))
      .filter((path) => existsSync(join(path, '.git')))
  } catch {
    return []
  }
}

async function hasChanges(root: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: root,
      timeout: STATUS_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    })
    return stdout.trim() !== ''
  } catch {
    return false
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

function realpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Repos the user is likely to want next: worktrees of the open repos, repos
 * from earlier sessions, and sibling repos of the open ones (or, with none
 * open, repos directly inside the directory diffloupe was launched from).
 * Already-open repos are excluded. Repos with changes sort first.
 */
export async function suggestRepos(open: Repo[], launchDir: string, recent: string[]): Promise<RepoSuggestion[]> {
  const sources = new Map<string, RepoSuggestion['source']>()
  const offer = (path: string, source: RepoSuggestion['source']) => {
    const root = realpath(path)
    const current = sources.get(root)
    if (!current || SOURCE_ORDER.indexOf(source) < SOURCE_ORDER.indexOf(current)) sources.set(root, source)
  }

  const worktrees = await Promise.all(open.map((r) => listWorktrees(r.root)))
  worktrees.flat().forEach((path) => offer(path, 'worktree'))
  recent.forEach((path) => offer(path, 'recent'))
  const nearbyDirs = new Set([realpath(launchDir), ...open.map((r) => dirname(r.root))])
  for (const dir of nearbyDirs) listChildRepos(dir).forEach((path) => offer(path, 'nearby'))

  for (const repo of open) sources.delete(repo.root)

  const entries = [...sources]
  const changed = await mapWithConcurrency(entries, STATUS_CONCURRENCY, ([root]) => hasChanges(root))
  return entries
    .map(([root, source], i) => ({ root, name: basename(root), source, changed: changed[i] }))
    .sort((a, b) =>
      Number(b.changed) - Number(a.changed) ||
      SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) ||
      a.name.localeCompare(b.name),
    )
}
