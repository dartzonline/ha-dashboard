import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearCachedJson } from './cachedFetch'
import type { HAEntity } from './types'
import { primeIgnoredEntityIds, useEntityDiscovery } from './useEntityDiscovery'

function light(entityId: string): HAEntity {
  return { entity_id: entityId, state: 'on', attributes: { friendly_name: entityId }, last_changed: '', last_updated: '' }
}

const REGISTRY = { entities: {}, areas: {} }

afterEach(() => {
  clearCachedJson()
  vi.unstubAllGlobals()
})

describe('useEntityDiscovery.dismiss', () => {
  it('hides the entity immediately and puts it back if the save is refused', async () => {
    primeIgnoredEntityIds([])
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ detail: 'read-only' }) } as Response)
      return Promise.resolve({ ok: true, json: () => Promise.resolve(String(input).includes('registry') ? REGISTRY : { ignoredEntityIds: [] }) } as Response)
    }))
    const entities = new Map([['light.new', light('light.new')]])
    const { result } = renderHook(() => useEntityDiscovery(entities, []))
    await waitFor(() => expect(result.current.proposals.map((item) => item.entityId)).toEqual(['light.new']))

    let failure: unknown
    await act(async () => {
      await result.current.dismiss('light.new').catch((error: unknown) => { failure = error })
    })
    expect((failure as Error).message).toBe('read-only')
    expect(result.current.proposals.map((item) => item.entityId)).toEqual(['light.new'])
  })

  it('keeps the entity dismissed once the server confirms', async () => {
    primeIgnoredEntityIds([])
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return Promise.resolve({ ok: true, json: () => Promise.resolve({ ignoredEntityIds: JSON.parse(String(init.body)).ignoredEntityIds }) } as Response)
      return Promise.resolve({ ok: true, json: () => Promise.resolve(String(input).includes('registry') ? REGISTRY : { ignoredEntityIds: [] }) } as Response)
    }))
    const entities = new Map([['light.new', light('light.new')]])
    const { result } = renderHook(() => useEntityDiscovery(entities, []))
    await waitFor(() => expect(result.current.proposals).toHaveLength(1))

    await act(async () => { await result.current.dismiss('light.new') })
    expect(result.current.proposals).toHaveLength(0)
  })
})
