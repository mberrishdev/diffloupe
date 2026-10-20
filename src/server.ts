import { readFile } from 'node:fs/promises'
import { join, extname, resolve } from 'node:path'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { serve } from '@hono/node-server'
import { getGitDiff, getCustomGitDiff, getBranchName, getFileContent, getBlobContent, getWorktreeFileContent, getTabSizeForFiles, getUntrackedFilePaths } from './git.js'
import type { Repo, RepoRegistry } from './repos.js'
import { suggestRepos } from './discover.js'
import { loadRecentRepos, rememberRepos } from './recent.js'
import { textSearch } from './navigation/textSearch.js'
import { LspManager, SERVERS } from './navigation/lsp.js'
import { detectTooling, runFix } from './navigation/tooling.js'
import { SYMBOL_PATTERN } from './navigation/types.js'
import { loadSettings, saveSettings } from './settings.js'
import { InMemoryCommentStore } from './comments.js'
import type { CommentStore } from './comments.js'
import { isSafePath } from './path.js'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

export interface BinaryFileInfo {
  path: string
  type: 'added' | 'deleted' | 'changed' | 'untracked'
}

function parseFilePaths(patch: string): string[] {
  const paths = new Set<string>()
  for (const line of patch.split('\n')) {
    const match = line.match(/^diff --git a\/.+ b\/(.+)$/)
    if (match) paths.add(match[1])
  }
  return [...paths]
}

function parseBinaryFiles(patch: string, untrackedFiles?: Set<string>): BinaryFileInfo[] {
  const binaryFiles: BinaryFileInfo[] = []
  const lines = patch.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('Binary files ') || !line.includes(' differ')) continue

    // Find the file path from the preceding diff --git line
    let filePath = ''
    for (let j = i - 1; j >= 0; j--) {
      const match = lines[j].match(/^diff --git a\/.+ b\/(.+)$/)
      if (match) {
        filePath = match[1]
        break
      }
    }
    if (!filePath) continue

    // Determine change type from surrounding lines
    let changeType: BinaryFileInfo['type'] = 'changed'
    for (let j = i - 1; j >= 0; j--) {
      if (lines[j].startsWith('diff --git')) break
      if (lines[j].startsWith('new file mode')) {
        changeType = 'added'
        break
      }
      if (lines[j].startsWith('deleted file mode')) {
        changeType = 'deleted'
        break
      }
    }

    if (changeType === 'added' && untrackedFiles?.has(filePath)) {
      changeType = 'untracked'
    }
    binaryFiles.push({ path: filePath, type: changeType })
  }
  return binaryFiles
}

function diffContainsFileVersion(patch: string, path: string, oldOid: string, newOid: string): boolean {
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    // Match the new-file path from the `+++ b/<path>` header (as the client
    // does); the `diff --git` line is ambiguous for paths containing ` b/`.
    const nameMatch = chunk.match(/^\+\+\+ [ab]\/([^\t\r\n]+)/m)
    if (!nameMatch || nameMatch[1].trim() !== path) continue
    const indexMatch = chunk.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/m)
    if (indexMatch && indexMatch[1] === oldOid && indexMatch[2] === newOid) return true
  }
  return false
}

export interface AppOptions {
  clientDir: string
  repos: RepoRegistry
  customDiffArgs?: string[]
  commentStore?: CommentStore
  /**
   * Allow adding/removing repos over the API. Off when the server is exposed
   * beyond localhost, so remote clients can't open arbitrary repos on this machine.
   */
  canManageRepos: boolean
  /** Directory diffx was launched from; its child repos are offered as suggestions. */
  launchDir: string
  /** Language servers for exact code navigation; text search is used without them. */
  lsp?: LspManager
}

const MAX_SOURCE_BYTES = 2 * 1024 * 1024

