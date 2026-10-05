import assert from 'node:assert/strict'
import { afterEach, it, vi } from 'vitest'
import {
  PreviewTileCache,
  tileSurface,
} from '../src/renderer/composables/preview/tile-cache'

function tile(key: string) {
  return {
    key,
    x: 0,
    y: 0,
    width: 4,
    height: 4,
    cellId: 'cell',
    pixelWidth: 4,
    pixelHeight: 4,
    data: new Uint8Array(16),
  }
}
function setup(budget = 300) {
  const closed: string[] = []
  const evicted: string[] = []
  let count = 0
  const decode = vi.fn(async () => {
    const id = String(++count)
    return { width: 4, height: 4, close: () => closed.push(id) }
  })
  vi.stubGlobal('createImageBitmap', decode)
  return {
    cache: new PreviewTileCache(key => evicted.push(key), budget),
    closed,
    evicted,
    decode,
  }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('reuses decoded bitmaps and closes least-recently-used resources within the budget', async () => {
  const { cache, decode, closed, evicted } = setup()
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
  assert.equal(again![0]!.bitmap, first![0]!.bitmap)
  assert.equal(
    decode.mock.calls.length,
    2,
    'acknowledged tiles do not decode again',
  )
  await cache.load([tile('c')], () => true)
  assert.deepEqual(evicted, ['b'])
  assert.deepEqual(closed, ['2'])
  assert.deepEqual(cache.keys(), ['a', 'c'])
  cache.clear()
  assert.equal(closed.length, 3)
  assert.deepEqual(cache.keys(), [])
})

it('rejects an oversized batch before allocating and rolls back failed decodes', async () => {
  const { cache, decode, closed } = setup()
  await assert.rejects(
    cache.load([tile('a'), tile('b'), tile('c')], () => true),
    /memory budget/,
  )
  assert.equal(decode.mock.calls.length, 0)
  decode.mockResolvedValueOnce({
    width: 4,
    height: 4,
    close: () => closed.push('partial'),
  })
  decode.mockRejectedValueOnce(new Error('decode failed'))
  await assert.rejects(
    cache.load([tile('a'), tile('b')], () => true),
    /decode failed/,
  )
  assert.deepEqual(closed, ['partial'])
  assert.deepEqual(cache.keys(), [])
  await assert.rejects(
    cache.load([{ ...tile('a'), data: undefined }], () => true),
    /unavailable/,
  )
})

it('does not acknowledge or retain stale in-flight resources, and serializes replacements', async () => {
  const { cache, decode, closed } = setup()
  await cache.load([tile('a')], () => true)
  let finish!: (bitmap: {
    width: number
    height: number
    close: () => void
  }) => void
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
  finish({ width: 4, height: 4, close: () => closed.push('pending') })
  assert.equal(await loading, null)
  const result = await replacement
  assert.deepEqual(
    result!.map(item => item.key),
    ['a', 'c'],
  )
  assert.equal(closed.length, 1)
  assert.deepEqual(cache.keys(), ['a', 'c'])
  cache.clear()
})

it('closes bitmaps decoded after clear and rejects unexpectedly large canvas surfaces', async () => {
  const { cache, decode, closed } = setup()
  let finish!: (bitmap: {
    width: number
    height: number
    close: () => void
  }) => void
  decode.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const loading = cache.load([tile('a')], () => true)
  await Promise.resolve()
  cache.clear()
  finish({ width: 4, height: 4, close: () => closed.push('late') })
  assert.equal(await loading, null)
  assert.deepEqual(closed, ['late'])
  assert.deepEqual(cache.keys(), [])
  await assert.rejects(
    cache.load([tile('b'), { ...tile('c'), x: 10_000_000 }], () => true),
    /surfaces exceed/,
  )
  assert.equal(decode.mock.calls.length, 1)
})

it('maps fractional cell geometry to an exact integer tile surface', () => {
  const first = {
    ...tile('a'),
    x: 100 / 3,
    y: 200 / 3,
    width: 4 / 0.99,
    height: 4 / 0.98,
  }
  const second = { ...first, key: 'b', x: first.x + first.width }
  const surface = tileSurface([first, second])
  assert.equal(surface.pixelWidth, 8)
  assert.equal(surface.pixelHeight, 4)
  assert.equal(Math.round((second.x - surface.x) * surface.xScale), 4)
})
