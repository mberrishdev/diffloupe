import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { File } from '@pierre/diffs/react'
import type { TokenEventBase } from '@pierre/diffs'
import { ArrowLeft, X, RotateCw, Copy, Check } from 'lucide-react'
import { useNavigation, useSource } from '../hooks/useNavigation'
import type { NavEngineState, NavLocation, NavQuery } from '../hooks/useNavigation'
import { tokenNavigationHandlers, NAVIGATION_SHORTCUT } from '../tokenNavigation'

interface NavPanelProps {
  repoId: string
  query: NavQuery
  canGoBack: boolean
  /** Files that are part of the current diff; their results get a "changed" badge. */
  diffFiles: Set<string>
  onBack: () => void
  onClose: () => void
  onNavigate: (query: NavQuery) => void
  onShowInDiff: (path: string) => void
  onOpenSetup: () => void
}

const sameLocation = (a: NavLocation | null, b: NavLocation) => !!a && a.path === b.path && a.line === b.line

export function NavPanel({ repoId, query, canGoBack, diffFiles, onBack, onClose, onNavigate, onShowInDiff, onOpenSetup }: NavPanelProps) {
  const { result, engine, loading, error, retryExact } = useNavigation(repoId, query)
  const [selected, setSelected] = useState<NavLocation | null>(null)

  // Preview the first definition until the user picks something, like VS Code's peek.
  const current = selected ?? result?.definitions[0] ?? result?.implementations[0] ?? result?.references[0] ?? null

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <aside className="nav-panel" aria-label={`Navigation for ${query.symbol}`}>
      <div className="nav-header">
        {canGoBack && (
          <button type="button" className="nav-icon-btn" onClick={onBack} title="Back" aria-label="Back">
            <ArrowLeft size={14} />
          </button>
        )}
        <code className="nav-symbol">{query.symbol}</code>
        <EngineBadge engine={engine} />
        <button type="button" className="nav-icon-btn nav-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <X size={14} />
        </button>
      </div>
      <EngineNote engine={engine} onRetry={retryExact} onOpenSetup={onOpenSetup} />
      <div className="nav-results">
        {loading && <div className="nav-empty">Searching…</div>}
        {error && <div className="nav-empty nav-error">{error}</div>}
        {result && (
          <>
            <LocationSection title="Definitions" locations={result.definitions} current={current} diffFiles={diffFiles} onSelect={setSelected} />
            <LocationSection title="Implementations" locations={result.implementations} current={current} diffFiles={diffFiles} onSelect={setSelected} />
            <LocationSection title="References" locations={result.references} current={current} diffFiles={diffFiles} onSelect={setSelected} showEmpty />
            {result.truncated && <div className="nav-empty">Showing the first matches only.</div>}
          </>
        )}
      </div>
      {current ? (
        <SourcePreview
          repoId={repoId}
          location={current}
          inDiff={diffFiles.has(current.path)}
          onShowInDiff={onShowInDiff}
          onNavigate={onNavigate}
        />
      ) : (
        result && <div className="nav-preview nav-empty">Nothing to preview. {NAVIGATION_SHORTCUT} another symbol to search for it.</div>
      )}
    </aside>
  )
}

function EngineBadge({ engine }: { engine: NavEngineState }) {
  if (engine.kind === 'exact') {
    return (
      <span className="nav-badge nav-badge-exact" title="Results from a language server">
        Exact · {engine.server}
      </span>
    )
  }
  return (
    <span className="nav-badge" title="Whole-word text matches, classified by pattern">
      Text matches
    </span>
  )
}

function EngineNote({ engine, onRetry, onOpenSetup }: { engine: NavEngineState; onRetry: () => void; onOpenSetup: () => void }) {
  if (engine.kind === 'exact') return null
  if (engine.kind === 'checking') return <div className="nav-note">Asking the language server for exact results…</div>
  const reason = engine.reason
  if (!reason) return null
  switch (reason.status) {
    case 'unavailable':
      return (
        <div className="nav-note">
          Install {reason.server} for exact results: <CopyableCommand command={reason.installHint} />
          <button type="button" className="nav-link-btn" onClick={onOpenSetup}>
            Setup guide
          </button>
        </div>
      )
    case 'loading':
      return (
        <div className="nav-note">
          {reason.server} is still loading the project. Results will update automatically.
          <RetryButton onRetry={onRetry} />
        </div>
      )
    case 'stale':
      return <div className="nav-note">This line has changed on disk since the diff, so only text matches are shown.</div>
    case 'deleted-line':
      return <div className="nav-note">Removed line: showing text matches in the current files.</div>
    case 'error':
      return (
        <div className="nav-note nav-error">
          {reason.server} failed: {reason.message}
          <RetryButton onRetry={onRetry} />
          <button type="button" className="nav-link-btn" onClick={onOpenSetup}>
            Setup guide
          </button>
        </div>
      )
    case 'unsupported':
      return null
  }
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <button type="button" className="nav-link-btn" onClick={onRetry}>
      <RotateCw size={12} /> Retry
    </button>
  )
}

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="nav-command">
      <code>{command}</code>
      <button
        type="button"
        className="nav-icon-btn"
        title="Copy command"
        aria-label="Copy install command"
        onClick={async () => {
          await navigator.clipboard.writeText(command)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </span>
  )
}

