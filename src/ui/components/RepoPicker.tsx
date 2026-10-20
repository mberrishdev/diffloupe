import { useState } from 'react'
import { FolderGit2, CornerDownLeft } from 'lucide-react'
import { useRepoSuggestions } from '../hooks/useRepos'
import type { RepoSuggestion } from '../hooks/useRepos'

interface RepoPickerProps {
  onAdd: (path: string) => Promise<void>
  onCancel?: () => void
}

type PickerItem = { kind: 'path'; path: string } | { kind: 'suggestion'; suggestion: RepoSuggestion }

const SOURCE_LABELS: Record<RepoSuggestion['source'], string> = {
  worktree: 'worktree',
  recent: 'recent',
  nearby: 'nearby',
}

// Typed input is treated as a path when it looks like one; otherwise it filters suggestions.
const looksLikePath = (text: string) => /^(~|\/|\.|[A-Za-z]:[\\/])/.test(text)

export function RepoPicker({ onAdd, onCancel }: RepoPickerProps) {
  const { data: suggestions = [], isLoading, error: suggestionsError } = useRepoSuggestions()
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const q = query.trim()
  const needle = q.toLowerCase().replace(/^~/, '')
  const items: PickerItem[] = [
    ...(looksLikePath(q) ? [{ kind: 'path' as const, path: q }] : []),
    ...suggestions
      .filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.root.toLowerCase().includes(needle))
      .map((suggestion) => ({ kind: 'suggestion' as const, suggestion })),
  ]
  const active = Math.min(highlighted, items.length - 1)

  const add = async (item: PickerItem | undefined) => {
    if (!item || adding) return
    setAdding(true)
    setError(null)
    try {
      await onAdd(item.kind === 'path' ? item.path : item.suggestion.root)
    } catch (err) {
      setError((err as Error).message)
      setAdding(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted(Math.min(active + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted(Math.max(active - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      add(items[active])
    } else if (e.key === 'Escape' && onCancel) {
      // Step back to the repo list instead of letting the menu close entirely.
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
  }

  return (
    <div className="repo-picker">
      <input
        className="repo-picker-input"
        autoFocus
        placeholder="Search repositories or type a path…"
        value={query}
        disabled={adding}
        onChange={(e) => {
          setQuery(e.target.value)
          setHighlighted(0)
          setError(null)
        }}
        onKeyDown={handleKeyDown}
        aria-label="Repository search or path"
      />
      {error && <div className="repo-picker-error">{error}</div>}
      <ul className="repo-picker-list" role="listbox">
        {items.map((item, index) => {
          const key = item.kind === 'path' ? 'path' : item.suggestion.root
          return (
            <li key={key} role="option" aria-selected={index === active}>
              <button
                type="button"
                className={`repo-picker-item ${index === active ? 'repo-picker-item-active' : ''}`}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => add(item)}
                disabled={adding}
              >
                {item.kind === 'path' ? (
                  <>
                    <CornerDownLeft size={14} className="repo-picker-icon" />
                    <span className="repo-picker-name">Open {item.path}</span>
                  </>
                ) : (
                  <>
                    <FolderGit2 size={14} className="repo-picker-icon" />
                    <span className="repo-picker-text">
                      <span className="repo-picker-name">
                        {item.suggestion.name}
                        {item.suggestion.changed && <span className="repo-picker-changed" title="Has uncommitted changes" />}
                      </span>
                      <span className="repo-picker-path">{item.suggestion.root}</span>
                    </span>
                    <span className="repo-picker-source">{SOURCE_LABELS[item.suggestion.source]}</span>
                  </>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      {items.length === 0 && (
        <div className="repo-picker-empty">
          {isLoading
            ? 'Looking for repositories…'
            : suggestionsError
              ? suggestionsError.message
              : q
                ? 'No matches. Type a path such as ~/code/my-repo.'
                : 'No suggestions. Type a path such as ~/code/my-repo.'}
        </div>
      )}
      {adding && <div className="repo-picker-empty">Adding…</div>}
    </div>
  )
}
