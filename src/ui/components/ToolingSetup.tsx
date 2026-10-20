import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle, AlertTriangle, Loader2, X, Copy, Check, ExternalLink, Play, RotateCw } from 'lucide-react'
import type { LanguageTooling, ToolingCheck } from '../hooks/useTooling'
import { NAVIGATION_SHORTCUT } from '../tokenNavigation'

const SHORT_LABELS: Record<string, string> = { csharp: 'C#', typescript: 'TS/JS' }
const shortLabel = (language: LanguageTooling) => SHORT_LABELS[language.id] ?? language.label

type ChipTone = 'ready' | 'setup' | 'busy' | 'error' | 'idle'

function chipState(language: LanguageTooling): { tone: ChipTone; text: string } {
  if (!language.ready) return { tone: 'setup', text: 'Setup needed' }
  switch (language.serverState.status) {
    case 'starting':
      return { tone: 'busy', text: 'Starting…' }
    case 'loading':
      return { tone: 'busy', text: language.id === 'csharp' ? 'Loading solution…' : 'Loading project…' }
    case 'ready':
      return { tone: 'ready', text: 'Exact navigation' }
    case 'error':
      return { tone: 'error', text: 'Server error' }
    case 'stopped':
      return { tone: 'idle', text: 'Ready' }
  }
}

/** One chip per detected language, in the toolbar; opens the setup dialog. */
export function ToolingChips({ languages, onOpen }: { languages: LanguageTooling[]; onOpen: () => void }) {
  if (languages.length === 0) return null
  return (
    <span className="tooling-chips">
      {languages.map((language) => {
        const { tone, text } = chipState(language)
        return (
          <button
            key={language.id}
            type="button"
            className={`tooling-chip tooling-chip-${tone}`}
            onClick={onOpen}
            title={`${language.label}: ${text}. Click for code navigation setup.`}
          >
            {tone === 'busy' ? <Loader2 size={12} className="tooling-spin" /> : <span className="tooling-dot" />}
            {shortLabel(language)} · {text}
          </button>
        )
      })}
    </span>
  )
}

const dismissKey = (repoRoot: string, languageId: string) => `diffx-tooling-dismissed:${repoRoot}:${languageId}`

function isDismissed(repoRoot: string, languageId: string): boolean {
  try {
    return localStorage.getItem(dismissKey(repoRoot, languageId)) === '1'
  } catch {
    return false
  }
}

/**
 * Shown when a repo uses a language whose exact navigation isn't set up yet,
 * listing what's missing. Dismissal is remembered per repo and language.
 */
export function ToolingBanner({ repoRoot, languages, onOpen }: { repoRoot: string; languages: LanguageTooling[]; onOpen: () => void }) {
  const [dismissed, setDismissed] = useState<Set<string>>(
    () => new Set(languages.filter((l) => isDismissed(repoRoot, l.id)).map((l) => l.id)),
  )
  const pending = languages.filter((l) => !l.ready && !dismissed.has(l.id) && !isDismissed(repoRoot, l.id))
  if (pending.length === 0) return null

  const dismiss = () => {
    for (const language of pending) {
      try {
        localStorage.setItem(dismissKey(repoRoot, language.id), '1')
      } catch {
        // per-viewer convenience only
      }
    }
    setDismissed(new Set([...dismissed, ...pending.map((l) => l.id)]))
  }

  return (
    <div className="tooling-banner" role="status">
      <AlertTriangle size={14} className="tooling-banner-icon" />
      <span>
        This repository uses <strong>{pending.map((l) => l.label).join(' and ')}</strong>. For exact Go to Definition and
        Find All References, you need:{' '}
        {pending
          .flatMap((l) => l.checks.filter((c) => c.status === 'missing'))
          .map((c) => c.label)
          .join(', ')}
        .
      </span>
      <button type="button" className="btn btn-sm btn-primary" onClick={onOpen}>
        Show me how
      </button>
      <button type="button" className="nav-icon-btn" onClick={dismiss} title="Dismiss" aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  )
}

interface ToolingDialogProps {
  languages: LanguageTooling[]
  canRunFixes: boolean
  onRunFix: (language: string, check: string) => Promise<{ ok: boolean; output: string }>
  onRestartServer: (language: string) => Promise<void>
  onRecheck: () => void
  onClose: () => void
}

