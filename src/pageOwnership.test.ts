import { expect, it, vi } from 'vitest'
import { PageOwnership } from './pageOwnership'

it('stays read-only when secure cross-page locks are unavailable', () => {
  const acquired = vi.fn(), released = vi.fn(), unavailable = vi.fn()
  const owner = new PageOwnership(undefined, acquired, released, unavailable)
  owner.start()
  expect(owner.available).toBe(false)
  expect(owner.isOwner).toBe(false)
  expect(acquired).not.toHaveBeenCalled()
})
