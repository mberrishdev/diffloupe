export interface NavLocation {
  /** Path relative to the repo root. */
  path: string
  /** 1-based line number. */
  line: number
  /** 0-based column of the symbol within the line. */
  column: number
  /** The line's text, trimmed of trailing whitespace and capped in length. */
  text: string
}

export interface NavResult {
  symbol: string
  definitions: NavLocation[]
  implementations: NavLocation[]
  references: NavLocation[]
  /** True when the search hit its result cap and some matches are missing. */
  truncated: boolean
}

/** Result of asking a language server; `status` says why there may be no result. */
export type LspNavResponse =
  | ({ status: 'ok'; server: string } & NavResult)
  /** No language server handles this file type. */
  | { status: 'unsupported' }
  /** A server exists for this language but is not installed. */
  | { status: 'unavailable'; server: string; installHint: string }
  /** The clicked position can't be mapped to the file on disk (deleted line, or the file changed). */
  | { status: 'stale'; server: string }
  /** The server is still loading the project; try again shortly. */
  | { status: 'loading'; server: string }
  | { status: 'error'; server: string; message: string }

export const SYMBOL_PATTERN = /^[A-Za-z_$@][\w$]*$/

export const MAX_LINE_TEXT = 300

export function clipLine(text: string): string {
  const trimmed = text.replace(/\s+$/, '')
  return trimmed.length > MAX_LINE_TEXT ? `${trimmed.slice(0, MAX_LINE_TEXT)}…` : trimmed
}
