import { useState } from 'react'
import { Power } from 'lucide-react'
import { apiUrl, responseError } from './api'
import './LeftOnAction.css'

type LeftOnState = { phase: 'idle' | 'confirm' | 'working' } | { phase: 'done'; message: string } | { phase: 'error'; message: string }

/**
 * One tap to switch off every light, speaker, sprinkler and heater left running. The backend works
 * the list out again when asked, so it only ever touches what is still on at that moment.
 */
export function LeftOnAction({ count, onDone }: { count: number; onDone: () => void }) {
  const [state, setState] = useState<LeftOnState>({ phase: 'idle' })
  async function run() {
    setState({ phase: 'working' })
    try {
      const response = await fetch(apiUrl('actions/turn-off-left-on'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
      })
      if (!response.ok) throw await responseError(response, 'Could not switch things off')
      const result = await response.json() as { turnedOff: string[]; failures: { detail: string }[] }
      const done = `Switched off ${result.turnedOff.length} thing${result.turnedOff.length === 1 ? '' : 's'}.`
      setState(result.failures.length
        ? { phase: 'error', message: `${done} ${result.failures.length} could not be reached.` }
        : { phase: 'done', message: done })
      onDone()
    } catch (error) {
      setState({ phase: 'error', message: error instanceof Error ? error.message : 'Could not switch things off' })
    }
  }
  if (count === 0 && state.phase !== 'done' && state.phase !== 'error') return null
  return (
    <div className="health-left-on glass" role="group" aria-label="Things left on">
      {state.phase === 'confirm' ? <>
        <p>Switch off {count} light{count === 1 ? '' : 's'}, speaker{count === 1 ? '' : 's'}, sprinkler{count === 1 ? '' : 's'} or heater{count === 1 ? '' : 's'} left on? Doors, locks and garages are not touched.</p>
        <div className="health-left-on-actions">
          <button type="button" className="detail-action health-left-on-go" onClick={run}><Power size={16} aria-hidden="true" />Turn off</button>
          <button type="button" className="detail-action" onClick={() => setState({ phase: 'idle' })}>Cancel</button>
        </div>
      </> : state.phase === 'working' ? <p role="status">Switching off…</p> : <>
        {(state.phase === 'done' || state.phase === 'error') && <p role="status" className={state.phase === 'error' ? 'is-error' : undefined}>{state.message}</p>}
        {count > 0 && <button type="button" className="detail-action health-left-on-go" onClick={() => setState({ phase: 'confirm' })}>
          <Power size={16} aria-hidden="true" />Turn off {count} thing{count === 1 ? '' : 's'} left on
        </button>}
      </>}
    </div>
  )
}
