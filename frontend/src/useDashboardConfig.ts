import { useEffect, useState } from 'react'
import { apiUrl } from './api'
import { dashboardSections as defaultSections } from './dashboardConfig'
import type { DashboardConfigResponse, DashboardSection } from './types'

/** Sections rendered from the shared tile grid; Insights/World/Weather have dedicated views that ignore section.tiles. */
export const editableSectionIds = new Set(['home', 'climate', 'security', 'lights', 'appliances', 'roborock', 'scenes'])

export function useDashboardConfig() {
  const [sections, setSections] = useState<DashboardSection[]>(defaultSections)
  const [nightModeIndoorLights, setNightModeIndoorLights] = useState<string[]>([])
  const [customized, setCustomized] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let stopped = false
    fetch(apiUrl('config'))
      .then((response) => (response.ok ? (response.json() as Promise<DashboardConfigResponse>) : Promise.reject(new Error('load failed'))))
      .then((data) => {
        if (stopped) return
        if (data.sections) {
          setSections(data.sections)
          setCustomized(true)
        }
        setNightModeIndoorLights(data.nightModeIndoorLights)
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
    setSections(data.sections ?? defaultSections)
    setNightModeIndoorLights(data.nightModeIndoorLights)
    setCustomized(Boolean(data.sections))
  }

  async function reset() {
    const response = await fetch(apiUrl('config'), { method: 'DELETE' })
    if (!response.ok) throw new Error('Could not reset the dashboard configuration')
    const data: DashboardConfigResponse = await response.json()
    setSections(defaultSections)
    setNightModeIndoorLights(data.nightModeIndoorLights)
    setCustomized(false)
    return { sections: defaultSections, nightModeIndoorLights: data.nightModeIndoorLights }
  }

  return { sections, nightModeIndoorLights, customized, loading, save, reset }
}
