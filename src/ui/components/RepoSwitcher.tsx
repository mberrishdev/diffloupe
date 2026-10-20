import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Plus, X } from 'lucide-react'
import type { RepoInfo } from '../hooks/useRepos'
import { RepoPicker } from './RepoPicker'

export interface RepoCommentCounts {
  open: number
  total: number
}

interface RepoSwitcherProps {
  repos: RepoInfo[]
  activeRepo: RepoInfo
  commentCounts: Record<string, RepoCommentCounts>
  canManage: boolean
  onSelect: (repoId: string) => void
  onAdd: (path: string) => Promise<void>
  onRemove: (repoId: string) => Promise<void>
}

// Repos that share a folder name are labelled with their parent folder too,
// e.g. `client/api` and `server/api`.
function repoLabel(repo: RepoInfo, repos: RepoInfo[]): string {
  if (repos.filter((r) => r.name === repo.name).length < 2) return repo.name
  const parts = repo.root.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/')
}

export function RepoSwitcher({ repos, activeRepo, commentCounts, canManage, onSelect, onAdd, onRemove }: RepoSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const close = () => {
    setOpen(false)
    setAdding(false)
  }

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close()
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  // A single repo with nothing to manage needs no menu.
  if (repos.length < 2 && !canManage) {
    return <h1 className="toolbar-title">{activeRepo.name}</h1>
  }

  const handleRemove = async (repo: RepoInfo) => {
    const total = commentCounts[repo.id]?.total ?? 0
    if (total > 0 && !window.confirm(`Remove ${repo.name} from this review? Its ${total} comment${total === 1 ? '' : 's'} will be deleted.`)) {
      return
    }
    try {
      await onRemove(repo.id)
    } catch (err) {
      window.alert((err as Error).message)
    }
  }

  return (
    <div className="repo-menu" ref={menuRef}>
      <button
        type="button"
        className={`repo-menu-button ${open ? 'repo-menu-button-open' : ''}`}
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        title={activeRepo.root}
      >
        <span className="toolbar-title">{repoLabel(activeRepo, repos)}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="repo-menu-popover">
          {adding ? (
            <RepoPicker onAdd={async (path) => { await onAdd(path); close() }} onCancel={() => setAdding(false)} />
          ) : (
            <>
              <ul className="repo-menu-list">
                {repos.map((repo) => {
                  const openCount = commentCounts[repo.id]?.open ?? 0
                  return (
                    <li key={repo.id} className={`repo-menu-row ${repo.id === activeRepo.id ? 'repo-menu-row-active' : ''}`}>
                      <button
                        type="button"
                        className="repo-menu-item"
                        onClick={() => {
                          onSelect(repo.id)
                          close()
                        }}
                      >
                        <span className="repo-menu-name">{repoLabel(repo, repos)}</span>
                        <span className="repo-menu-path">{repo.root}</span>
                      </button>
                      {openCount > 0 && (
                        <span className="repo-menu-count" title={`${openCount} open comment${openCount === 1 ? '' : 's'}`}>
                          {openCount}
                        </span>
                      )}
                      {canManage && (
                        <button
                          type="button"
                          className="repo-menu-remove"
                          title="Remove from review"
                          aria-label={`Remove ${repoLabel(repo, repos)} from review`}
                          onClick={() => handleRemove(repo)}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
              {canManage && (
                <button type="button" className="repo-menu-add" onClick={() => setAdding(true)}>
                  <Plus size={14} />
                  Add repository…
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
