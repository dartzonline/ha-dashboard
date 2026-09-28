import { useEffect, useState } from 'react'
import { apiUrl, responseError, timeoutSignal } from './api'
import { dashboardSections as defaultSections } from './dashboardConfig'
import { primeIgnoredEntityIds } from './useEntityDiscovery'
import type { DashboardConfigResponse, DashboardSection } from './types'

/** Sections rendered from the shared tile grid; Insights/World/Weather have dedicated views that ignore section.tiles. */
export const editableSectionIds = new Set(['home', 'climate', 'security', 'lights', 'appliances', 'roborock', 'scenes'])

const RETRY_MIN_MS = 3_000
const RETRY_MAX_MS = 30_000
const FETCH_TIMEOUT_MS = 15_000

/**
 * Saved overrides carry every section, including the dedicated views nobody can edit. Their labels
 * are ours to rename, so a stored copy must not freeze an old one (e.g. "World" after it became
 * "World time"); tiles still come from the saved config.
 */
function withCurrentLabels(saved: DashboardSection[]): DashboardSection[] {
  return saved.map((section) => {
    if (editableSectionIds.has(section.id)) return section
    const current = defaultSections.find((item) => item.id === section.id)
    return current ? { ...section, label: current.label } : section
  })
}

export function useDashboardConfig() {
  const [sections, setSections] = useState<DashboardSection[]>(defaultSections)
  const [nightModeIndoorLights, setNightModeIndoorLights] = useState<string[]>([])
  const [energyRatePerKwh, setEnergyRatePerKwh] = useState(0.15)
  const [customized, setCustomized] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stopped = false
    let retryTimer: number | undefined
    let retryDelay = RETRY_MIN_MS

    async function load() {
      try {
        const response = await fetch(apiUrl('config'), { signal: timeoutSignal(FETCH_TIMEOUT_MS) })
        if (!response.ok) throw await responseError(response, 'Could not load the dashboard configuration')
        const data: DashboardConfigResponse = await response.json()
        if (stopped) return
        if (data.sections) {
          setSections(withCurrentLabels(data.sections))
          setCustomized(true)
        }
        setNightModeIndoorLights(data.nightModeIndoorLights)
        if (Number.isFinite(data.energyRatePerKwh)) setEnergyRatePerKwh(data.energyRatePerKwh)
        // Entity discovery owns this slice (it writes dismissals back through the same merging PUT),
        // but this response already carries it -- hand it over instead of fetching /api/config twice.
        primeIgnoredEntityIds(data.ignoredEntityIds ?? [])
        setError(null)
      } catch (loadError) {
        if (stopped) return
        // Defaults render meanwhile, but saving against them would overwrite the stored layout with
        // the factory one -- so `ready` stays false until a load actually succeeds.
        setError(loadError instanceof Error && loadError.name !== 'TimeoutError' && loadError.name !== 'AbortError'
          ? loadError.message
          : 'Dashboard configuration unavailable')
        retryTimer = window.setTimeout(() => void load(), retryDelay)
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
      } finally {
        if (!stopped) setLoading(false)
      }
    }

    void load()
    return () => {
      stopped = true
      if (retryTimer) window.clearTimeout(retryTimer)
    }
  }, [])

  async function save(nextSections: DashboardSection[], nextLights: string[]) {
    const response = await fetch(apiUrl('config'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sections: nextSections, nightModeIndoorLights: nextLights }),
    })
    if (!response.ok) throw await responseError(response, 'Could not save the dashboard configuration')
    const data: DashboardConfigResponse = await response.json()
    setSections(data.sections ? withCurrentLabels(data.sections) : defaultSections)
    setNightModeIndoorLights(data.nightModeIndoorLights)
    setCustomized(Boolean(data.sections))
  }

  /** Persists only the energy rate; the merge on the server leaves tiles and Night Mode untouched. */
  async function saveEnergyRate(rate: number) {
    const previous = energyRatePerKwh
    // Optimistic so the bill re-prices immediately; rolled back if the server never took it, or the
    // screen would show a rate that reverts on the next reload.
    setEnergyRatePerKwh(rate)
    try {
      const response = await fetch(apiUrl('config'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ energyRatePerKwh: rate }),
      })
      if (!response.ok) throw await responseError(response, 'Could not save the energy rate')
      const data: DashboardConfigResponse | null = await response.json().catch(() => null)
      if (data && Number.isFinite(data.energyRatePerKwh)) setEnergyRatePerKwh(data.energyRatePerKwh)
    } catch (saveError) {
      setEnergyRatePerKwh(previous)
      throw saveError
    }
  }

  async function reset() {
    const response = await fetch(apiUrl('config'), { method: 'DELETE' })
    if (!response.ok) throw await responseError(response, 'Could not reset the dashboard configuration')
    const data: DashboardConfigResponse = await response.json()
    setSections(defaultSections)
    setNightModeIndoorLights(data.nightModeIndoorLights)
    if (Number.isFinite(data.energyRatePerKwh)) setEnergyRatePerKwh(data.energyRatePerKwh)
    // A reset clears the stored overrides, dismissals included, so discovery starts proposing again.
    primeIgnoredEntityIds(data.ignoredEntityIds ?? [])
    setCustomized(false)
    return { sections: defaultSections, nightModeIndoorLights: data.nightModeIndoorLights }
  }

  /** True once the stored configuration has actually been read; saving before that would clobber it with defaults. */
  const ready = !loading && error === null

  return { sections, nightModeIndoorLights, energyRatePerKwh, customized, loading, error, ready, save, saveEnergyRate, reset }
}
