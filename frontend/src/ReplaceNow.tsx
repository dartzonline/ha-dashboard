import { useState } from 'react'
import { Check, ListPlus, Sparkles, TriangleAlert, Wrench } from 'lucide-react'
import { apiUrl, responseError } from './api'
import './ReplaceNow.css'

export interface ReplaceItem {
  id: string
  kind: 'consumable' | 'clean' | 'salt' | 'fault'
  title: string
  detail: string
  severity: 'critical' | 'warning' | 'info'
  /** What to put on the shopping list; null when the fix is a cleaning job or a sensor check. */
  buy: string | null
}

const ICON = { consumable: Wrench, salt: Wrench, clean: Sparkles, fault: TriangleAlert } as const

/** Worn filters, salt and faulty sensors, each with one tap to put the refill on the shopping list. */
export function ReplaceNow({ items, compact = false }: { items: ReplaceItem[]; compact?: boolean }) {
  const [added, setAdded] = useState<Record<string, 'adding' | 'added' | string>>({})
  async function add(item: ReplaceItem) {
    if (!item.buy) return
    setAdded((current) => ({ ...current, [item.id]: 'adding' }))
    try {
      const response = await fetch(apiUrl('actions/shopping-list'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: item.buy }),
      })
      if (!response.ok) throw await responseError(response, 'Could not add it')
      setAdded((current) => ({ ...current, [item.id]: 'added' }))
    } catch (error) {
      setAdded((current) => ({ ...current, [item.id]: error instanceof Error ? error.message : 'Could not add it' }))
    }
  }
  if (items.length === 0) return null
  return <section className={`replace-now glass${compact ? ' is-compact' : ''}`} aria-label="Replace now">
    <header><h3><Wrench size={14} aria-hidden="true" />Replace now</h3><span>{items.length} item{items.length === 1 ? '' : 's'}</span></header>
    <ul>
      {items.map((item) => {
        const Icon = ICON[item.kind] ?? Wrench
        const state = added[item.id]
        return <li key={item.id} className={`is-${item.severity}`}>
          <Icon size={16} aria-hidden="true" />
          <span className="replace-copy"><strong>{item.title}</strong><small>{item.detail}</small></span>
          {item.buy && (state === 'added'
            ? <span className="replace-added"><Check size={14} aria-hidden="true" />On the list</span>
            : <button type="button" className="glass-pill" disabled={state === 'adding'} onClick={() => void add(item)} title={`Add “${item.buy}” to the shopping list`}>
              <ListPlus size={14} aria-hidden="true" />{state === 'adding' ? 'Adding…' : 'Add to list'}
            </button>)}
          {state && state !== 'adding' && state !== 'added' && <small className="replace-error" role="status">{state}</small>}
        </li>
      })}
    </ul>
  </section>
}
