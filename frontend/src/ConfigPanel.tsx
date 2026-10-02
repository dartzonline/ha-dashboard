import { useState } from 'react'
import { ArrowDown, ArrowUp, Blend, Check, ListPlus, Monitor, Moon, PackagePlus, Palette, Pencil, Plus, Radio, RotateCcw, Square, Trash2, Wrench, X } from 'lucide-react'
import type { DashboardSection, HAEntity, TileConfig, TileKind } from './types'
import type { TileProposal } from './entityClassifier'
import { friendlyName } from './entityNames'
import { icons } from './icons'
import { tabListKeyHandler } from './tablist'
import { editableSectionIds } from './useDashboardConfig'
import { useEntityDiscovery } from './useEntityDiscovery'
import { useDialog } from './ui/useDialog'
import { useTwoTapConfirm } from './ui/useTwoTapConfirm'
import { defaultTheme, readTheme, saveTheme, themePalettes, type ThemePalette, type ThemePreference } from './theme'
import './ConfigPanel.css'

const tileKinds: TileKind[] = ['sensor', 'toggle', 'lock', 'thermostat', 'vacuum']
const iconNames = Object.keys(icons).sort()

type ConfigTab = 'theme' | 'tiles' | 'discovery' | 'night-mode'
const configTabs: readonly ConfigTab[] = ['theme', 'tiles', 'discovery', 'night-mode']
const styleOptions = [
  { id: 'modern', label: 'Modern', Icon: Monitor },
  { id: 'retro', label: 'Retro', Icon: Radio },
  { id: 'hybrid', label: 'Retro / Modern', Icon: Blend },
] as const

/** Editing the layout is slow, deliberate work; the default two-minute sheet timeout would throw
 *  away a half-built section. Ten minutes still keeps an abandoned panel off the wall. */
const CONFIG_IDLE_MS = 10 * 60_000

const NOT_READY_HINT = 'Waiting for saved layout…'

interface ConfigPanelProps {
  entities: Map<string, HAEntity>
  sections: DashboardSection[]
  nightModeIndoorLights: string[]
  onSave: (sections: DashboardSection[], lights: string[]) => Promise<void>
  onReset: () => Promise<{ sections: DashboardSection[]; nightModeIndoorLights: string[] }>
  onClose: () => void
  /**
   * False until the saved layout has actually loaded. Until then the draft here is the factory
   * layout, and saving it would silently overwrite whatever the household had configured.
   */
  ready: boolean
  /** Why the saved layout could not be loaded, when it could not. */
  loadError?: string | null
}

function cloneSections(sections: DashboardSection[]): DashboardSection[] {
  return sections.map((section) => ({ ...section, tiles: section.tiles.map((tile) => ({ ...tile })) }))
}

/** A review-list entity a human decided to place after all, seeded with neutral defaults to edit. */
function proposalFromEntity(entity: HAEntity): TileProposal {
  return { entityId: entity.entity_id, sectionId: 'home', label: friendlyName(entity), kind: 'sensor', icon: 'circle-dot' }
}

