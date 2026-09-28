import type { ReactNode } from 'react'
import './PageFrame.css'

export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'danger'

interface PageFrameProps {
  /** Small caps line above the title, e.g. "My home" or "Last 24 hours". */
  eyebrow?: ReactNode
  title: ReactNode
  icon?: ReactNode
  /** Right-hand summary text: counts, last-updated, a status word. */
  meta?: ReactNode
  /** Controls that belong to the page (range tabs, a restart button). */
  actions?: ReactNode
  tone?: Tone
  className?: string
  children?: ReactNode
}

/**
 * The one page header. Every section view had grown its own `<header><div><Icon/><h2/></div><span/>`
 * with slightly different sizes and no shared empty/loading vocabulary; this replaces those so
 * the panel reads as one product when it rotates from page to page.
 *
 * The topbar already shows the section name in large type, so this is the *sub*-heading line: it
 * carries what the page is saying about itself right now (status, counts), not the page name.
 */
export function PageFrame({ eyebrow, title, icon, meta, actions, tone = 'neutral', className = '', children }: PageFrameProps) {
  return (
    <section className={`page-frame tone-${tone} ${className}`.trim()}>
      <header className="page-frame-head">
        <div className="page-frame-title">
          {icon && <span className="page-frame-icon" aria-hidden="true">{icon}</span>}
          <div>
            {eyebrow && <span className="page-frame-eyebrow">{eyebrow}</span>}
            <h2>{title}</h2>
          </div>
        </div>
        {(meta || actions) && (
          <div className="page-frame-side">
            {meta && <p className="page-frame-meta">{meta}</p>}
            {actions && <div className="page-frame-actions">{actions}</div>}
          </div>
        )}
      </header>
      {children}
    </section>
  )
}

interface GlassCardProps {
  as?: 'div' | 'section' | 'article' | 'button'
  tone?: Tone
  /** `strong` for text-heavy panels that need a more opaque pane. */
  strength?: 'normal' | 'strong'
  className?: string
  children?: ReactNode
  onClick?: () => void
  'aria-label'?: string
}

/** A pane of glass with the shared radius, edge light and shadow. */
export function GlassCard({ as = 'div', tone = 'neutral', strength = 'normal', className = '', children, onClick, ...rest }: GlassCardProps) {
  const Tag = as
  return (
    <Tag
      className={`glass-card ${strength === 'strong' ? 'glass-strong' : 'glass'} tone-${tone} ${className}`.trim()}
      onClick={onClick}
      type={as === 'button' ? 'button' : undefined}
      {...rest}
    >
      {children}
    </Tag>
  )
}
