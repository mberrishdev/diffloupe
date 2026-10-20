import { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

export interface RepoInfo {
  id: string
  name: string
  root: string
  branch: string
}

export interface RepoSuggestion {
  root: string
  name: string
  source: 'worktree' | 'recent' | 'nearby'
  changed: boolean
}

interface ReposResponse {
  repos: RepoInfo[]
  canManage: boolean
}

const REPOS_KEY = ['repos']
const SUGGESTIONS_KEY = ['repo-suggestions']

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return body
}

/** Appends `repo=<id>` to an API path that may already carry a query string. */
export function repoUrl(path: string, repoId: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}repo=${encodeURIComponent(repoId)}`
}

function readRepoParam(): string | null {
  return new URLSearchParams(window.location.search).get('repo')
}

function writeRepoParam(id: string | null) {
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('repo', id)
  else url.searchParams.delete('repo')
  window.history.replaceState(null, '', url)
}

/**
 * The repos under review plus the selected one. The selection lives in the
 * page URL (`?repo=<id>`) so a reload keeps it and separate tabs can each
 * show a different repo.
 */
export function useRepos() {
  const queryClient = useQueryClient()
  const { data, error } = useQuery({ queryKey: REPOS_KEY, queryFn: () => fetchJson<ReposResponse>('/api/repos') })
  const [selectedId, setSelectedId] = useState(readRepoParam)

  const repos = data?.repos ?? []
  const activeRepo = repos.find((r) => r.id === selectedId) ?? repos[0] ?? null

  const selectRepo = useCallback((id: string) => {
    setSelectedId(id)
    writeRepoParam(id)
  }, [])

  const addRepo = useCallback(async (path: string) => {
    const repo = await fetchJson<RepoInfo>('/api/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    await queryClient.invalidateQueries({ queryKey: REPOS_KEY })
    queryClient.removeQueries({ queryKey: SUGGESTIONS_KEY })
    selectRepo(repo.id)
  }, [queryClient, selectRepo])

  const removeRepo = useCallback(async (id: string) => {
    await fetchJson(`/api/repos/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (id === selectedId) {
      setSelectedId(null)
      writeRepoParam(null)
    }
    queryClient.removeQueries({ queryKey: SUGGESTIONS_KEY })
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: REPOS_KEY }),
      queryClient.invalidateQueries({ queryKey: ['comments'] }),
    ])
  }, [queryClient, selectedId])

  return {
    repos,
    activeRepo,
    loaded: !!data,
    canManage: data?.canManage ?? false,
    selectRepo,
    addRepo,
    removeRepo,
    error: error ? error.message : null,
  }
}

export function useRepoSuggestions() {
  return useQuery({
    queryKey: SUGGESTIONS_KEY,
    queryFn: () => fetchJson<RepoSuggestion[]>('/api/repo-suggestions'),
    staleTime: 30_000,
  })
}
