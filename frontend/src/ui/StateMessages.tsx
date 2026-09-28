import type { ReactNode } from 'react'
import { AlertTriangle, Inbox, LoaderCircle, RotateCw } from 'lucide-react'
import './StateMessages.css'

/**
 * The three states every data-backed panel passes through, drawn one way everywhere. A dozen
 * bespoke `.x-empty` / `.y-loading` classes had grown across the views; they all meant one of
 * these.
 */

interface EmptyStateProps {
  icon?: ReactNode
  title: ReactNode
  hint?: ReactNode
  action?: ReactNode
  /** `compact` for inside a card; default fills the panel it is in. */
  size?: 'default' | 'compact'
  className?: string
}

export function EmptyState({ icon, title, hint, action, size = 'default', className = '' }: EmptyStateProps) {
  return (
    <div className={`state-message is-empty is-${size} ${className}`.trim()}>
      <span className="state-message-icon" aria-hidden="true">{icon ?? <Inbox />}</span>
      <p className="state-message-title">{title}</p>
      {hint && <p className="state-message-hint">{hint}</p>}
      {action && <div className="state-message-action">{action}</div>}
    </div>
  )
}

interface LoadingStateProps {
  label?: ReactNode
  size?: 'default' | 'compact'
  className?: string
}

export function LoadingState({ label = 'Loading', size = 'default', className = '' }: LoadingStateProps) {
  return (
    <div className={`state-message is-loading is-${size} ${className}`.trim()} role="status" aria-live="polite">
      <span className="state-message-icon" aria-hidden="true"><LoaderCircle className="spin" /></span>
      <p className="state-message-title">{label}</p>
    </div>
  )
}

interface InlineErrorProps {
  message: ReactNode
  onRetry?: () => void
  size?: 'default' | 'compact'
  className?: string
}

export function InlineError({ message, onRetry, size = 'compact', className = '' }: InlineErrorProps) {
  return (
    <div className={`state-message is-error is-${size} ${className}`.trim()} role="alert">
      <span className="state-message-icon" aria-hidden="true"><AlertTriangle /></span>
      <p className="state-message-title">{message}</p>
      {onRetry && (
        <div className="state-message-action">
          <button type="button" className="state-message-retry glass-pill" onClick={onRetry}><RotateCw size={16} aria-hidden="true" /><span>Retry</span></button>
        </div>
      )}
    </div>
  )
}
