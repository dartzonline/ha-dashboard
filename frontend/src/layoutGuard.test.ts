import { describe, expect, it } from 'vitest'
// Read as text by the bundler, so this needs no Node file APIs (the production build type-checks test files too).
import maintenanceCss from './MaintenanceView.css?inline'

/**
 * Release 1.26.0 packed the Maintenance appliance cards with CSS multi-columns inside a fixed-height,
 * overflow-hidden box. The browser could not settle that layout: memory ran from ~300 MB to over 700 MB
 * in seconds and the page froze, which on the wall tablet meant Fully Kiosk was killed. Found by loading
 * the tab in a headless browser and watching the renderer's memory.
 */
describe('layouts that exhaust a tablet browser', () => {
  it('keeps CSS multi-columns off the appliance grid', () => {
    const rules = maintenanceCss.split('}').filter((rule) => rule.includes('.maint-grid') && !rule.trim().startsWith('/*'))
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) expect(rule, rule).not.toMatch(/column-width|column-count|[^-]columns\s*:/)
  })
})