export function ToolingDialog({ languages, canRunFixes, onRunFix, onRestartServer, onRecheck, onClose }: ToolingDialogProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="tooling-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tooling-dialog" role="dialog" aria-modal="true" aria-labelledby="tooling-title">
        <div className="tooling-dialog-header">
          <h2 id="tooling-title">Code navigation setup</h2>
          <button type="button" className="nav-icon-btn" onClick={onRecheck} title="Check again" aria-label="Check again">
            <RotateCw size={14} />
          </button>
          <button type="button" className="nav-icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <p className="tooling-intro">
          {NAVIGATION_SHORTCUT} a symbol to see its definition, implementations and references. Text matches always
          work; the steps below add exact results from a language server, like VS Code.
        </p>
        {languages.length === 0 && <p className="tooling-intro">No supported languages (C#, TypeScript/JavaScript) found in this repository.</p>}
        {languages.map((language) => (
          <section key={language.id} className="tooling-language">
            <h3 className="tooling-language-title">
              {language.label}
              <ServerStatus language={language} onRestart={() => onRestartServer(language.id)} />
            </h3>
            <ol className="tooling-checks">
              {language.checks.map((check) => (
                <CheckRow
                  key={check.id}
                  check={check}
                  canRun={canRunFixes}
                  onRun={() => onRunFix(language.id, check.id)}
                />
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  )
}

function ServerStatus({ language, onRestart }: { language: LanguageTooling; onRestart: () => void }) {
  if (!language.ready) return <span className="tooling-server">{language.server}: not available yet</span>
  const state = language.serverState
  switch (state.status) {
    case 'ready':
      return <span className="tooling-server tooling-ok">{language.server} is running · exact results on</span>
    case 'starting':
    case 'loading':
      return (
        <span className="tooling-server">
          <Loader2 size={12} className="tooling-spin" /> {language.server} is {state.status === 'starting' ? 'starting' : 'loading the project'}…
        </span>
      )
    case 'error':
      return (
        <span className="tooling-server tooling-error">
          {language.server} failed: {state.message}{' '}
          <button type="button" className="nav-link-btn" onClick={onRestart}>
            Try again
          </button>
        </span>
      )
    case 'stopped':
      return (
        <span className="tooling-server">
          {language.server} starts on first use{' '}
          <button type="button" className="nav-link-btn" onClick={onRestart}>
            Start now
          </button>
        </span>
      )
  }
}

function CheckIcon({ status }: { status: ToolingCheck['status'] }) {
  if (status === 'ok') return <CheckCircle2 size={16} className="tooling-ok" aria-label="Done" />
  if (status === 'warning') return <AlertTriangle size={16} className="tooling-warn" aria-label="Recommended" />
  return <XCircle size={16} className="tooling-error" aria-label="Required" />
}

function CheckRow({ check, canRun, onRun }: { check: ToolingCheck; canRun: boolean; onRun: () => Promise<{ ok: boolean; output: string }> }) {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; output: string } | null>(null)
  const fix = check.fix

  const run = async () => {
    setRunning(true)
    setResult(null)
    try {
      setResult(await onRun())
    } catch (err) {
      setResult({ ok: false, output: (err as Error).message })
    } finally {
      setRunning(false)
    }
  }

  return (
    <li className={`tooling-check tooling-check-${check.status}`}>
      <CheckIcon status={check.status} />
      <div className="tooling-check-body">
        <div className="tooling-check-label">
          {check.label}
          {check.status === 'missing' && <span className="tooling-tag">required</span>}
          {check.status === 'warning' && <span className="tooling-tag tooling-tag-warn">recommended</span>}
        </div>
        <div className="tooling-check-detail">{check.detail}</div>
        {fix && check.status !== 'ok' && (
          <div className="tooling-fix">
            <div>{fix.description}</div>
            {fix.command && (
              <div className="tooling-command">
                <code>{fix.command}</code>
                <CopyButton text={fix.command} />
                {fix.runIn === 'repo' && <span className="tooling-hint">run in the repository folder</span>}
              </div>
            )}
            <div className="tooling-actions">
              {fix.runnable && canRun && (
                <button type="button" className="btn btn-sm btn-primary" onClick={run} disabled={running}>
                  {running ? <Loader2 size={12} className="tooling-spin" /> : <Play size={12} />}
                  {running ? 'Running… this can take a few minutes' : 'Run it for me'}
                </button>
              )}
              {fix.url && (
                <a className="nav-link-btn" href={fix.url} target="_blank" rel="noreferrer">
                  Download <ExternalLink size={12} />
                </a>
              )}
            </div>
            {result && !result.ok && (
              <pre className="tooling-output tooling-error">
                {result.output}
                {'\n\n'}If this keeps failing, run the command yourself in a terminal.
              </pre>
            )}
          </div>
        )}
        {result?.ok && check.status === 'ok' && <div className="tooling-check-detail tooling-ok">Done.</div>}
      </div>
    </li>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="nav-icon-btn"
      title="Copy command"
      aria-label="Copy command"
      onClick={async () => {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}
