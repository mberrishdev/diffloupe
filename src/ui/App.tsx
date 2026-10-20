import { useState, useMemo, useCallback, useEffect } from 'react'
import type { ReactNode } from 'react'
import { Resizable } from 'react-resizable'
import { parsePatchFiles } from '@pierre/diffs'
import { Virtualizer } from '@pierre/diffs/react'
import type { FileDiffMetadata } from '@pierre/diffs'
import type { ReviewComment } from '../types'
import { useDiff } from './hooks/useDiff'
import { useComments, useAllComments } from './hooks/useComments'
import { useSettings } from './hooks/useSettings'
import type { Settings } from './hooks/useSettings'
import { useRepos } from './hooks/useRepos'
import type { RepoInfo } from './hooks/useRepos'
import { useViewed } from './hooks/useViewed'
import { useFullDiffs, fileKey } from './hooks/useFullDiffs'
import { Toolbar } from './components/Toolbar'
import { DiffViewer } from './components/DiffViewer'
import { FileTree } from './components/FileTree'
import { CommentTracker } from './components/CommentTracker'
import { RepoSwitcher } from './components/RepoSwitcher'
import type { RepoCommentCounts } from './components/RepoSwitcher'
import { RepoPicker } from './components/RepoPicker'
import { NavPanel } from './components/NavPanel'
import { ToolingBanner, ToolingChips, ToolingDialog } from './components/ToolingSetup'
import { useTooling } from './hooks/useTooling'
import type { NavQuery } from './hooks/useNavigation'
import { SidebarStorage } from './sidebarStorage'

