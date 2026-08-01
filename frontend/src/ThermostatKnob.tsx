import { useState } from 'react'
import { Flame, Minus, Plus, Power, Snowflake, Wind } from 'lucide-react'
import type { HAEntity } from './types'
import './ThermostatKnob.css'

interface ThermostatKnobProps {
  entity?: HAEntity
  pending: boolean
  size?: 'tile' | 'large'
  onSet: (temperature: number) => void
}

const startAngle = 135
const sweep = 270
const radius = 40

function polar(angleDegrees: number, distance = radius) {
  const radians = (angleDegrees * Math.PI) / 180
  return { x: 50 + distance * Math.cos(radians), y: 50 + distance * Math.sin(radians) }
}

function arcPath(fromDegrees: number, toDegrees: number) {
  const start = polar(fromDegrees)
  const end = polar(toDegrees)
  const largeArc = toDegrees - fromDegrees > 180 ? 1 : 0
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`
}

function numeric(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Ecobee reports a Celsius-style min_temp, so the dial is clamped to a usable comfort band. */
function comfortRange(entity: HAEntity | undefined, target: number) {
  const reportedMin = numeric(entity?.attributes.min_temp, 50)
  const reportedMax = numeric(entity?.attributes.max_temp, 90)
  const min = Math.min(Math.max(reportedMin, 50), target)
  const max = Math.max(Math.min(reportedMax, 90), target)
  return { min, max }
}

export function ThermostatKnob({ entity, pending, size = 'tile', onSet }: ThermostatKnobProps) {
  const [drag, setDrag] = useState<{ value: number; base: number } | null>(null)

  const target = numeric(entity?.attributes.temperature, 70)
  const current = numeric(entity?.attributes.current_temperature, Number.NaN)
  const humidity = numeric(entity?.attributes.current_humidity, Number.NaN)
  const step = numeric(entity?.attributes.target_temp_step, 1)
  const { min, max } = comfortRange(entity, target)
  const action = String(entity?.attributes.hvac_action ?? entity?.state ?? '')
  const display = drag && drag.base === target ? drag.value : target
  const ratio = max > min ? Math.min(1, Math.max(0, (display - min) / (max - min))) : 0
  const progressAngle = startAngle + sweep * ratio
  const knobPoint = polar(progressAngle)
  const mode = action === 'heating' ? 'heating' : action === 'cooling' ? 'cooling' : action === 'off' ? 'off' : 'idle'
  const ModeIcon = mode === 'heating' ? Flame : mode === 'cooling' ? Snowflake : mode === 'off' ? Power : Wind
  const disabled = pending || !entity

  function clamp(value: number) {
    const stepped = Math.round(value / step) * step
    return Math.min(max, Math.max(min, Number(stepped.toFixed(1))))
  }

  function commit(value: number) {
    const next = clamp(value)
    setDrag({ value: next, base: target })
    if (next !== target) onSet(next)
  }

  function valueFromPointer(event: React.PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const centerX = bounds.left + bounds.width / 2
    const centerY = bounds.top + bounds.height / 2
    const degrees = (Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180) / Math.PI
    let offset = degrees - startAngle
    while (offset < 0) offset += 360
    if (offset > sweep) return offset < sweep + (360 - sweep) / 2 ? max : min
    return min + (offset / sweep) * (max - min)
  }

  function handlePointer(event: React.PointerEvent<SVGSVGElement>) {
    if (disabled) return
    event.stopPropagation()
    const next = clamp(valueFromPointer(event))
    setDrag({ value: next, base: target })
  }

  return (
    <div className={`thermo-knob size-${size} mode-${mode} ${disabled ? 'is-disabled' : ''}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <svg
        viewBox="0 0 100 100"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Target temperature"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={display}
        aria-valuetext={`${display} degrees`}
        aria-disabled={disabled}
        onPointerDown={(event) => {
          if (disabled) return
          event.currentTarget.setPointerCapture(event.pointerId)
          handlePointer(event)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) handlePointer(event)
        }}
        onPointerUp={(event) => {
          if (disabled) return
          event.stopPropagation()
          event.currentTarget.releasePointerCapture(event.pointerId)
          commit(valueFromPointer(event))
        }}
        onKeyDown={(event) => {
          if (disabled) return
          if (['ArrowUp', 'ArrowRight'].includes(event.key)) { event.preventDefault(); commit(display + step) }
          if (['ArrowDown', 'ArrowLeft'].includes(event.key)) { event.preventDefault(); commit(display - step) }
        }}
      >
        <defs>
          <linearGradient id={`thermoTrack-${size}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#1b3040" />
            <stop offset="100%" stopColor="#16242f" />
          </linearGradient>
          <linearGradient id={`thermoFill-${mode}-${size}`} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor={mode === 'heating' ? '#ff8a4c' : mode === 'cooling' ? '#2bb9ff' : '#3fd6c8'} />
            <stop offset="100%" stopColor={mode === 'heating' ? '#ffd166' : mode === 'cooling' ? '#7de3ff' : '#8ef0d3'} />
          </linearGradient>
        </defs>
        <path d={arcPath(startAngle, startAngle + sweep)} className="thermo-track" stroke={`url(#thermoTrack-${size})`} />
        <path d={arcPath(startAngle, progressAngle)} className="thermo-progress" stroke={`url(#thermoFill-${mode}-${size})`} />
        <circle cx={knobPoint.x} cy={knobPoint.y} r="5.4" className="thermo-handle" />
      </svg>
      <div className="thermo-readout">
        <span className="thermo-mode"><ModeIcon size={size === 'large' ? 16 : 13} aria-hidden="true" />{mode === 'idle' ? 'Idle' : mode.replace(/^./, (letter) => letter.toUpperCase())}</span>
        <strong>{Number.isFinite(display) ? Math.round(display) : '--'}<i>°</i></strong>
        <small>{Number.isFinite(current) ? `Now ${Math.round(current)}°` : 'No reading'}{Number.isFinite(humidity) ? ` · ${Math.round(humidity)}%` : ''}</small>
      </div>
      <div className="thermo-steppers">
        <button onClick={(event) => { event.stopPropagation(); commit(display - step) }} disabled={disabled} title="Lower target temperature" aria-label="Lower target temperature"><Minus size={size === 'large' ? 18 : 15} /></button>
        <button onClick={(event) => { event.stopPropagation(); commit(display + step) }} disabled={disabled} title="Raise target temperature" aria-label="Raise target temperature"><Plus size={size === 'large' ? 18 : 15} /></button>
      </div>
    </div>
  )
}