export function ConfigPanel({ entities, sections, nightModeIndoorLights, onSave, onReset, onClose, ready, loadError }: ConfigPanelProps) {
  const ref = useDialog<HTMLElement>({ onClose, idleMs: CONFIG_IDLE_MS })
  const editableSections = sections.filter((section) => editableSectionIds.has(section.id))
  const [tab, setTab] = useState<ConfigTab>('theme')
  const [theme, setTheme] = useState(readTheme)
  const [themeMessage, setThemeMessage] = useState('')
  const [activeSectionId, setActiveSectionId] = useState(editableSections[0]?.id ?? '')
  const [draftSections, setDraftSections] = useState<DashboardSection[]>(() => cloneSections(sections))
  const [draftLights, setDraftLights] = useState<string[]>(nightModeIndoorLights)
  const [newTile, setNewTile] = useState({ entityId: '', label: '', kind: 'sensor' as TileKind, icon: iconNames[0] })
  const [manualLight, setManualLight] = useState('')
  const [pending, setPending] = useState(false)
  const resetConfirm = useTwoTapConfirm()
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  // Proposals are diffed against the *draft* sections, so a device accepted here stops being offered
  // immediately, even before the save round-trips.
  const discovery = useEntityDiscovery(entities, draftSections)
  const [proposalEdits, setProposalEdits] = useState<Record<string, TileProposal>>({})
  const [editingProposalId, setEditingProposalId] = useState<string | null>(null)

  const activeSection = draftSections.find((section) => section.id === activeSectionId)
  const allEntityIds = Array.from(entities.keys()).sort()
  const lightEntities = Array.from(entities.values())
    .filter((entity) => entity.entity_id.startsWith('light.'))
    .sort((left, right) => friendlyName(left).localeCompare(friendlyName(right)))
  const knownLightIds = new Set(lightEntities.map((entity) => entity.entity_id))
  const offlineLights = draftLights.filter((entityId) => !knownLightIds.has(entityId))

  function updateTheme(next: ThemePreference) {
    setTheme(next)
    setThemeMessage(saveTheme(next) ? 'Saved on this device.' : 'Applied for this session. Browser storage is unavailable.')
  }

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

  function updateProposalField<K extends keyof TileProposal>(proposal: TileProposal, field: K, value: TileProposal[K]) {
    setProposalEdits((current) => ({ ...current, [proposal.entityId]: { ...proposal, [field]: value } }))
  }

  /** Accepting a proposal appends the tile and persists straight away -- the tray is the confirmation step. */
  async function acceptProposal(proposal: TileProposal) {
    if (!ready) return
    const target = draftSections.find((section) => section.id === proposal.sectionId)
    if (!target || target.tiles.some((tile) => tile.entityId === proposal.entityId)) return
    const nextSections = draftSections.map((section) =>
      section.id === proposal.sectionId
        ? { ...section, tiles: [...section.tiles, { entityId: proposal.entityId, label: proposal.label, kind: proposal.kind, icon: proposal.icon }] }
        : section,
    )
    setDraftSections(nextSections)
    setEditingProposalId(null)
    setPending(true)
    setMessage(null)
    try {
      await onSave(nextSections, draftLights)
      setMessage({ tone: 'success', text: `Added ${proposal.label} to ${target.label}.` })
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Save failed' })
    } finally {
      setPending(false)
    }
  }

  async function dismissProposal(entityId: string) {
    setEditingProposalId((current) => (current === entityId ? null : current))
    try {
      await discovery.dismiss(entityId)
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Could not save the dismissal' })
    }
  }

  function startEditing(proposal: TileProposal) {
    setProposalEdits((current) => ({ ...current, [proposal.entityId]: proposal }))
    setEditingProposalId(proposal.entityId)
  }

  /** One suggested tile: a summary until "Edit" opens the same fields the manual add row uses. */
  function proposalRow(proposal: TileProposal) {
    const ProposalIcon = icons[proposal.icon] ?? Square
    const editing = editingProposalId === proposal.entityId
    const sectionLabel = editableSections.find((section) => section.id === proposal.sectionId)?.label ?? proposal.sectionId
    return (
      <div className={`config-tile-row config-proposal-row${editing ? ' is-editing' : ''}`} key={proposal.entityId}>
        <span className="config-tile-icon"><ProposalIcon size={16} aria-hidden="true" /></span>
        <code className="config-entity-id" title={proposal.entityId}>{proposal.entityId}</code>
        {editing ? (
          <>
            <input className="config-label-input" value={proposal.label} onChange={(event) => updateProposalField(proposal, 'label', event.target.value)} aria-label={`Label for ${proposal.entityId}`} />
            <select value={proposal.sectionId} onChange={(event) => updateProposalField(proposal, 'sectionId', event.target.value)} aria-label={`Section for ${proposal.entityId}`}>
              {editableSections.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}
            </select>
            <select value={proposal.kind} onChange={(event) => updateProposalField(proposal, 'kind', event.target.value as TileKind)} aria-label={`Tile type for ${proposal.entityId}`}>
              {tileKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
            </select>
            <select value={proposal.icon} onChange={(event) => updateProposalField(proposal, 'icon', event.target.value)} aria-label={`Icon for ${proposal.entityId}`}>
              {iconNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </>
        ) : (
          <span className="config-proposal-summary">{proposal.label} <em>{sectionLabel}</em></span>
        )}
        <div className="config-proposal-actions">
          <button type="button" className="detail-action primary" onClick={() => void acceptProposal(proposal)} disabled={pending || !ready} title={ready ? undefined : NOT_READY_HINT}><Plus size={16} aria-hidden="true" /><span>Add</span></button>
          {!editing && <button type="button" className="detail-action" onClick={() => startEditing(proposal)}><Pencil size={15} aria-hidden="true" /><span>Edit</span></button>}
          <button type="button" className="config-remove" onClick={() => void dismissProposal(proposal.entityId)} title="Dismiss" aria-label={`Dismiss ${proposal.entityId}`}><X size={16} aria-hidden="true" /></button>
        </div>
      </div>
    )
  }

  async function handleSave() {
    if (!ready) return
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
    if (!ready || !resetConfirm.request()) return
    setPending(true)
    setMessage(null)
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
      <section ref={ref} className="detail-sheet glass-strong config-sheet" role="dialog" aria-modal="true" aria-labelledby="config-title" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" aria-hidden="true" />
        <header>
          <span className="detail-icon"><Wrench size={24} aria-hidden="true" /></span>
          <div><p>Home / Control</p><h2 id="config-title">Settings</h2></div>
          <button type="button" className="sheet-close" data-autofocus onClick={onClose} title="Close" aria-label="Close configuration"><X size={20} aria-hidden="true" /></button>
        </header>

        {!ready && tab !== 'theme' && (
          <p className={loadError ? 'detail-error' : 'config-waiting'} role="status">
            {loadError ? `Could not load the saved layout: ${loadError}. Saving is disabled so it cannot be overwritten.` : NOT_READY_HINT}
          </p>
        )}

        <div className="config-tabs glass-inset" role="tablist" aria-label="Configuration area" onKeyDown={tabListKeyHandler(configTabs, tab, setTab)}>
          {configTabs.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`config-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`config-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              className={tab === id ? 'active' : ''}
              onClick={() => setTab(id)}
            >
              {id === 'theme' && <><Palette size={16} aria-hidden="true" /> Theme</>}
              {id === 'tiles' && 'Dashboard tiles'}
              {id === 'discovery' && (
                <>
                  <PackagePlus size={16} aria-hidden="true" /> New devices
                  {discovery.proposals.length > 0 && <span className="config-tab-count">{discovery.proposals.length}</span>}
                </>
              )}
              {id === 'night-mode' && <><Moon size={16} aria-hidden="true" /> Night Mode lights</>}
            </button>
          ))}
        </div>

        {tab === 'theme' && (
          <div className="config-theme" role="tabpanel" id="config-panel-theme" aria-labelledby="config-tab-theme">
            <fieldset>
              <legend>Style</legend>
              <div className="theme-style-options">
                {styleOptions.map(({ id, label, Icon }) => (
                  <label className="theme-style-option" key={id}>
                    <input className="sr-only" type="radio" name="theme-style" value={id} checked={theme.style === id} onChange={() => updateTheme({ ...theme, style: id })} />
                    <Icon size={22} aria-hidden="true" />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Color palette</legend>
              <div className="theme-palette-options">
                {(Object.keys(themePalettes) as ThemePalette[]).map((id) => {
                  const palette = themePalettes[id]
                  return (
                    <label className="theme-palette-option" key={id}>
                      <input className="sr-only" type="radio" name="theme-palette" value={id} checked={theme.palette === id} onChange={() => updateTheme({ ...theme, palette: id })} />
                      <span className="theme-swatches" aria-hidden="true">
                        {[palette.canvas, palette.raised, palette.accent, palette.text].map((color) => <span key={color} style={{ backgroundColor: color }} />)}
                      </span>
                      <span>{palette.label}</span>
                      <Check className="theme-selected" size={18} aria-hidden="true" />
                    </label>
                  )
                })}
              </div>
            </fieldset>
            {(theme.palette === 'holidays' || theme.palette === 'halloween') && <label className="config-light-check theme-effects-toggle">
              <input type="checkbox" checked={theme.effects !== false} onChange={(event) => updateTheme({ ...theme, effects: event.target.checked })} />
              <span>Seasonal effects</span>
            </label>}
            <div className="config-footer">
              <button type="button" className="detail-action" onClick={() => updateTheme({ ...defaultTheme })}>
                <RotateCcw size={16} aria-hidden="true" /><span>Reset theme</span>
              </button>
            </div>
            <p className="theme-save-status" role="status">{themeMessage}</p>
          </div>
        )}

        {tab === 'tiles' && (
          <div className="config-tiles" role="tabpanel" id="config-panel-tiles" aria-labelledby="config-tab-tiles">
            <div
              className="config-section-pills"
              role="tablist"
              aria-label="Dashboard section"
              onKeyDown={tabListKeyHandler(editableSections.map((item) => item.id), activeSectionId, setActiveSectionId)}
            >
              {editableSections.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  id={`config-section-tab-${item.id}`}
                  aria-selected={item.id === activeSectionId}
                  aria-controls="config-section-panel"
                  tabIndex={item.id === activeSectionId ? 0 : -1}
                  className={item.id === activeSectionId ? 'active' : ''}
                  onClick={() => setActiveSectionId(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {activeSection && (
              <div role="tabpanel" id="config-section-panel" aria-labelledby={`config-section-tab-${activeSection.id}`}>
                <div className="config-tile-rows">
                  {activeSection.tiles.length === 0 && <p className="config-empty">No tiles in this section yet — add one below.</p>}
                  {activeSection.tiles.map((tile, index) => {
                    const TileIcon = icons[tile.icon] ?? Square
                    return (
                      <div className="config-tile-row" key={tile.entityId}>
                        <div className="config-tile-move">
                          <button type="button" onClick={() => moveTile(index, -1)} disabled={index === 0} aria-label={`Move ${tile.label} up`}><ArrowUp size={16} aria-hidden="true" /></button>
                          <button type="button" onClick={() => moveTile(index, 1)} disabled={index === activeSection.tiles.length - 1} aria-label={`Move ${tile.label} down`}><ArrowDown size={16} aria-hidden="true" /></button>
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
                        <button type="button" className="config-remove" onClick={() => removeTile(tile.entityId)} aria-label={`Remove ${tile.label}`} title="Remove tile"><Trash2 size={16} aria-hidden="true" /></button>
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
                  <button type="button" className="detail-action primary" onClick={addTile} disabled={!newTile.entityId.trim() || !newTile.label.trim()}><Plus size={16} aria-hidden="true" /><span>Add tile</span></button>
                </div>
                <datalist id="config-entity-suggestions">
                  {allEntityIds.map((entityId) => <option key={entityId} value={entityId} />)}
                </datalist>
              </div>
            )}
          </div>
        )}

        {tab === 'discovery' && (
          <div className="config-discovery" role="tabpanel" id="config-panel-discovery" aria-labelledby="config-tab-discovery">
            <p className="config-hint">
              Devices Home Assistant reports that no tile shows yet, with a suggested section, label and icon. Nothing is added
              until you say so — accepting one saves the dashboard configuration immediately.
            </p>
            {discovery.loading && <p className="config-empty">Looking for new devices…</p>}
            {!discovery.loading && discovery.proposals.length === 0 && discovery.needsReview.length === 0 && (
              <p className="config-empty">Nothing new — every device worth a tile already has one.</p>
            )}

            <div className="config-tile-rows">
              {discovery.proposals.map((proposal) => proposalRow(proposalEdits[proposal.entityId] ?? proposal))}
            </div>

            {discovery.needsReview.length > 0 && (
              <>
                <h3 className="config-subhead">Needs review · {discovery.needsReview.length}</h3>
                <p className="config-hint">
                  These did not match a rule confidently enough to place. Add one where it belongs, or dismiss it to stop being asked.
                </p>
                <div className="config-tile-rows">
                  {discovery.needsReview.map((entity) => {
                    const edited = proposalEdits[entity.entity_id]
                    if (edited) return proposalRow(edited)
                    return (
                      <div className="config-tile-row config-proposal-row" key={entity.entity_id}>
                        <span className="config-tile-icon"><Square size={16} aria-hidden="true" /></span>
                        <code className="config-entity-id" title={entity.entity_id}>{entity.entity_id}</code>
                        <span className="config-proposal-summary">{friendlyName(entity)}</span>
                        <div className="config-proposal-actions">
                          <button type="button" className="detail-action" onClick={() => startEditing(proposalFromEntity(entity))}><Plus size={16} aria-hidden="true" /><span>Place</span></button>
                          <button type="button" className="config-remove" onClick={() => void dismissProposal(entity.entity_id)} title="Dismiss" aria-label={`Dismiss ${entity.entity_id}`}><X size={16} aria-hidden="true" /></button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'night-mode' && (
          <div className="config-lights" role="tabpanel" id="config-panel-night-mode" aria-labelledby="config-tab-night-mode">
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
              <button type="button" className="detail-action" onClick={addManualLight} disabled={!manualLight.trim()}><ListPlus size={16} aria-hidden="true" /><span>Add by ID</span></button>
            </div>
          </div>
        )}

        {tab !== 'theme' && message && <p className={message.tone === 'error' ? 'detail-error' : 'config-success'} role="status">{message.text}</p>}
        {pending && <div className="detail-progress" role="status">Saving</div>}

        {tab !== 'theme' && <div className="config-footer">
          <button
            type="button"
            className={`detail-action ${resetConfirm.armed ? 'is-armed' : ''}`.trim()}
            onClick={() => void handleReset()}
            disabled={pending || !ready}
            title={ready ? undefined : NOT_READY_HINT}
          >
            <RotateCcw size={16} aria-hidden="true" /><span>{resetConfirm.armed ? 'Tap again to reset' : 'Reset to defaults'}</span>
          </button>
          <button type="button" className="detail-action primary" onClick={() => void handleSave()} disabled={pending || !ready} title={ready ? undefined : NOT_READY_HINT}>
            <Check size={16} aria-hidden="true" /><span>{ready ? 'Save changes' : NOT_READY_HINT}</span>
          </button>
        </div>}
      </section>
    </div>
  )
}