export function createApp({ clientDir, repos, customDiffArgs, commentStore, canManageRepos, launchDir, lsp }: AppOptions) {
  const app = new Hono()
  const isCustomMode = !!customDiffArgs
  const store = commentStore ?? new InMemoryCommentStore()
  const viewedByRepo = new Map<string, Map<string, string>>()
  const viewedFor = (repo: Repo) => {
    let viewed = viewedByRepo.get(repo.id)
    if (!viewed) viewedByRepo.set(repo.id, (viewed = new Map()))
    return viewed
  }

  // Repo-scoped endpoints take `?repo=<id>`. Without it they fall back to the
  // first repo, so single-repo clients and agent scripts keep working unchanged.
  const getRepo = (c: Context): Repo | undefined => {
    const id = c.req.query('repo')
    return id === undefined ? repos.first() : repos.get(id)
  }
  const unknownRepo = (c: Context) => c.json({ error: `Unknown repo: ${c.req.query('repo') ?? '(none open)'}` }, 404)

  const diffFor = (repo: Repo, options: { staged: boolean; untracked: boolean }) =>
    isCustomMode ? getCustomGitDiff(repo.cwd, customDiffArgs) : getGitDiff(repo.root, options)

  const repoInfo = (r: Repo) => ({ id: r.id, name: r.name, root: r.root, branch: getBranchName(r.root) })

  app.get('/api/repos', (c) => {
    return c.json({ repos: repos.list().map(repoInfo), canManage: canManageRepos })
  })

  app.get('/api/repo-suggestions', async (c) => {
    if (!canManageRepos) return c.json({ error: 'Repo management is disabled' }, 403)
    return c.json(await suggestRepos(repos.list(), launchDir, loadRecentRepos()))
  })

  app.post('/api/repos', async (c) => {
    if (!canManageRepos) return c.json({ error: 'Repo management is disabled' }, 403)
    // Requiring a JSON content type forces a CORS preflight, so other web
    // pages open in the browser can't add repos with a "simple" request.
    if (!c.req.header('Content-Type')?.startsWith('application/json')) {
      return c.json({ error: 'Content-Type must be application/json' }, 415)
    }
    const { path } = await c.req.json<{ path?: unknown }>()
    if (typeof path !== 'string' || path.trim() === '') {
      return c.json({ error: 'Missing path' }, 400)
    }
    let repo: Repo
    try {
      repo = repos.add(path.trim())
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
    rememberRepos([repo.root])
    return c.json(repoInfo(repo), 201)
  })

  // Removing a repo drops its comments and viewed state too: ids are reused by
  // name, so anything left behind would attach to the next repo with that name.
  app.delete('/api/repos/:id', async (c) => {
    if (!canManageRepos) return c.json({ error: 'Repo management is disabled' }, 403)
    const id = c.req.param('id')
    const removed = repos.get(id)
    if (!removed || !repos.remove(id)) return c.json({ error: `Unknown repo: ${id}` }, 404)
    lsp?.disposeRoot(removed.root)
    viewedByRepo.delete(id)
    for (const comment of [...(await store.getAll())]) {
      if (comment.repoId === id) await store.remove(comment.id)
    }
    return c.json({ ok: true })
  })

  app.get('/api/diff', (c) => {
    const repo = getRepo(c)
    if (!repo) return unknownRepo(c)
    const staged = c.req.query('staged') === 'true'
    const untracked = c.req.query('untracked') === 'true'
    let patch: string
    try {
      patch = diffFor(repo, { staged, untracked })
    } catch (err) {
      // Custom diff args can be valid in one repo and not another (e.g. a
      // branch that only exists in some of them); report it for this repo only.
      const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim()
      return c.json({ error: stderr || (err as Error).message }, 500)
    }
    const branch = getBranchName(repo.root)
    const untrackedFiles = untracked ? getUntrackedFilePaths(repo.root) : []
    const untrackedSet = new Set(untrackedFiles)
    const binaryFiles = parseBinaryFiles(patch, untrackedSet)
    const filePaths = parseFilePaths(patch)
    const tabSizeMap = getTabSizeForFiles(repo.root, filePaths)
    return c.json({ patch, repoName: repo.name, branch, customMode: isCustomMode, binaryFiles, tabSizeMap, untrackedFiles })
  })

  app.get('/api/file-content', (c) => {
    const repo = getRepo(c)
    if (!repo) return unknownRepo(c)
    const path = c.req.query('path')
    const version = c.req.query('version') as 'old' | 'new'
    if (!path || !version) {
      return c.json({ error: 'Missing path or version' }, 400)
    }
    const content = getFileContent(repo.root, path, version)
    if (!content) {
      return c.json({ error: 'File not found' }, 404)
    }
    const ext = extname(path)
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'
    return new Response(new Uint8Array(content), {
      headers: { 'Content-Type': contentType },
    })
  })

  // Full old/new file contents for a diffed file, so the client can build a
  // non-partial diff that supports expanding context around hunks.
  // `oldOid`/`newOid` are blob ids from the patch's `index` line. The diff is
  // regenerated and the requested oids must match its `index` line for the
  // requested path: this keeps arbitrary repository blobs unreachable, and
  // rejects requests whose patch no longer matches the worktree (git recomputes
  // the worktree blob hash on every diff, so any edit changes the new oid).
  app.get('/api/file-versions', (c) => {
    const repo = getRepo(c)
    if (!repo) return unknownRepo(c)
    const path = c.req.query('path')
    const oldOid = c.req.query('oldOid')
    const newOid = c.req.query('newOid')
    if (!path || !oldOid || !newOid) {
      return c.json({ error: 'Missing path or oids' }, 400)
    }
    const staged = c.req.query('staged') === 'true'
    const untracked = c.req.query('untracked') === 'true'
    let patch: string
    try {
      patch = diffFor(repo, { staged, untracked })
    } catch {
      return c.json({ error: 'Diff unavailable' }, 500)
    }
    if (!diffContainsFileVersion(patch, path, oldOid, newOid)) {
      return c.json({ error: 'File version not in current diff' }, 404)
    }
    // A zero oid is git's `/dev/null` — an absent side (creation/deletion), so
    // its content is empty. A non-zero oid that is missing from the object
    // database is the worktree blob of an unstaged change (git computes its
    // hash without storing it), so fall back to reading the worktree.
    const oldContent = /^0+$/.test(oldOid) ? '' : getBlobContent(repo.root, oldOid)
    const newContent = /^0+$/.test(newOid) ? '' : getBlobContent(repo.root, newOid) ?? getWorktreeFileContent(repo.root, path)
    if (oldContent == null || newContent == null) {
      return c.json({ error: 'Content unavailable' }, 404)
    }
    return c.json({ old: oldContent, new: newContent })
  })

  // Code navigation for the symbol at `path:line:column`. `engine=text` answers
  // instantly with `git grep`; `engine=lsp` asks a language server for exact
  // results and reports why when it can't (not installed, still loading, ...).
  app.get('/api/nav', async (c) => {
    const repo = getRepo(c)
    if (!repo) return unknownRepo(c)
    const symbol = c.req.query('symbol') ?? ''
    if (!SYMBOL_PATTERN.test(symbol)) return c.json({ error: 'Invalid symbol' }, 400)
    if (c.req.query('engine') === 'lsp') {
      const path = c.req.query('path')
      const line = Number(c.req.query('line'))
      const column = Number(c.req.query('column'))
      if (!lsp) return c.json({ status: 'unsupported' })
      if (!path || !isSafePath(path, repo.root) || !(line >= 1) || !(column >= 0)) {
        return c.json({ error: 'Missing or invalid path, line or column' }, 400)
      }
      return c.json(await lsp.navigate(repo.root, path, line, column, symbol))
    }
    try {
      return c.json(await textSearch(repo.root, symbol))
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // Which languages the repo uses and what exact navigation needs for each
  // (SDKs, language servers, restored packages), with the fix for each gap.
  app.get('/api/tooling', async (c) => {
    const repo = getRepo(c)
    if (!repo) return unknownRepo(c)
    if (!lsp) return c.json([])
    return c.json(await detectTooling(repo.root, lsp))
  })

  // Runs a setup step from /api/tooling (e.g. installing csharp-ls). Only the
  // fixed commands defined in tooling.ts can run, and only on localhost.
  const runningFixes = new Set<string>()
  app.post('/api/tooling/fix', async (c) => {
    if (!canManageRepos) return c.json({ error: 'Setup steps can only be run when diffx listens on localhost' }, 403)
    if (!c.req.header('Content-Type')?.startsWith('application/json')) {
      return c.json({ error: 'Content-Type must be application/json' }, 415)
    }
    const repo = getRepo(c)
    if (!repo) return unknownRepo(c)
    const { language, check } = await c.req.json<{ language?: unknown; check?: unknown }>()
    if (typeof language !== 'string' || typeof check !== 'string') return c.json({ error: 'Missing language or check' }, 400)
    const key = `${repo.root}\0${language}`
    if (runningFixes.has(key)) return c.json({ error: 'Another setup step is already running' }, 409)
    runningFixes.add(key)
    try {
      return c.json(await runFix(repo.root, language, check))
    } finally {
      runningFixes.delete(key)
    }
  })

  // Starts a language server ahead of the first lookup.
  app.post('/api/tooling/warm', async (c) => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) {
      return c.json({ error: 'Content-Type must be application/json' }, 415)
    }
    const repo = getRepo(c)
    if (!repo) return unknownRepo(c)
    const { language } = await c.req.json<{ language?: unknown }>()
    const spec = SERVERS.find((s) => s.id === language)
    if (!lsp || !spec) return c.json({ error: 'Unknown language' }, 400)
    // Starting can take a while for large solutions; report progress via /api/tooling.
    lsp.warm(repo.root, spec).catch(() => {})
    return c.json(lsp.state(repo.root, spec))
  })

  // A work tree file's text, for previewing files that aren't in the diff.
  app.get('/api/source', (c) => {
    const repo = getRepo(c)
    if (!repo) return unknownRepo(c)
    const path = c.req.query('path')
    if (!path) return c.json({ error: 'Missing path' }, 400)
    const contents = getWorktreeFileContent(repo.root, path)
    if (contents == null) return c.json({ error: 'File not found' }, 404)
    if (contents.length > MAX_SOURCE_BYTES) return c.json({ error: 'File too large to preview' }, 413)
    return c.json({ path, contents })
  })

  app.get('/api/settings', (c) => {
    return c.json(loadSettings())
  })

  app.put('/api/settings', async (c) => {
    const body = await c.req.json()
    const settings = saveSettings(body)
    return c.json(settings)
  })

  app.get('/api/viewed', (c) => {
    const repo = getRepo(c)
    if (!repo) return unknownRepo(c)
    return c.json(Object.fromEntries(viewedFor(repo)))
  })

  app.put('/api/viewed', async (c) => {
    const repo = getRepo(c)
    if (!repo) return unknownRepo(c)
    const viewedFiles = viewedFor(repo)
    const { filePath, viewed, contentHash } = await c.req.json<{ filePath: string; viewed: boolean; contentHash?: string }>()
    if (viewed) {
      if (typeof contentHash !== 'string' || contentHash.length === 0) {
        return c.json({ error: 'non-empty contentHash required when marking viewed' }, 400)
      }
      viewedFiles.set(filePath, contentHash)
    } else {
      viewedFiles.delete(filePath)
    }
    return c.json({ ok: true })
  })

  // Lists comments across all repos unless `?repo=<id>` narrows it. Comment
  // ids are globally unique, so the per-comment routes below need no repo.
  app.get('/api/comments', async (c) => {
    const repoId = c.req.query('repo')
    if (repoId !== undefined && !repos.get(repoId)) return unknownRepo(c)
    const comments = await store.getAll()
    return c.json(repoId === undefined ? comments : comments.filter((comment) => comment.repoId === repoId))
  })

  app.post('/api/comments', async (c) => {
    const repo = getRepo(c)
    if (!repo) return unknownRepo(c)
    const body = await c.req.json()
    const comment = {
      id: crypto.randomUUID(),
      repoId: repo.id,
      repoPath: repo.root,
      filePath: body.filePath,
      side: body.side,
      lineNumber: body.lineNumber,
      lineContent: body.lineContent,
      body: body.body,
      status: 'open' as const,
      createdAt: Date.now(),
      replies: [],
    }
    const created = await store.add(comment)
    return c.json(created, 201)
  })

  app.put('/api/comments/:id', async (c) => {
    const id = c.req.param('id')
    const { body, status } = await c.req.json()
    const updated = await store.update(id, { body, status })
    if (!updated) return c.json({ error: 'Comment not found' }, 404)
    return c.json(updated)
  })

  app.post('/api/comments/:id/replies', async (c) => {
    const commentId = c.req.param('id')
    const { body } = await c.req.json()
    const reply = {
      id: crypto.randomUUID(),
      body,
      createdAt: Date.now(),
    }
    const updated = await store.addReply(commentId, reply)
    if (!updated) return c.json({ error: 'Comment not found' }, 404)
    return c.json(updated)
  })

  app.delete('/api/comments/:id', async (c) => {
    const id = c.req.param('id')
    const removed = await store.remove(id)
    if (!removed) return c.json({ error: 'Comment not found' }, 404)
    return c.json({ ok: true })
  })

  app.get('/*', async (c) => {
    let filePath = c.req.path
    if (filePath === '/') filePath = '/index.html'

    const relativePath = filePath.slice(1)
    if (!isSafePath(relativePath, clientDir)) {
      return c.text('Forbidden', 403)
    }
    const fullPath = resolve(clientDir, relativePath)
    try {
      const content = await readFile(fullPath)
      const ext = extname(fullPath)
      const contentType = MIME_TYPES[ext] || 'application/octet-stream'
      return new Response(content, {
        headers: { 'Content-Type': contentType },
      })
    } catch {
      const indexContent = await readFile(join(clientDir, 'index.html'))
      return new Response(indexContent, {
        headers: { 'Content-Type': 'text/html' },
      })
    }
  })

  return app
}

export function startServer(options: AppOptions & { port: number; host: string }): Promise<{ port: number }> {
  const app = createApp(options)

  return new Promise((resolve) => {
    const server = serve({
      fetch: app.fetch,
      port: options.port,
      hostname: options.host,
    }, (info) => {
      resolve({ port: info.port })
    })
  })
}
