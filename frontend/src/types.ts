export interface HAEntity {
  entity_id: string
  state: string
  attributes: Record<string, unknown>
  last_changed: string
  last_updated: string
}

export type TileKind = 'sensor' | 'toggle' | 'lock' | 'thermostat' | 'vacuum'

export interface TileConfig {
  entityId: string
  label: string
  kind: TileKind
  icon: string
}

export interface DashboardSection {
  id: string
  label: string
  tiles: TileConfig[]
}

export interface HealthResponse {
  status: string
  home_assistant: { configured: boolean; connected: boolean }
}

export interface NightModeResponse {
  status: 'completed' | 'partial'
  locked: string[]
  garagesClosed: string[]
  lightsTurnedOff: string[]
  switchesTurnedOff: string[]
  skippedUnavailableLocks: string[]
  failures: { action: string; detail: string }[]
}
