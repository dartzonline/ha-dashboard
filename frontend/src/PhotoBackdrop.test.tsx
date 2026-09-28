import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PhotoBackdrop } from './PhotoBackdrop'
import { BACKDROP_SECTIONS, backdropPhotoFor } from './photoLibrary'

afterEach(cleanup)

const LIBRARY = ['a', 'b', 'c', 'd', 'e']

describe('backdropPhotoFor', () => {
  it('gives each chosen page a different picture', () => {
    const assigned = BACKDROP_SECTIONS.map((section) => backdropPhotoFor(section, LIBRARY))
    expect(new Set(assigned).size).toBe(BACKDROP_SECTIONS.length)
  })

  it('gives a page the same picture every time, so it does not flicker between renders', () => {
    expect(backdropPhotoFor('climate', LIBRARY)).toBe(backdropPhotoFor('climate', LIBRARY))
  })

  it('leaves the busy pages alone', () => {
    // The dense chart pages and the full-bleed map pages: a backdrop would fight their own content.
    for (const section of ['insights', 'energy', 'network', 'health', 'maintenance', 'volvo', 'world', 'flights', 'weather', 'home', 'roborock', 'photos']) {
      expect(backdropPhotoFor(section, LIBRARY), section).toBeNull()
    }
  })

  it('wraps a library smaller than the page list rather than leaving later pages blank', () => {
    const assigned = BACKDROP_SECTIONS.map((section) => backdropPhotoFor(section, ['only']))
    expect(assigned.every((id) => id === 'only')).toBe(true)
  })

  it('has nothing to show when no photos have been added', () => {
    expect(backdropPhotoFor('climate', [])).toBeNull()
  })
})

describe('PhotoBackdrop', () => {
  it('renders the assigned photo as decoration only', () => {
    render(<PhotoBackdrop sectionId="climate" photoIds={LIBRARY} />)
    const backdrop = document.querySelector('.photo-backdrop')
    expect(backdrop).toBeTruthy()
    // Purely decorative: it must not be announced, and must never intercept a tap meant for a tile.
    expect(backdrop!.getAttribute('aria-hidden')).toBe('true')
    expect(document.querySelector('.photo-backdrop img')!.getAttribute('alt')).toBe('')
  })

  it('serves the full image rather than the thumbnail, which would be visibly soft full-screen', () => {
    render(<PhotoBackdrop sectionId="climate" photoIds={LIBRARY} />)
    expect(document.querySelector('.photo-backdrop img')!.getAttribute('src')).toContain('/file')
  })

  it('renders nothing at all on a page that takes no backdrop', () => {
    render(<PhotoBackdrop sectionId="insights" photoIds={LIBRARY} />)
    expect(document.querySelector('.photo-backdrop')).toBeNull()
  })

  it('renders nothing when the library is empty, leaving the page exactly as it was', () => {
    render(<PhotoBackdrop sectionId="climate" photoIds={[]} />)
    expect(document.querySelector('.photo-backdrop')).toBeNull()
  })

  it('carries the requested style so the treatment can be changed in one place', () => {
    render(<PhotoBackdrop sectionId="climate" photoIds={LIBRARY} style="duotone" />)
    expect(document.querySelector('.photo-backdrop')!.className).toContain('style-duotone')
  })

  it('keeps the previous photo on screen until the next one has loaded, then cross-fades', () => {
    const { rerender } = render(<PhotoBackdrop sectionId="climate" photoIds={LIBRARY} />)
    const first = document.querySelector('.photo-backdrop img')!
    fireEvent.load(first)
    expect(first.className).toBe('is-current')

    rerender(<PhotoBackdrop sectionId="security" photoIds={LIBRARY} />)
    const images = Array.from(document.querySelectorAll('.photo-backdrop img'))
    // Old picture still showing underneath; the new one is on top but invisible until it loads.
    expect(images).toHaveLength(2)
    expect(images[0]).toBe(first)
    expect(images[0].className).toBe('is-current')
    expect(images[1].className).toBe('is-loading')

    fireEvent.load(images[1])
    expect(images[0].className).toBe('is-previous')
    expect(images[1].className).toBe('is-current')

    // Once the fade has finished, the old layer is dropped.
    // jsdom has no AnimationEvent, so React listens for the prefixed name there; send both.
    fireEvent.animationEnd(images[1])
    fireEvent(images[1], new Event('webkitAnimationEnd', { bubbles: true }))
    expect(document.querySelectorAll('.photo-backdrop img')).toHaveLength(1)
  })
})
