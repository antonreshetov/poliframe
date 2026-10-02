const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')
const { join, resolve } = require('node:path')
const { test } = require('node:test')

const { PreviewCache } = require(join(process.env.POLIFRAME_TEST_BUILD || resolve('build'), 'main/imaging/preview-cache.js'))

test('preview LRU reuses completed buffers and evicts within its byte budget', async () => {
  const cache = new PreviewCache(8)
  let reads = 0
  const read = () => {
    reads++
    return Promise.resolve(Buffer.alloc(4))
  }
  await cache.get('a', read)
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
  await assert.rejects(cache.get('failure', async () => {
    throw new Error('decode')
  }), /decode/)
  await cache.get('failure', read)
})