interface LocationSectionProps {
  title: string
  locations: NavLocation[]
  current: NavLocation | null
  diffFiles: Set<string>
  onSelect: (location: NavLocation) => void
  showEmpty?: boolean
}

function LocationSection({ title, locations, current, diffFiles, onSelect, showEmpty }: LocationSectionProps) {
  const groups = useMemo(() => {
    const byPath = new Map<string, NavLocation[]>()
    for (const location of locations) {
      const list = byPath.get(location.path) ?? []
      list.push(location)
      byPath.set(location.path, list)
    }
    return [...byPath]
  }, [locations])

  if (locations.length === 0 && !showEmpty) return null

  return (
    <section className="nav-section">
      <h3 className="nav-section-title">
        {title} <span className="nav-count">{locations.length}</span>
      </h3>
      {locations.length === 0 && <div className="nav-empty">None found.</div>}
      {groups.map(([path, items]) => (
        <div key={path} className="nav-file">
          <div className="nav-file-path" title={path}>
            <span className="nav-file-name">{path}</span>
            {diffFiles.has(path) && <span className="nav-changed">changed</span>}
          </div>
          {items.map((location) => (
            <button
              type="button"
              key={`${location.line}:${location.column}`}
              className={`nav-loc ${sameLocation(current, location) ? 'nav-loc-active' : ''}`}
              onClick={() => onSelect(location)}
            >
              <span className="nav-loc-line">{location.line}</span>
              <LineText location={location} />
            </button>
          ))}
        </div>
      ))}
    </section>
  )
}

function LineText({ location }: { location: NavLocation }) {
  const { text, column } = location
  const indent = text.length - text.trimStart().length
  const start = Math.max(column, indent)
  // Highlight the identifier that starts at `column`.
  const end = start + (/^[\w$]+/.exec(text.slice(start))?.[0].length ?? 0)
  // In long lines, start shortly before the match so it stays visible.
  const from = start - indent > 40 ? start - 24 : indent
  return (
    <code className="nav-loc-text">
      {from > indent && '…'}
      {text.slice(from, start)}
      <mark>{text.slice(start, end)}</mark>
      {text.slice(end)}
    </code>
  )
}

interface SourcePreviewProps {
  repoId: string
  location: NavLocation
  inDiff: boolean
  onShowInDiff: (path: string) => void
  onNavigate: (query: NavQuery) => void
}

function SourcePreview({ repoId, location, inDiff, onShowInDiff, onNavigate }: SourcePreviewProps) {
  const { data, error, isPending } = useSource(repoId, location.path)
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrolledTo = useRef<string | null>(null)
  const locationKey = `${location.path}:${location.line}`

  // Center the target line once per location, after the renderer has painted it.
  const handlePostRender = useCallback(
    (node: HTMLElement) => {
      const body = bodyRef.current
      if (!body || scrolledTo.current === locationKey) return
      const root = node.shadowRoot ?? node
      const lineElement = root.querySelector<HTMLElement>(`[data-line="${location.line}"]`)
      if (!lineElement) return
      scrolledTo.current = locationKey
      const offset = lineElement.getBoundingClientRect().top - body.getBoundingClientRect().top
      body.scrollTop += offset - body.clientHeight / 3
    },
    [locationKey, location.line],
  )

  const handlers = useMemo(
    () =>
      tokenNavigationHandlers<TokenEventBase>((props, symbol, column) =>
        onNavigate({ path: location.path, line: props.lineNumber, column, side: 'additions', symbol }),
      ),
    [location.path, onNavigate],
  )

  return (
    <div className="nav-preview">
      <div className="nav-preview-header">
        <span className="nav-preview-path" title={location.path}>
          {location.path}:{location.line}
        </span>
        {inDiff && (
          <button type="button" className="nav-link-btn" onClick={() => onShowInDiff(location.path)}>
            Show in diff
          </button>
        )}
      </div>
      <div className="nav-preview-body" ref={bodyRef}>
        {isPending && <div className="nav-empty">Loading file…</div>}
        {error && <div className="nav-empty nav-error">{error.message}</div>}
        {data && (
          <File
            file={{ name: data.path, contents: data.contents }}
            selectedLines={{ start: location.line, end: location.line }}
            options={{
              theme: { dark: 'github-dark', light: 'github-light' },
              themeType: 'system',
              overflow: 'scroll',
              disableFileHeader: true,
              onPostRender: handlePostRender,
              useTokenTransformer: true,
              ...handlers,
            }}
          />
        )}
      </div>
    </div>
  )
}
