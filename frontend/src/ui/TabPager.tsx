import type { ReactNode } from 'react'
import { tabListKeyHandler } from '../tablist'
import './TabPager.css'

export interface PagerTab {
  id: string
  label: string
  icon?: ReactNode
  /** A count shown on the tab: how many things on it need attention. Zero shows nothing. */
  badge?: number
  /** Colours the badge; a tab with something critical on it reads differently from one with a heads-up. */
  tone?: 'warn' | 'danger'
}

interface TabPagerProps {
  tabs: PagerTab[]
  active: string
  onChange: (id: string) => void
  /** Names the tab list for screen readers, and prefixes the ids a panel points back to. */
  label: string
  idPrefix: string
}

/**
 * The tab bar at the foot of a page that is split into screens instead of scrolling. A page puts
 * what matters most on the first tab and the rest behind the others, so nothing needs a scroll
 * to be reached on a wall panel.
 */
export function TabPager({ tabs, active, onChange, label, idPrefix }: TabPagerProps) {
  const ids = tabs.map((tab) => tab.id)
  return (
    <div className="tab-pager" role="tablist" aria-label={label} onKeyDown={tabListKeyHandler(ids, active, onChange)}>
      {tabs.map((tab) => {
        const selected = tab.id === active
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            className={`glass-pill ${selected ? 'is-active' : ''}`}
            onClick={() => onChange(tab.id)}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.badge ? <b className={`tab-pager-badge is-${tab.tone ?? 'warn'}`} aria-label={`${tab.badge} need attention`}>{tab.badge}</b> : null}
          </button>
        )
      })}
    </div>
  )
}
