import { useCallback, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { LanguageTooling } from '../../navigation/tooling'
import { repoUrl } from './useRepos'

export type { LanguageTooling, ToolingCheck, ToolingFix } from '../../navigation/tooling'

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return body
}

const isBusy = (l: LanguageTooling) => l.serverState.status === 'starting' || l.serverState.status === 'loading'

/**
 * What each language in the repo needs for exact code navigation. Once a
 * language's requirements are met its language server is started in the
 * background, so the project is loaded before the first lookup.
 */
export function useTooling(repoId: string) {
  const queryClient = useQueryClient()
  const queryKey = ['tooling', repoId]
  const { data: languages = [], isPending } = useQuery({
    queryKey,
    queryFn: () => fetchJson<LanguageTooling[]>(repoUrl('/api/tooling', repoId)),
    // Poll while a server starts or loads the project, to show its progress.
    refetchInterval: (q) => (q.state.data?.some(isBusy) ? 2000 : false),
  })

  const warmed = useRef(new Set<string>())
  useEffect(() => {
    for (const language of languages) {
      if (!language.ready || language.serverState.status !== 'stopped' || warmed.current.has(language.id)) continue
      warmed.current.add(language.id)
      fetchJson(repoUrl('/api/tooling/warm', repoId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: language.id }),
      })
        .then(() => queryClient.invalidateQueries({ queryKey: ['tooling', repoId] }))
        .catch(() => {})
    }
  }, [languages, repoId, queryClient])

  const runFix = useCallback(
    async (language: string, check: string) => {
      const result = await fetchJson<{ ok: boolean; output: string }>(repoUrl('/api/tooling/fix', repoId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language, check }),
      })
      // A fix can make exact results possible: recheck, and re-ask for any open lookup.
      warmed.current.delete(language)
      await queryClient.invalidateQueries({ queryKey: ['tooling', repoId] })
      if (result.ok) queryClient.invalidateQueries({ queryKey: ['nav', 'lsp', repoId] })
      return result
    },
    [repoId, queryClient],
  )

  const restartServer = useCallback(
    async (language: string) => {
      await fetchJson(repoUrl('/api/tooling/warm', repoId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language }),
      })
      await queryClient.invalidateQueries({ queryKey: ['tooling', repoId] })
    },
    [repoId, queryClient],
  )

  const recheck = useCallback(() => queryClient.invalidateQueries({ queryKey: ['tooling', repoId] }), [repoId, queryClient])

  return { languages, loading: isPending, runFix, restartServer, recheck }
}
