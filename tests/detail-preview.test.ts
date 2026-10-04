import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { it } from 'vitest'
import { compose } from '../src/main/imaging/composition'
import { detailPreview } from '../src/main/imaging/detail-preview'
import { defaults, identityTransform } from '../src/shared/defaults'
import { calculateLayout } from '../src/shared/layout'

it('detail tiles match exact orientation, flips, crop and profile at native scale', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'poliframe-detail-'))
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const pixels = Buffer.from(
    Array.from({ length: 96 * 64 * 3 }, (_, i) => {
      const x = Math.floor(i / 3) % 96
      const y = Math.floor(i / 3 / 96)
      return i % 3 === 0 ? x * 2 : i % 3 === 1 ? y * 3 : 90
    }),
  )
  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const path = join(directory, `${orientation}.png`)
    await sharp(pixels, { raw: { width: 96, height: 64, channels: 3 } })
      .withMetadata({ orientation })
      .withIccProfile('p3')
      .png()
      .toFile(path)
    const asset = {
      id: 'photo',
      name: 'photo',
      path,
      thumbnail: '',
      exif: {},
      ...(await sharp(path).metadata()).autoOrient,
    }
    for (const [rotation, flipX] of [
      [0, false],
      [0, true],
      [90, true],
      [180, true],
      [270, true],
    ] as const) {
      for (const profile of ['srgb', 'p3'] as const) {
        const state = defaults()
        state.output.profile = profile
        state.panels = [
          {
            photoId: asset.id,
            transform: {
              ...identityTransform(),
              rotation,
              flipX,
              flipY: rotation === 180,
              crop: { x: 0.1, y: 0.1, width: 0.7, height: 0.75 },
            },
          },
        ]
        const layout = await calculateLayout(state, [asset])
        const region = {
          x: 0,
          y: 0,
          width: layout.width,
          height: layout.height,
        }
        const actual = await detailPreview(
          state,
          [asset],
          resolve('resources'),
          region,
          4096,
        )
        assert.ok(actual)
        assert.equal(actual.detailTiles!.length, 1)
        const { pipeline } = await compose(
          state,
          [asset],
          resolve('resources'),
          4096,
          region,
        )
        const expected = await pipeline
          .withIccProfile(profile)
          .toColourspace('srgb')
          .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
          .toBuffer()
        const raw = (data: Buffer) => sharp(data).raw().toBuffer()
        const a = await raw(
          Buffer.from(actual.detailTiles![0]!.dataUrl.split(',')[1]!, 'base64'),
        )
        const b = await raw(expected)
        assert.equal(a.length, b.length)
        const error
          = a.reduce((sum, value, i) => sum + Math.abs(value - b[i]!), 0)
            / a.length
        assert.ok(
          error < 2,
          `orientation ${orientation}, rotation ${rotation}, ${profile}: ${error}`,
        )
      }
    }
  }
})

it('fixed tiles cover cells, reuse overlapping pan pixels, invalidate content and bound viewport cost', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'poliframe-detail-cache-'))
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'photo.jpg')
  await sharp({
    create: { width: 2400, height: 1600, channels: 3, background: '#957361' },
  })
    .withIccProfile('srgb')
    .jpeg()
    .toFile(path)
  const asset = {
    id: 'photo',
    name: 'photo',
    path,
    thumbnail: '',
    exif: {},
    width: 2400,
    height: 1600,
  }
  const state = defaults()
  state.panels = [{ photoId: asset.id, transform: identityTransform() }]
  const first = await detailPreview(
    state,
    [asset],
    '',
    { x: 0, y: 0, width: 700, height: 700 },
    700,
  )
  const panned = await detailPreview(
    state,
    [asset],
    '',
    { x: 40, y: 40, width: 700, height: 700 },
    700,
  )
  assert.deepEqual(
    panned!.detailTiles,
    first!.detailTiles,
    'same fixed tiles, independent of viewport origin',
  )
  const crossed = await detailPreview(
    state,
    [asset],
    '',
    { x: 500, y: 0, width: 700, height: 700 },
    700,
  )
  assert.ok(
    crossed!.detailTiles!.some(tile =>
      first!.detailTiles!.some(
        old => old.key === tile.key && old.dataUrl === tile.dataUrl,
      ),
    ),
  )
  const full = await detailPreview(
    state,
    [asset],
    '',
    { x: 0, y: 0, width: 2400, height: 1600 },
    3200,
  )
  const area = full!.detailTiles!.reduce(
    (sum, tile) => sum + tile.width * tile.height,
    0,
  )
  assert.equal(area, 2400 * 1600)
  const cost = full!.detailTiles!.reduce(
    (sum, tile) =>
      sum + tile.pixelWidth * tile.pixelHeight * 8 + tile.dataUrl.length * 2,
    0,
  )
  assert.ok(cost <= 64 * 1024 * 1024)
  const native = await detailPreview(
    state,
    [asset],
    '',
    { x: 150, y: 150, width: 1800, height: 1440 },
    1800,
  )
  assert.ok(
    native!.detailTiles!.every(
      tile =>
        tile.pixelWidth === tile.width && tile.pixelHeight === tile.height,
    ),
    'normal desktop viewport retains native detail at 100%',
  )
  state.output.profile = 'p3'
  const profile = await detailPreview(
    state,
    [asset],
    '',
    { x: 0, y: 0, width: 700, height: 700 },
    700,
  )
  assert.notEqual(profile!.detailTiles![0]!.key, first!.detailTiles![0]!.key)
  await utimes(path, new Date(), new Date(Date.now() + 10000))
  const changed = await detailPreview(
    state,
    [asset],
    '',
    { x: 0, y: 0, width: 700, height: 700 },
    700,
  )
  assert.notEqual(changed!.detailTiles![0]!.key, profile!.detailTiles![0]!.key)
  await assert.rejects(
    detailPreview(
      state,
      [asset],
      '',
      { x: 2300, y: 0, width: 700, height: 700 },
      700,
    ),
    /Invalid preview region/,
  )
  state.caption.enabled = true
  assert.equal(
    await detailPreview(
      state,
      [asset],
      '',
      { x: 0, y: 0, width: 700, height: 700 },
      700,
    ),
    undefined,
  )
  state.caption.enabled = false
  state.watermark.photoId = asset.id
  assert.equal(
    await detailPreview(
      state,
      [asset],
      '',
      { x: 0, y: 0, width: 700, height: 700 },
      700,
    ),
    undefined,
  )
  state.watermark.photoId = null
  const alphaPath = join(directory, 'alpha.png')
  await sharp({
    create: {
      width: 2400,
      height: 1600,
      channels: 4,
      background: { r: 20, g: 30, b: 40, alpha: 0.5 },
    },
  })
    .png()
    .toFile(alphaPath)
  assert.equal(
    await detailPreview(
      state,
      [{ ...asset, path: alphaPath }],
      '',
      { x: 0, y: 0, width: 700, height: 700 },
      700,
    ),
    undefined,
  )
})
