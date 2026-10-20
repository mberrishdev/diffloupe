import { useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { FileDiffMetadata } from '@pierre/diffs'
import { repoUrl } from './useRepos'

type ViewedMap = Record<string, string>

async function fetchViewed(repoId: string): Promise<ViewedMap> {
  const res = await fetch(repoUrl('/api/viewed', repoId))
  const data = await res.json()
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
}

export function useViewed(repoId: string, files: FileDiffMetadata[]) {
  const queryClient = useQueryClient()
  const viewedKey = useMemo(() => ['viewed', repoId], [repoId])
  const { data: viewedMap = {} } = useQuery({ queryKey: viewedKey, queryFn: () => fetchViewed(repoId) })

  const fileHashByName = useMemo(() => {
    const map: Record<string, string | undefined> = {}
    for (const f of files) map[f.name] = f.newObjectId
    return map
  }, [files])

  const viewedFiles = useMemo(() => {
    const set = new Set<string>()
    for (const f of files) {
      const stored = viewedMap[f.name]
      if (stored === undefined) continue
      const oid = f.newObjectId
      if (oid ? stored === oid : stored === '') set.add(f.name)
    }
    return set
  }, [viewedMap, files])

  const setViewed = useCallback(async (filePath: string, viewed: boolean) => {
    const contentHash = fileHashByName[filePath] ?? ''

    await queryClient.cancelQueries({ queryKey: viewedKey })
    queryClient.setQueryData<ViewedMap>(viewedKey, (prev = {}) => {
      const next = { ...prev }
      if (viewed) {
        next[filePath] = contentHash
      } else {
        delete next[filePath]
      }
      return next
    })

    // Files without a usable content hash (synthetic binary entries) can't be
    // change-detected — keep them session-cache-only.
    if (!contentHash) return

    const res = await fetch(repoUrl('/api/viewed', repoId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath, viewed, contentHash: viewed ? contentHash : undefined }),
    })
    if (!res.ok) {
      queryClient.invalidateQueries({ queryKey: viewedKey })
    }
  }, [queryClient, viewedKey, repoId, fileHashByName])

  return { viewedFiles, setViewed }
}
