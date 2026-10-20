import { basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { findRepoRoot } from './git.js'

export interface Repo {
  /** URL-facing identifier, unique within one diffloupe session. */
  id: string
  name: string
  /** Absolute path of the work tree root. */
  root: string
  /** Directory the user pointed diffloupe at; custom diff args run here. */
  cwd: string
}

/** Expands a leading `~` and resolves relative paths against the process cwd. */
export function expandPath(path: string): string {
  if (path === '~' || path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

/** The repos in the current session. Repos can be added and removed while the server runs. */
export class RepoRegistry {
  private repos: Repo[] = []

  list(): Repo[] {
    return this.repos
  }

  get(id: string): Repo | undefined {
    return this.repos.find((r) => r.id === id)
  }

  first(): Repo | undefined {
    return this.repos[0]
  }

  /**
   * Adds the git work tree containing `dir`. A directory inside an already
   * added work tree returns that repo. Throws if `dir` is not inside a work tree.
   */
  add(dir: string): Repo {
    const cwd = expandPath(dir)
    const root = findRepoRoot(cwd)
    if (!root) {
      throw new Error(`not inside a git repository: ${dir}`)
    }
    const existing = this.repos.find((r) => r.root === root)
    if (existing) return existing

    const name = basename(root)
    let id = name
    for (let n = 2; this.get(id); n++) id = `${name}-${n}`
    const repo = { id, name, root, cwd }
    this.repos.push(repo)
    return repo
  }

  remove(id: string): boolean {
    const index = this.repos.findIndex((r) => r.id === id)
    if (index === -1) return false
    this.repos.splice(index, 1)
    return true
  }
}
