import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AirStrip, BackupCard, DropoutsPanel, RoutineCard, relativeTime, whenLabel } from './HouseCards'

afterEach(cleanup)

const NOW = new Date(2026, 10, 11, 12, 0)

describe('labels', () => {
  it('says today, tomorrow and yesterday, then the date', () => {
    expect(whenLabel(new Date(2026, 10, 11, 6, 3).toISOString(), NOW)).toBe('Today 6:03 AM')
    expect(whenLabel(new Date(2026, 10, 12, 6, 2).toISOString(), NOW)).toBe('Tomorrow 6:02 AM')
    expect(whenLabel(new Date(2026, 10, 10, 18, 0).toISOString(), NOW)).toMatch(/^Yesterday/)
    expect(whenLabel(new Date(2026, 4, 24, 5, 28).toISOString(), NOW)).toBe('May 24')
  })

  it('counts time since in the largest sensible unit', () => {
    const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString()
    expect(relativeTime(at(0), NOW.getTime())).toBe('just now')
    expect(relativeTime(at(12), NOW.getTime())).toBe('12 min ago')
    expect(relativeTime(at(180), NOW.getTime())).toBe('3 h ago')
    expect(relativeTime(at(60 * 24 * 5), NOW.getTime())).toBe('5 days ago')
  })
})

describe('BackupCard', () => {
  const failing = { severity: 'critical' as const, lastSuccess: new Date(2026, 4, 24, 5, 28).toISOString(), daysSinceSuccess: 171, lastAttempt: new Date(2026, 10, 10, 6, 3).toISOString(), lastResult: 'failed', failing: true, nextScheduled: null, state: 'idle' }

  it('says how long it has been failing', () => {
    render(<BackupCard backup={failing} />)
    expect(screen.getByText('Failing')).toBeTruthy()
    expect(screen.getByText(/171 days ago/)).toBeTruthy()
    expect(screen.getByText(/Every attempt since then has failed/)).toBeTruthy()
  })

  it('stays quiet when healthy unless asked to show', () => {
    const healthy = { ...failing, severity: 'ok' as const, failing: false, daysSinceSuccess: 0.4, lastResult: 'completed' }
    const { container, rerender } = render(<BackupCard backup={healthy} />)
    expect(container.textContent).toBe('')
    rerender(<BackupCard backup={healthy} always />)
    expect(screen.getByText('Healthy')).toBeTruthy()
  })
})

describe('RoutineCard', () => {
  it('shows each visit as done, late or later', () => {
    render(<RoutineCard report={{ entityId: 'binary_sensor.patio', label: 'Patio Door', routines: [
      { minute: 422, time: '7:02 am', daysSeen: 9, daysObserved: 10, typicalMinutes: 6, status: 'done', at: '7:10 am', minutes: 6 },
      { minute: 965, time: '4:05 pm', daysSeen: 10, daysObserved: 10, typicalMinutes: 5, status: 'late' },
      { minute: 1321, time: '10:01 pm', daysSeen: 7, daysObserved: 10, typicalMinutes: 4, status: 'upcoming' },
    ] }} />)
    expect(screen.getByText('Done at 7:10 am · 6 min')).toBeTruthy()
    expect(screen.getByText('Not yet today')).toBeTruthy()
    expect(screen.getByText('Later')).toBeTruthy()
    expect(screen.getByText('1 of 3 today')).toBeTruthy()
  })

  it('shows nothing without a learned routine', () => {
    const { container } = render(<RoutineCard report={{ entityId: 'x', label: 'Patio', routines: [] }} />)
    expect(container.textContent).toBe('')
  })
})

describe('AirStrip and DropoutsPanel', () => {
  it('summarises the air', () => {
    render(<AirStrip air={{ outdoorAqi: 54, outdoorBand: 'moderate', indoorPm25: 3, purifier: { on: true, percentage: 40, name: 'Dyson' } }} />)
    expect(screen.getByText('Outside AQI 54 (moderate) · Inside PM2.5 3 · Purifier on')).toBeTruthy()
  })

  it('lists the worst offenders with how to find them', () => {
    render(<DropoutsPanel days={7} loading={false} failed={false} devices={[
      { entityId: 'device_tracker.sensor_node', name: 'sensor-node', dropouts: 187, perDay: 26.7, lastAt: new Date(Date.now() - 12 * 60_000).toISOString(), usualHour: 3, ip: '192.168.1.50', mac: 'aa:bb:cc:dd:ee:ff', hostname: 'sensor-node', kind: 'wifi', now: 'home' },
    ]} />)
    expect(screen.getByText('187')).toBeTruthy()
    expect(screen.getByText('192.168.1.50 · aa:bb:cc:dd:ee:ff')).toBeTruthy()
    expect(screen.getByText(/often around 3 am/)).toBeTruthy()
  })

  it('says so when nothing is dropping off', () => {
    render(<DropoutsPanel days={7} loading={false} failed={false} devices={[]} />)
    expect(screen.getByText(/Nothing is dropping off/)).toBeTruthy()
  })
})
