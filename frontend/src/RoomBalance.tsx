import { useEffect, useState } from 'react'
import { Scale } from 'lucide-react'
import { cachedJson, isAbortError } from './cachedFetch'
import { balanceHeadline, signed, type RoomBalanceData, type RoomStatus } from './carRoomsFormat'
import './RoomBalance.css'

const ROOMS_PATH = 'insights/rooms?days=7'
const ROOMS_TTL_MS = 30 * 60_000
const PARTS = [['night', 'Night'], ['morning', 'Morn'], ['afternoon', 'Aft'], ['evening', 'Eve']] as const
const STATUS_LABEL: Record<RoomStatus, string> = { warm: 'Runs warm', cool: 'Runs cool', balanced: 'Even', stale: 'Sensor stuck' }

export function RoomBalancePanel() {
  const [data, setData] = useState<RoomBalanceData | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const abort = new AbortController()
    cachedJson<RoomBalanceData>(ROOMS_PATH, ROOMS_PATH, ROOMS_TTL_MS, { signal: abort.signal })
      .then((value) => {
        if (!Array.isArray(value?.rooms)) throw new Error('Unexpected rooms response')
        setData(value)
        setFailed(false)
      })
      .catch((error: unknown) => { if (!isAbortError(error)) setFailed(true) })
    return () => abort.abort()
  }, [])

  if (failed || (data && data.rooms.length === 0)) return null

  return (
    <article className="analytics-panel glass room-balance" aria-label="Room balance">
      <header className="room-balance-head">
        <Scale size={16} aria-hidden="true" />
        <div>
          <h3>Room balance · {data?.days ?? 7} days</h3>
          <p>{data ? balanceHeadline(data.rooms) : 'Comparing every room with the thermostat…'}</p>
        </div>
        {data?.reference && <span>vs {data.reference.label}</span>}
      </header>
      {data && (
        <ul className="room-balance-list">
          {data.rooms.map((room) => (
            <li key={room.entityId} className={`is-${room.status}`}>
              <div className="room-balance-name">
                <strong>{room.label}</strong>
                <small>{STATUS_LABEL[room.status]}{room.current !== null ? ` · ${room.current.toFixed(1)}° now` : ''}</small>
              </div>
              <div className="room-balance-offset" aria-label={`${room.label} averages ${signed(room.offset)} against the thermostat`}>
                <span className="room-balance-bar" aria-hidden="true">
                  <span style={room.offset >= 0
                    ? { left: '50%', width: `${Math.min(50, Math.abs(room.offset) * 8)}%` }
                    : { right: '50%', width: `${Math.min(50, Math.abs(room.offset) * 8)}%` }} />
                </span>
                <b>{signed(room.offset)}</b>
              </div>
              <div className="room-balance-parts" aria-label="By time of day">
                {PARTS.map(([key, short]) => {
                  const value = room.parts[key]
                  return (
                    <span key={key} className={room.worstPart === key ? 'is-worst' : undefined}>
                      <small>{short}</small>{value === undefined ? '—' : signed(value)}
                    </span>
                  )
                })}
              </div>
              <p>{room.advice}</p>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}
