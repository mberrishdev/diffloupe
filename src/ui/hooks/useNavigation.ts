import { useQuery } from '@tanstack/react-query'
import type { LspNavResponse, NavResult } from '../../navigation/types'
import { repoUrl } from './useRepos'

export type { NavLocation, NavResult } from '../../navigation/types'

export interface NavQuery {
  path: string
  /** 1-based line number on the clicked side. */
  line: number
  /** 0-based column of the symbol. */
  column: number
  side: 'additions' | 'deletions'
  symbol: string
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/

// Keywords shared by C#, TypeScript and JavaScript; clicking them would just
// search for every use of the keyword.
const KEYWORDS = new Set(
  (
    'abstract as async await base bool break case catch class const continue default delegate do else enum event ' +
    'export extends false finally for foreach from function get if implements import in interface internal is let ' +
    'namespace new null object of out override params partial private protected public readonly record ref return ' +
    'sealed set static string struct super switch this throw true try type typeof using var virtual void while yield'
  ).split(' '),
)

/** The navigable identifier in a clicked syntax token, with its column in the line. */
export function symbolFromToken(tokenText: string, lineCharStart: number): { symbol: string; column: number } | null {
  const match = IDENTIFIER.exec(tokenText)
  if (!match || KEYWORDS.has(match[0])) return null
  return { symbol: match[0], column: lineCharStart + match.index }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return body
}

export type NavEngineState =
  | { kind: 'exact'; server: string }
  | { kind: 'checking' }
  | { kind: 'text'; reason?: Exclude<LspNavResponse, { status: 'ok' }> | { status: 'deleted-line' } }

/**
 * Text-search results arrive first; when a language server answers for the
 * symbol, its exact results replace them. While the server is still loading
 * the project it is asked again every few seconds.
 */
export function useNavigation(repoId: string, query: NavQuery) {
  const params = new URLSearchParams({
    symbol: query.symbol,
    path: query.path,
    line: String(query.line),
    column: String(query.column),
  })
  const text = useQuery({
    queryKey: ['nav', 'text', repoId, query.symbol],
    queryFn: () => fetchJson<NavResult>(repoUrl(`/api/nav?engine=text&${params}`, repoId)),
  })
  // Removed lines no longer exist on disk, so a language server can't resolve them.
  const lspEnabled = query.side === 'additions'
  const lsp = useQuery({
    queryKey: ['nav', 'lsp', repoId, query],
    queryFn: () => fetchJson<LspNavResponse>(repoUrl(`/api/nav?engine=lsp&${params}`, repoId)),
    enabled: lspEnabled,
    retry: false,
    refetchInterval: (q) => (q.state.data?.status === 'loading' ? 5000 : false),
  })

  const exact = lsp.data?.status === 'ok' ? lsp.data : null
  const engine: NavEngineState = exact
    ? { kind: 'exact', server: exact.server }
    : lspEnabled && lsp.isPending
      ? { kind: 'checking' }
      : {
          kind: 'text',
          reason: !lspEnabled
            ? { status: 'deleted-line' }
            : lsp.error
              ? { status: 'error', server: 'language server', message: lsp.error.message }
              : (lsp.data as Exclude<LspNavResponse, { status: 'ok' }> | undefined),
        }

  return {
    result: exact ?? text.data ?? null,
    engine,
    loading: !exact && text.isPending,
    error: text.error?.message ?? null,
    retryExact: () => lsp.refetch(),
  }
}

export function useSource(repoId: string, path: string) {
  return useQuery({
    queryKey: ['source', repoId, path],
    queryFn: () => fetchJson<{ path: string; contents: string }>(repoUrl(`/api/source?path=${encodeURIComponent(path)}`, repoId)),
  })
}
