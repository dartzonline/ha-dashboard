import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhotosView } from './PhotosView'
import type { Photo } from './PhotosView'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function photo(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 'photo_1',
    originalName: 'sunset.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 120_000,
    originalBytes: 3_500_000,
    width: 2048,
    height: 1536,
    addedAt: '2026-08-23T12:00:00Z',
    sourceUrl: null,
    position: 0,
    ...overrides,
  }
}

/** Serves the library and records every non-GET call, which is what the assertions inspect. */
function mockApi(library: Photo[]) {
  const calls: { url: string; method: string; body?: unknown }[] = []
  let current = [...library]

  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method !== 'GET') {
      calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body })
    }
    if (url.includes('photos/order') && method === 'POST') {
      const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids
      current = ids.map((id) => current.find((item) => item.id === id)!).filter(Boolean)
      return Promise.resolve({ ok: true, json: () => Promise.resolve(current) } as Response)
    }
    if (method === 'DELETE') {
      current = current.filter((item) => !url.endsWith(item.id))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ deleted: true }) } as Response)
    }
    if (method === 'POST') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(photo({ id: 'photo_new' })) } as Response)
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(current) } as Response)
  })

  vi.stubGlobal('fetch', fetchMock)
  return calls
}

describe('PhotosView', () => {
  it('shows each photo as a thumbnail rather than downloading the full image', async () => {
    mockApi([photo()])
    render(<PhotosView />)

    const image = await screen.findByAltText('sunset.jpg')
    expect(image.getAttribute('src')).toContain('photos/photo_1/thumb')
  })

  it('says how much processing saved, which is the only visible evidence it happened', async () => {
    mockApi([photo()])
    render(<PhotosView />)

    expect(await screen.findByText(/2048×1536/)).toBeTruthy()
    expect(screen.getByText(/from 3\.3 MB/)).toBeTruthy()
  })

  it('invites the first upload rather than showing an empty grid', async () => {
    mockApi([])
    render(<PhotosView />)
    expect(await screen.findByText(/No photos yet/)).toBeTruthy()
  })

  it('deletes a photo only on a second tap', async () => {
    const calls = mockApi([photo()])
    render(<PhotosView />)

    fireEvent.click(await screen.findByLabelText('Remove sunset.jpg'))
    // First tap arms it and says so, in place of a browser dialog a kiosk may suppress.
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByLabelText('Tap again to remove sunset.jpg'))
    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true))
  })

  it('a single tap leaves the photo alone and disarms on its own', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const calls = mockApi([photo()])
    render(<PhotosView />)

    fireEvent.click(await screen.findByLabelText('Remove sunset.jpg'))
    expect(screen.getByText('Tap again')).toBeTruthy()
    await act(async () => { vi.advanceTimersByTime(4_100) })
    expect(screen.getByLabelText('Remove sunset.jpg')).toBeTruthy()
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    vi.useRealTimers()
  })

  it('never uses a blocking browser dialog', async () => {
    mockApi([photo()])
    const confirm = vi.spyOn(window, 'confirm')
    render(<PhotosView />)
    fireEvent.click(await screen.findByLabelText('Remove sunset.jpg'))
    expect(confirm).not.toHaveBeenCalled()
  })

  it('sends the whole new order when a photo is moved', async () => {
    const calls = mockApi([photo({ id: 'a', originalName: 'a.jpg' }), photo({ id: 'b', originalName: 'b.jpg' })])
    render(<PhotosView />)

    fireEvent.click(await screen.findByLabelText('Move b.jpg earlier'))
    await waitFor(() => {
      const order = calls.find((call) => call.url.includes('photos/order'))
      expect((order?.body as { ids: string[] })?.ids).toEqual(['b', 'a'])
    })
  })

  it('cannot move the first photo earlier or the last one later', async () => {
    mockApi([photo({ id: 'a', originalName: 'a.jpg' }), photo({ id: 'b', originalName: 'b.jpg' })])
    render(<PhotosView />)

    expect((await screen.findByLabelText('Move a.jpg earlier')).hasAttribute('disabled')).toBe(true)
    expect(screen.getByLabelText('Move b.jpg later').hasAttribute('disabled')).toBe(true)
  })

  it('reports a failed upload against the file that failed rather than silently doing nothing', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({ detail: 'Unsupported image type' }) } as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as Response)
    }))
    render(<PhotosView />)

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['x'], 'notes.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file] })
    fireEvent.change(input)

    expect(await screen.findByText(/notes\.png: Unsupported image type/)).toBeTruthy()
  })

  it('refuses a dropped file that is not an image', async () => {
    mockApi([])
    render(<PhotosView />)
    await screen.findByText(/No photos yet/)

    const view = document.querySelector('.photos-view')!
    fireEvent.drop(view, { dataTransfer: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] } })
    expect(await screen.findByText(/not images/)).toBeTruthy()
  })

  it('adds an image from a pasted web address', async () => {
    const calls = mockApi([])
    render(<PhotosView />)
    await screen.findByText(/No photos yet/)

    fireEvent.change(screen.getByPlaceholderText(/paste an image address/), {
      target: { value: 'https://example.com/pic.jpg' },
    })
    fireEvent.click(screen.getByText('Add'))

    await waitFor(() => {
      const call = calls.find((item) => item.url.includes('photos/url'))
      expect((call?.body as { url: string })?.url).toBe('https://example.com/pic.jpg')
    })
  })
})
