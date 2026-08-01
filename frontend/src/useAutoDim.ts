import './AutoDim.css'
import type { HAEntity } from './types'

/**
 * Returns 'is-dimmed' when the sun has set (sun.sun state === 'below_horizon'),
 * or '' otherwise — including when the entity is absent/undefined. Apply the
 * returned class to a root element to get a comfortable night-mode dim.
 */
export function useAutoDim(entities: Map<string, HAEntity>): string {
  const sun = entities.get('sun.sun')
  return sun?.state === 'below_horizon' ? 'is-dimmed' : ''
}