function useWindowSize({ factor }: { factor: number }) {
  const compute = () => Math.round(window.innerWidth * factor)

  const [size, setSize] = useState(compute)

  useEffect(() => {
    const handleResize = () => setSize(compute())
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [factor])

  return size
}

function StatusView({ title, className, message }: { title?: ReactNode; className: string; message: string }) {
  return (
    <div className="app">
      {title && (
        <div className="toolbar">
          <div className="toolbar-left">{title}</div>
        </div>
      )}
      <div className={className}>
        <p>{message}</p>
      </div>
    </div>
  )
}

export function App() {
  const { settings, loaded, updateSettings } = useSettings()
  const { repos, activeRepo, loaded: reposLoaded, canManage, selectRepo, addRepo, removeRepo, error } = useRepos()
  const allComments = useAllComments()

  const commentCounts = useMemo(() => {
    const counts: Record<string, RepoCommentCounts> = {}
    for (const c of allComments) {
      const entry = (counts[c.repoId] ??= { open: 0, total: 0 })
      entry.total++
      if (c.status === 'open') entry.open++
    }
    return counts
  }, [allComments])

  if (error) {
    return <StatusView className="error" message={`Error: ${error}`} />
  }

  if (!loaded || !reposLoaded) {
    return <StatusView className="loading" message="Loading diff..." />
  }

  if (!activeRepo) {
    return (
      <div className="app">
        <div className="repo-empty">
          <h1 className="repo-empty-title">Pick a repository to review</h1>
          <div className="repo-empty-picker">
            <RepoPicker onAdd={addRepo} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <RepoReview
      // Remount per repo so file-scoped UI state (active file, scroll
      // position, expanded hunks) never leaks from one repo into another.
      key={activeRepo.id}
      repo={activeRepo}
      multiRepo={repos.length > 1}
      canManage={canManage}
      title={
        <RepoSwitcher
          repos={repos}
          activeRepo={activeRepo}
          commentCounts={commentCounts}
          canManage={canManage}
          onSelect={selectRepo}
          onAdd={addRepo}
          onRemove={removeRepo}
        />
      }
      settings={settings}
      updateSettings={updateSettings}
    />
  )
}

interface RepoReviewProps {
  repo: RepoInfo
  multiRepo: boolean
  /** diffloupe listens on localhost, so the UI may run setup steps on this machine. */
  canManage: boolean
  title: ReactNode
  settings: Settings
  updateSettings: (patch: Partial<Settings>) => void
}

function RepoReview({ repo, multiRepo, canManage, title, settings, updateSettings }: RepoReviewProps) {
  const { patch, branch, customMode, binaryFiles, tabSizeMap, untrackedFiles, loading, error } = useDiff(repo.id, {
    staged: settings.staged,
    untracked: settings.untracked,
  })
  const { comments, addComment, removeComment, copyAllComments } =
    useComments(repo.id, multiRepo)
  const [activeFile, setActiveFile] = useState<string | null>(null)
  // Navigation history: the last entry is shown; Back pops it.
  const [navStack, setNavStack] = useState<NavQuery[]>([])
  const navQuery = navStack[navStack.length - 1] ?? null
  const handleNavigate = useCallback((query: NavQuery) => setNavStack((stack) => [...stack, query]), [])
  const handleNavBack = useCallback(() => setNavStack((stack) => stack.slice(0, -1)), [])
  const handleNavClose = useCallback(() => setNavStack([]), [])
  const tooling = useTooling(repo.id)
  const [setupOpen, setSetupOpen] = useState(false)
  const openSetup = useCallback(() => setSetupOpen(true), [])
  const closeSetup = useCallback(() => setSetupOpen(false), [])
  const [sidebar, setSidebar] = useState(() => SidebarStorage.load())
  const maxSidebarWidth = Math.max(SidebarStorage.minSize, useWindowSize({ factor: 0.5 }))

  const handleResize = useCallback((_e: React.SyntheticEvent, data: { size: { width: number } }) => {
    setSidebar((prev) => prev.withSize(data.size.width))
  }, [])

  const handleResizeStop = useCallback((_e: React.SyntheticEvent, data: { size: { width: number } }) => {
    setSidebar((prev) => prev.withSize(data.size.width).save())
  }, [])

  const handleToggleCollapse = useCallback(() => {
    setSidebar((prev) => prev.withCollapsed(!prev.collapsed).save())
  }, [])

  const untrackedSet = useMemo(() => new Set(untrackedFiles), [untrackedFiles])

  const files = useMemo(() => {
    if (!patch) return []
    try {
      const parsed = parsePatchFiles(patch)
      const parsedFiles = parsed.flatMap((p) => p.files)

      const existingNames = new Set(parsedFiles.map((f) => f.name))
      for (const bf of binaryFiles) {
        if (!existingNames.has(bf.path)) {
          const syntheticFile: FileDiffMetadata = {
            name: bf.path,
            type: bf.type === 'added' || bf.type === 'untracked' ? 'new' : bf.type === 'deleted' ? 'deleted' : 'change',
            hunks: [],
            splitLineCount: 0,
            unifiedLineCount: 0,
            isPartial: true,
            deletionLines: [],
            additionLines: [],
          }
          parsedFiles.push(syntheticFile)
        }
      }

      return parsedFiles
    } catch {
      return []
    }
  }, [patch, binaryFiles])

  const fullFiles = useFullDiffs(repo.id, patch, files, { staged: settings.staged, untracked: settings.untracked })
  const displayFiles = useMemo(() => {
    if (fullFiles.size === 0) return files
    return files.map((f) => fullFiles.get(fileKey(f)) ?? f)
  }, [files, fullFiles])

  const { viewedFiles, setViewed } = useViewed(repo.id, files)

  const diffFileNames = useMemo(() => new Set(files.map((f) => f.name)), [files])

  const diffStats = useMemo(() => {
    if (!patch) return { additions: 0, deletions: 0 }
    let additions = 0
    let deletions = 0
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++
    }
    return { additions, deletions }
  }, [patch])

  const binaryFileMap = useMemo(() => {
    const map = new Map<string, (typeof binaryFiles)[number]>()
    for (const bf of binaryFiles) {
      map.set(bf.path, bf)
    }
    return map
  }, [binaryFiles])

  const commentCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const c of comments) {
      counts[c.filePath] = (counts[c.filePath] ?? 0) + 1
    }
    return counts
  }, [comments])

  const fileAnnotationsMap = useMemo(() => {
    const map = new Map<string, { side: ReviewComment['side']; lineNumber: number; metadata: ReviewComment }[]>()
    for (const c of comments) {
      let list = map.get(c.filePath)
      if (!list) {
        list = []
        map.set(c.filePath, list)
      }
      list.push({
        side: c.side,
        lineNumber: c.lineNumber,
        metadata: c,
      })
    }
    return map
  }, [comments])

  const handleFileClick = useCallback((filePath: string) => {
    setActiveFile(filePath)
    const el = document.getElementById(`file-${filePath}`)
    if (el) {
      el.scrollIntoView({ block: 'start' })
    }
  }, [])

  const handleViewedChange = useCallback((filePath: string, viewed: boolean) => {
    setViewed(filePath, viewed)
  }, [setViewed])

  const sidebarContent = (
    <div className="sidebar-content">
      <FileTree
        files={files}
        activeFile={activeFile}
        commentCounts={commentCounts}
        viewedFiles={viewedFiles}
        untrackedFiles={untrackedSet}
        onFileClick={handleFileClick}
        collapsed={sidebar.collapsed}
        onToggleCollapse={handleToggleCollapse}
      />
      {!sidebar.collapsed && <CommentTracker comments={comments} />}
    </div>
  )

  if (loading) {
    return <StatusView title={title} className="loading" message="Loading diff..." />
  }

  if (error) {
    return <StatusView title={title} className="error" message={`Error: ${error}`} />
  }

  return (
    <div className="app">
      <Toolbar
        title={title}
        status={<ToolingChips languages={tooling.languages} onOpen={openSetup} />}
        branch={branch}
        fileCount={files.length}
        additions={diffStats.additions}
        deletions={diffStats.deletions}
        commentCount={comments.length}
        diffStyle={settings.diffStyle}
        diffOptions={{ staged: settings.staged, untracked: settings.untracked }}
        defaultTabSize={settings.defaultTabSize}
        softWrap={settings.softWrap}
        browser={settings.browser}
        customMode={customMode}
        onDiffStyleChange={(style) => updateSettings({ diffStyle: style })}
        onDiffOptionsChange={(options) => updateSettings(options)}
        onDefaultTabSizeChange={(size) => updateSettings({ defaultTabSize: size })}
        onSoftWrapChange={(softWrap) => updateSettings({ softWrap })}
        onBrowserChange={(browser) => updateSettings({ browser })}
        onCopyComments={copyAllComments}
      />
      <ToolingBanner repoRoot={repo.root} languages={tooling.languages} onOpen={openSetup} />
      {setupOpen && (
        <ToolingDialog
          languages={tooling.languages}
          canRunFixes={canManage}
          onRunFix={tooling.runFix}
          onRestartServer={tooling.restartServer}
          onRecheck={tooling.recheck}
          onClose={closeSetup}
        />
      )}
      <div className="app-body">
        {sidebar.collapsed ? (
          <aside className="sidebar sidebar-collapsed" style={{ width: sidebar.visibleSize() }}>
            {sidebarContent}
          </aside>
        ) : (
          <Resizable
            width={sidebar.visibleSize(maxSidebarWidth)}
            height={0}
            axis="x"
            resizeHandles={['e']}
            minConstraints={[SidebarStorage.minSize, 0]}
            maxConstraints={[maxSidebarWidth, 0]}
            onResize={handleResize}
            onResizeStop={handleResizeStop}
            handle={<div className="sidebar-resize-handle" />}
          >
            <aside className="sidebar" style={{ width: sidebar.visibleSize(maxSidebarWidth) }}>
              {sidebarContent}
            </aside>
          </Resizable>
        )}
        <main className="main">
          <Virtualizer className="main-scroll" contentClassName="main-content">
            <DiffViewer
              repoId={repo.id}
              files={displayFiles}
              diffStyle={settings.diffStyle}
              tabSizeMap={tabSizeMap}
              defaultTabSize={settings.defaultTabSize}
              softWrap={settings.softWrap}
              viewedFiles={viewedFiles}
              binaryFiles={binaryFileMap}
              onViewedChange={handleViewedChange}
              fileAnnotationsMap={fileAnnotationsMap}
              onAddComment={addComment}
              onDeleteComment={removeComment}
              onNavigate={handleNavigate}
            />
          </Virtualizer>
        </main>
        {navQuery && (
          <NavPanel
            key={`${navStack.length}:${navQuery.path}:${navQuery.line}:${navQuery.column}:${navQuery.symbol}`}
            repoId={repo.id}
            query={navQuery}
            canGoBack={navStack.length > 1}
            diffFiles={diffFileNames}
            onBack={handleNavBack}
            onClose={handleNavClose}
            onNavigate={handleNavigate}
            onShowInDiff={handleFileClick}
            onOpenSetup={openSetup}
          />
        )}
      </div>
    </div>
  )
}
