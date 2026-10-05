import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { it } from 'vitest'

import { PreviewCache } from '../src/main/imaging/preview-cache.ts'

it('preview LRU reuses completed buffers and evicts within its byte budget', async () => {
  const cache = new PreviewCache(8)
  let reads = 0
  const read = () => {
    reads++
    return Promise.resolve(Buffer.alloc(4))
  }
  assert.equal(cache.peek('missing'), undefined)
  await cache.get('a', read)
  assert.equal(cache.peek('a')?.byteLength, 4)
  await cache.get('b', read)
  await cache.get('a', read)
  await cache.get('c', read)
  assert.equal(reads, 3)
  await cache.get('a', read)
  await cache.get('b', read)
  assert.equal(reads, 4, 'least recently used entry is evicted')
  const huge = () => {
    reads++
    return Promise.resolve(Buffer.alloc(9))
  }
  await cache.get('huge', huge)
  await cache.get('huge', huge)
  assert.equal(reads, 6, 'oversized values are not retained')
  await assert.rejects(
    cache.get('failure', async () => {
      throw new Error('decode')
    }),
    /decode/,
  )
  await cache.get('failure', read)
})
