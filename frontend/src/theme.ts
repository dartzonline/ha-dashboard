export const THEME_STORAGE_KEY = 'home-panel.theme.v1'
export const themeStyles = ['modern', 'retro', 'hybrid'] as const
export type ThemeStyle = typeof themeStyles[number]

export const themePalettes = {
  halloween: { label: 'Halloween', canvas: '#17121b', canvas2: '#241b2b', panel: '#291f30', raised: '#382b3f', strong: '#1e1624', text: '#f5ecdf', muted: '#d3c0d5', muted2: '#bca6c4', border: '#665070', edge: '#a38baa', accent: '#ffb36b', highlight: '#ffd4a3', ink: '#301c0d' },
  holidays: { label: 'Holidays', canvas: '#101b18', canvas2: '#182b24', panel: '#1e3028', raised: '#2a3c32', strong: '#14251e', text: '#f4f1e7', muted: '#c6d3c9', muted2: '#a8beb0', border: '#4f6858', edge: '#8cab95', accent: '#f1b5b9', highlight: '#ffdadc', ink: '#30171c' },
  phosphor: { label: 'Phosphor', canvas: '#101413', canvas2: '#19201d', panel: '#1d2521', raised: '#2d3831', strong: '#151c18', text: '#edf2df', muted: '#b8c5b8', muted2: '#98aa9b', border: '#46554a', edge: '#81927f', accent: '#d0e779', highlight: '#e2efac', ink: '#17200d' },
  arctic: { label: 'Arctic', canvas: '#111719', canvas2: '#1a2327', panel: '#202b30', raised: '#303c42', strong: '#172024', text: '#e9f3f5', muted: '#bccdd1', muted2: '#a4b8bd', border: '#4a5e65', edge: '#829ca4', accent: '#7bd9e5', highlight: '#b5eef4', ink: '#102529' },
  ember: { label: 'Ember', canvas: '#191414', canvas2: '#241c1c', panel: '#2b2222', raised: '#3c3030', strong: '#201919', text: '#f8eeea', muted: '#d2bfba', muted2: '#bba5a0', border: '#654e4b', edge: '#a58b83', accent: '#f3a18e', highlight: '#ffd0ba', ink: '#301915' },
  lavender: { label: 'Lavender', canvas: '#192a51', canvas2: '#292d52', panel: '#242d48', raised: '#3c354f', strong: '#19223e', text: '#f5e6e8', muted: '#d5c6e0', muted2: '#aaa1c8', border: '#675776', edge: '#aaa1c8', accent: '#aaa1c8', highlight: '#d5c6e0', ink: '#192a51' },
} as const

export type ThemePalette = keyof typeof themePalettes
export interface ThemePreference { style: ThemeStyle; palette: ThemePalette; effects?: boolean }
export const defaultTheme: ThemePreference = { style: 'hybrid', palette: 'phosphor' }
let sessionTheme = { ...defaultTheme }
let storageWriteFailed = false

export function readTheme(): ThemePreference {
  if (storageWriteFailed) return { ...sessionTheme }
  try {
    const value: unknown = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? 'null')
    if (value && typeof value === 'object' && 'style' in value && 'palette' in value) {
      return {
        style: themeStyles.includes(value.style as ThemeStyle) ? value.style as ThemeStyle : defaultTheme.style,
        palette: typeof value.palette === 'string' && Object.hasOwn(themePalettes, value.palette) ? value.palette as ThemePalette : defaultTheme.palette,
        ...('effects' in value && typeof value.effects === 'boolean' ? { effects: value.effects } : {}),
      }
    }
  } catch { return { ...sessionTheme } }
  return { ...defaultTheme }
}

export function applyTheme(theme: ThemePreference) {
  storageWriteFailed = false
  sessionTheme = { ...theme }
  const root = document.documentElement
  const palette = themePalettes[theme.palette]
  root.dataset.themeStyle = theme.style
  root.dataset.themePalette = theme.palette
  root.dataset.themeEffects = theme.effects === false ? 'off' : 'on'
  const tokens = {
    canvas: palette.canvas, 'canvas-2': palette.canvas2,
    surface: palette.panel, 'surface-solid': palette.panel, 'surface-raised': palette.raised,
    'glass-bg': palette.panel, 'glass-bg-strong': palette.strong, 'glass-border': palette.border,
    text: palette.text, 'text-strong': palette.text, muted: palette.muted, 'muted-2': palette.muted2,
    border: palette.border, 'border-strong': palette.edge,
    accent: palette.accent, 'accent-strong': palette.highlight, 'accent-ink': palette.ink,
    'accent-soft': `color-mix(in srgb, ${palette.accent} 12%, transparent)`,
    'chart-grid': `color-mix(in srgb, ${palette.muted} 10%, transparent)`,
    'chart-axis': `color-mix(in srgb, ${palette.muted} 24%, transparent)`,
  }
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(`--${name}`, value)
}

export function saveTheme(theme: ThemePreference): boolean {
  applyTheme(theme)
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme))
    return true
  } catch {
    storageWriteFailed = true
    return false
  }
}