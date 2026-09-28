import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDialog } from './useDialog'

afterEach(cleanup)

function Sheet({ onClose }: { onClose: () => void }) {
  const ref = useDialog<HTMLDivElement>({ onClose })
  return <div ref={ref} role="dialog" data-testid="sheet"><button type="button" data-autofocus>Close</button></div>
}

function Shell({ open, inside, railInert = false }: { open: boolean; inside: boolean; railInert?: boolean }) {
  return (
    <>
      <aside data-dialog-background data-testid="rail" inert={railInert}>rail</aside>
      <main data-dialog-background data-testid="main">
        <header data-testid="header">header</header>
        <section data-testid="page">{open && inside && <Sheet onClose={() => {}} />}</section>
        <footer data-testid="footer">footer</footer>
      </main>
      {open && !inside && <Sheet onClose={() => {}} />}
    </>
  )
}

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!

describe('useDialog background handling', () => {
  it('makes every background region inert while a sheet is open, and restores it after', () => {
    const { rerender } = render(<Shell open inside={false} />)
    expect(byId('main').hasAttribute('inert')).toBe(true)
    expect(byId('rail').hasAttribute('inert')).toBe(true)
    rerender(<Shell open={false} inside={false} />)
    expect(byId('main').hasAttribute('inert')).toBe(false)
    expect(byId('rail').hasAttribute('inert')).toBe(false)
  })

  it('leaves a sheet rendered inside a background region usable, inerting only what surrounds it', () => {
    render(<Shell open inside />)
    expect(byId('main').hasAttribute('inert')).toBe(false)
    expect(byId('sheet').hasAttribute('inert')).toBe(false)
    expect(byId('page').hasAttribute('inert')).toBe(false)
    expect(byId('header').hasAttribute('inert')).toBe(true)
    expect(byId('footer').hasAttribute('inert')).toBe(true)
    expect(byId('rail').hasAttribute('inert')).toBe(true)
  })

  it('hands back an element that was already inert on its own instead of forcing it live', () => {
    const { rerender } = render(<Shell open inside={false} railInert />)
    rerender(<Shell open={false} inside={false} railInert />)
    expect(byId('rail').hasAttribute('inert')).toBe(true)
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<Sheet onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
