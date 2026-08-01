import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Check, ListPlus, Moon, Plus, RotateCcw, Square, Trash2, Wrench, X } from 'lucide-react'
import type { DashboardSection, HAEntity, TileConfig, TileKind } from './types'
import { icons } from './icons'
import { editableSectionIds } from './useDashboardConfig'
import './ConfigPanel.css'

const tileKinds: TileKind[] = ['sensor', 'toggle', 'lock', 'thermostat', 'vacuum']
const iconNames = Object.keys(icons).sort()

interface ConfigPanelProps {
  entities: Map<string, HAEntity>
  sections: DashboardSection[]
  nightModeIndoorLights: string[]
  onSave: (sections: DashboardSection[], lights: string[]) => Promise<void>
  onReset: () => Promise<{ sections: DashboardSection[]; nightModeIndoorLights: string[] }>
  onClose: () => void
}

function cloneSections(sections: DashboardSection[]): DashboardSection[] {
  return sections.map((section) => ({ ...section, tiles: section.tiles.map((tile) => ({ ...tile })) }))
}

function friendlyName(entity: HAEntity) {
  return String(entity.attributes.friendly_name ?? entity.entity_id.split('.')[1]?.replaceAll('_', ' ') ?? entity.entity_id)
}

export function ConfigPanel({ entities, sections, nightModeIndoorLights, onSave, onReset, onClose }: ConfigPanelProps) {
  const editableSections = sections.filter((section) => editableSectionIds.has(section.id))
  const [tab, setTab] = useState<'tiles' | 'night-mode'>('tiles')
  const [activeSectionId, setActiveSectionId] = useState(editableSections[0]?.id ?? '')
  const [draftSections, setDraftSections] = useState<DashboardSection[]>(() => cloneSections(sections))
  const [draftLights, setDraftLights] = useState<string[]>(nightModeIndoorLights)
  const [newTile, setNewTile] = useState({ entityId: '', label: '', kind: 'sensor' as TileKind, icon: iconNames[0] })
  const [manualLight, setManualLight] = useState('')
  const [pending, setPending] = useState(false)
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (!confirmingReset) return
    const timer = window.setTimeout(() => setConfirmingReset(false), 4_000)
    return () => window.clearTimeout(timer)
  }, [confirmingReset])

  const activeSection = draftSections.find((section) => section.id === activeSectionId)
  const allEntityIds = Array.from(entities.keys()).sort()
  const lightEntities = Array.from(entities.values())
    .filter((entity) => entity.entity_id.startsWith('light.'))
    .sort((left, right) => friendlyName(left).localeCompare(friendlyName(right)))
  const knownLightIds = new Set(lightEntities.map((entity) => entity.entity_id))
  const offlineLights = draftLights.filter((entityId) => !knownLightIds.has(entityId))

  function updateSectionTiles(sectionId: string, updater: (tiles: TileConfig[]) => TileConfig[]) {
    setDraftSections((current) => current.map((section) => (section.id === sectionId ? { ...section, tiles: updater(section.tiles) } : section)))
  }

  function addTile() {
    if (!activeSection) return
    const entityId = newTile.entityId.trim()
    const label = newTile.label.trim()
    if (!entityId || !label || activeSection.tiles.some((tile) => tile.entityId === entityId)) return
    updateSectionTiles(activeSection.id, (tiles) => [...tiles, { entityId, label, kind: newTile.kind, icon: newTile.icon }])
    setNewTile({ entityId: '', label: '', kind: 'sensor', icon: iconNames[0] })
  }

  function removeTile(entityId: string) {
    if (!activeSection) return
    updateSectionTiles(activeSection.id, (tiles) => tiles.filter((tile) => tile.entityId !== entityId))
  }

  function moveTile(index: number, direction: -1 | 1) {
    if (!activeSection) return
    const target = index + direction
    if (target < 0 || target >= activeSection.tiles.length) return
    updateSectionTiles(activeSection.id, (tiles) => {
      const next = [...tiles]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  function updateTileField<K extends 'label' | 'kind' | 'icon'>(entityId: string, field: K, value: TileConfig[K]) {
    if (!activeSection) return
    updateSectionTiles(activeSection.id, (tiles) => tiles.map((tile) => (tile.entityId === entityId ? { ...tile, [field]: value } : tile)))
  }

  function toggleLight(entityId: string) {
    setDraftLights((current) => (current.includes(entityId) ? current.filter((id) => id !== entityId) : [...current, entityId]))
  }

  function addManualLight() {
    const entityId = manualLight.trim()
    if (!entityId || draftLights.includes(entityId)) return
    setDraftLights((current) => [...current, entityId])
    setManualLight('')
  }

  async function handleSave() {
    setPending(true)
    setMessage(null)
    try {
      await onSave(draftSections, draftLights)
      setMessage({ tone: 'success', text: 'Dashboard configuration saved.' })
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Save failed' })
    } finally {
      setPending(false)
    }
  }

  async function handleReset() {
    if (!confirmingReset) {
      setConfirmingReset(true)
      return
    }
    setPending(true)
    setMessage(null)
    setConfirmingReset(false)
    try {
      const result = await onReset()
      setDraftSections(cloneSections(result.sections))
      setDraftLights(result.nightModeIndoorLights)
      setMessage({ tone: 'success', text: 'Restored the default dashboard configuration.' })
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Reset failed' })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="detail-backdrop" role="presentation" onClick={onClose}>
      <section className="detail-sheet config-sheet" role="dialog" aria-modal="true" aria-labelledby="config-title" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <header>
          <span className="detail-icon"><Wrench size={24} /></span>
          <div><p>Dashboard configuration</p><h2 id="config-title">Configure</h2></div>
          <button onClick={onClose} title="Close" aria-label="Close configuration"><X size={20} /></button>
        </header>

        <div className="config-tabs" role="tablist" aria-label="Configuration area">
          <button role="tab" aria-selected={tab === 'tiles'} className={tab === 'tiles' ? 'active' : ''} onClick={() => setTab('tiles')}>Dashboard tiles</button>
          <button role="tab" aria-selected={tab === 'night-mode'} className={tab === 'night-mode' ? 'active' : ''} onClick={() => setTab('night-mode')}><Moon size={14} aria-hidden="true" /> Night Mode lights</button>
        </div>

        {tab === 'tiles' ? (
          <div className="config-tiles">
            <div className="config-section-pills" role="tablist" aria-label="Dashboard section">
              {editableSections.map((item) => (
                <button key={item.id} role="tab" aria-selected={item.id === activeSectionId} className={item.id === activeSectionId ? 'active' : ''} onClick={() => setActiveSectionId(item.id)}>{item.label}</button>
              ))}
            </div>

            {activeSection && (
              <>
                <div className="config-tile-rows">
                  {activeSection.tiles.length === 0 && <p className="config-empty">No tiles in this section yet — add one below.</p>}
                  {activeSection.tiles.map((tile, index) => {
                    const TileIcon = icons[tile.icon] ?? Square
                    return (
                      <div className="config-tile-row" key={tile.entityId}>
                        <div className="config-tile-move">
                          <button onClick={() => moveTile(index, -1)} disabled={index === 0} aria-label={`Move ${tile.label} up`}><ArrowUp size={13} /></button>
                          <button onClick={() => moveTile(index, 1)} disabled={index === activeSection.tiles.length - 1} aria-label={`Move ${tile.label} down`}><ArrowDown size={13} /></button>
                        </div>
                        <span className="config-tile-icon"><TileIcon size={16} aria-hidden="true" /></span>
                        <code className="config-entity-id" title={tile.entityId}>{tile.entityId}</code>
                        <input className="config-label-input" value={tile.label} onChange={(event) => updateTileField(tile.entityId, 'label', event.target.value)} aria-label={`Label for ${tile.entityId}`} />
                        <select value={tile.kind} onChange={(event) => updateTileField(tile.entityId, 'kind', event.target.value as TileKind)} aria-label={`Tile type for ${tile.entityId}`}>
                          {tileKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                        </select>
                        <select value={tile.icon} onChange={(event) => updateTileField(tile.entityId, 'icon', event.target.value)} aria-label={`Icon for ${tile.entityId}`}>
                          {iconNames.map((name) => <option key={name} value={name}>{name}</option>)}
                        </select>
                        <button className="config-remove" onClick={() => removeTile(tile.entityId)} aria-label={`Remove ${tile.label}`} title="Remove tile"><Trash2 size={15} /></button>
                      </div>
                    )
                  })}
                </div>

                <div className="config-add-row">
                  <input className="config-entity-input" list="config-entity-suggestions" placeholder="entity_id, e.g. light.kitchen" value={newTile.entityId} onChange={(event) => setNewTile((current) => ({ ...current, entityId: event.target.value }))} />
                  <input placeholder="Label" value={newTile.label} onChange={(event) => setNewTile((current) => ({ ...current, label: event.target.value }))} />
                  <select value={newTile.kind} onChange={(event) => setNewTile((current) => ({ ...current, kind: event.target.value as TileKind }))} aria-label="New tile type">
                    {tileKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                  </select>
                  <select value={newTile.icon} onChange={(event) => setNewTile((current) => ({ ...current, icon: event.target.value }))} aria-label="New tile icon">
                    {iconNames.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                  <button className="detail-action primary" onClick={addTile} disabled={!newTile.entityId.trim() || !newTile.label.trim()}><Plus size={16} aria-hidden="true" /><span>Add tile</span></button>
                </div>
                <datalist id="config-entity-suggestions">
                  {allEntityIds.map((entityId) => <option key={entityId} value={entityId} />)}
                </datalist>
              </>
            )}
          </div>
        ) : (
          <div className="config-lights">
            <p className="config-hint">Night Mode turns off these lights the moment it is confirmed. Only include lights that are always safe to switch off unattended.</p>
            {lightEntities.length === 0 && offlineLights.length === 0 && (
              <p className="config-empty">No light entities are available yet — connect Home Assistant, or add one by entity ID below.</p>
            )}
            <div className="config-light-grid">
              {lightEntities.map((entity) => (
                <label key={entity.entity_id} className="config-light-check">
                  <input type="checkbox" checked={draftLights.includes(entity.entity_id)} onChange={() => toggleLight(entity.entity_id)} />
                  <span>{friendlyName(entity)}</span>
                </label>
              ))}
              {offlineLights.map((entityId) => (
                <label key={entityId} className="config-light-check is-offline">
                  <input type="checkbox" checked onChange={() => toggleLight(entityId)} />
                  <span>{entityId} <em>not reporting</em></span>
                </label>
              ))}
            </div>
            <div className="config-add-row config-add-light">
              <input placeholder="light.entity_id" value={manualLight} onChange={(event) => setManualLight(event.target.value)} />
              <button className="detail-action" onClick={addManualLight} disabled={!manualLight.trim()}><ListPlus size={16} aria-hidden="true" /><span>Add by ID</span></button>
            </div>
          </div>
        )}

        {message && <p className={message.tone === 'error' ? 'detail-error' : 'config-success'} role="status">{message.text}</p>}
        {pending && <div className="detail-progress" role="status">Saving</div>}

        <div className="config-footer">
          <button className="detail-action" onClick={() => void handleReset()} disabled={pending}>
            <RotateCcw size={16} aria-hidden="true" /><span>{confirmingReset ? 'Confirm reset?' : 'Reset to defaults'}</span>
          </button>
          <button className="detail-action primary" onClick={() => void handleSave()} disabled={pending}>
            <Check size={16} aria-hidden="true" /><span>Save changes</span>
          </button>
        </div>
      </section>
    </div>
  )
}
