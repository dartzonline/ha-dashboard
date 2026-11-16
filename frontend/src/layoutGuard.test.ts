import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Release 1.26.0 packed the Maintenance appliance cards with CSS multi-columns inside a fixed-height,
 * overflow-hidden box. The browser could not settle that layout: memory ran from ~300 MB to over 700 MB
 * in seconds and the page froze, which on the wall tablet meant Fully Kiosk was killed. Found by loading
 * the tab in a headless browser and watching the renderer's memory.
 */
describe('layouts that exhaust a tablet browser', () => {
  it('keeps CSS multi-columns off the appliance grid', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'MaintenanceView.css'), 'utf8')
    const rules = css.split('}').filter((rule) => rule.includes('.maint-grid') && !rule.trim().startsWith('/*'))
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) expect(rule, rule).not.toMatch(/column-width|column-count|[^-]columns\s*:/)
  })
})
