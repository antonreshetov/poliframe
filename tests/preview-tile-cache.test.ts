import assert from 'node:assert/strict'
import { afterEach, it, vi } from 'vitest'
import { PreviewTileCache } from '../src/renderer/composables/preview/tile-cache'

function tile(key: string) {
  return {
    key,
    x: 0,
    y: 0,
    width: 4,
    height: 4,
    pixelWidth: 4,
    pixelHeight: 4,
    data: new Uint8Array(16),
  }
}
function setup(budget = 300) {
  let next = 0
  const revoked: string[] = []
  const evicted: string[] = []
  const decode = vi.fn(() => Promise.resolve())
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++next}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url =>
    revoked.push(url),
  )
  vi.stubGlobal('window', {
    Image: class {
      src = ''
      naturalWidth = 4
      naturalHeight = 4
      decode = decode
    },
  })
  return {
    cache: new PreviewTileCache(key => evicted.push(key), budget),
    revoked,
    evicted,
    decode,
  }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('reuses decoded Blob URLs and revokes least-recently-used resources within the budget', async () => {
  const { cache, decode, revoked, evicted } = setup()
  const first = await cache.load([tile('a'), tile('b')], () => true)
  assert.equal(decode.mock.calls.length, 2)
  assert.equal(
    first![0]!.data,
    undefined,
    'published metadata never retains IPC bytes',
  )
  const again = await cache.load(
    [{ ...tile('a'), data: undefined }],
    () => true,
  )
  assert.equal(again![0]!.dataUrl, first![0]!.dataUrl)
  assert.equal(
    decode.mock.calls.length,
    2,
    'acknowledged tiles do not decode again',
  )
  await cache.load([tile('c')], () => true)
  assert.deepEqual(evicted, ['b'])
  assert.deepEqual(revoked, [first![1]!.dataUrl])
  assert.deepEqual(cache.keys(), ['a', 'c'])
  cache.clear()
  assert.equal(revoked.length, 3)
  assert.deepEqual(cache.keys(), [])
})

it('rejects an oversized batch before allocating and rolls back failed decodes', async () => {
  const { cache, decode, revoked } = setup()
  await assert.rejects(
    cache.load([tile('a'), tile('b'), tile('c')], () => true),
    /memory budget/,
  )
  assert.equal(decode.mock.calls.length, 0)
  assert.equal(URL.createObjectURL.mock.calls.length, 0)
  decode.mockRejectedValueOnce(new Error('decode failed'))
  await assert.rejects(
    cache.load([tile('a'), tile('b')], () => true),
    /decode failed/,
  )
  assert.equal(revoked.length, 2)
  assert.deepEqual(cache.keys(), [])
  await assert.rejects(
    cache.load([{ ...tile('a'), data: undefined }], () => true),
    /unavailable/,
  )
})

it('does not acknowledge or retain stale in-flight resources, and serializes replacements', async () => {
  const { cache, decode, revoked } = setup()
  await cache.load([tile('a')], () => true)
  let finish!: () => void
  decode.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  let current = true
  const loading = cache.load([tile('b')], () => current)
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(
    cache.keys(),
    ['a'],
    'pending decode must not be acknowledged',
  )
  current = false
  const replacement = cache.load(
    [{ ...tile('a'), data: undefined }, tile('c')],
    () => true,
  )
  finish()
  assert.equal(await loading, null)
  const result = await replacement
  assert.deepEqual(
    result!.map(item => item.key),
    ['a', 'c'],
  )
  assert.equal(revoked.length, 1)
  assert.deepEqual(cache.keys(), ['a', 'c'])
  cache.clear()
})
