import { useEffect, useState } from 'react'
import { apiUrl } from './api'
import { dashboardSections as defaultSections } from './dashboardConfig'
import type { DashboardConfigResponse, DashboardSection } from './types'

/** Sections rendered from the shared tile grid; Insights/World/Weather have dedicated views that ignore section.tiles. */
export const editableSectionIds = new Set(['home', 'climate', 'security', 'lights', 'appliances', 'roborock', 'scenes'])

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

  useEffect(() => {
    let stopped = false
    fetch(apiUrl('config'))
      .then((response) => (response.ok ? (response.json() as Promise<DashboardConfigResponse>) : Promise.reject(new Error('load failed'))))
      .then((data) => {
        if (stopped) return
        if (data.sections) {
          setSections(withCurrentLabels(data.sections))
          setCustomized(true)
        }
        setNightModeIndoorLights(data.nightModeIndoorLights)
        if (Number.isFinite(data.energyRatePerKwh)) setEnergyRatePerKwh(data.energyRatePerKwh)
      })
      .catch(() => undefined)
      .finally(() => { if (!stopped) setLoading(false) })
    return () => { stopped = true }
  }, [])

  async function save(nextSections: DashboardSection[], nextLights: string[]) {
    const response = await fetch(apiUrl('config'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sections: nextSections, nightModeIndoorLights: nextLights }),
    })
    if (!response.ok) throw new Error('Could not save the dashboard configuration')
    const data: DashboardConfigResponse = await response.json()
    setSections(data.sections ? withCurrentLabels(data.sections) : defaultSections)
    setNightModeIndoorLights(data.nightModeIndoorLights)
    setCustomized(Boolean(data.sections))
  }

  /** Persists only the energy rate; the merge on the server leaves tiles and Night Mode untouched. */
  async function saveEnergyRate(rate: number) {
    setEnergyRatePerKwh(rate)
    const response = await fetch(apiUrl('config'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ energyRatePerKwh: rate }),
    })
    if (!response.ok) throw new Error('Could not save the energy rate')
  }

  async function reset() {
    const response = await fetch(apiUrl('config'), { method: 'DELETE' })
    if (!response.ok) throw new Error('Could not reset the dashboard configuration')
    const data: DashboardConfigResponse = await response.json()
    setSections(defaultSections)
    setNightModeIndoorLights(data.nightModeIndoorLights)
    if (Number.isFinite(data.energyRatePerKwh)) setEnergyRatePerKwh(data.energyRatePerKwh)
    setCustomized(false)
    return { sections: defaultSections, nightModeIndoorLights: data.nightModeIndoorLights }
  }

  return { sections, nightModeIndoorLights, energyRatePerKwh, customized, loading, save, saveEnergyRate, reset }
}
