import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { afterAll as after, beforeAll as before, it } from 'vitest'
import {
  compose,
  gestureImages,
  transformImage,
} from '../src/main/imaging/composition.ts'

import {
  defaults,
  gridTemplate,
  identityTransform,
} from '../src/shared/defaults.ts'
import {
  calculateLayout,
  effectiveSize,
  parseOutputSize,
} from '../src/shared/layout.ts'

let dir, assets
const resources = resolve('resources')
function state(photos = assets) {
  const s = defaults()
  s.panels = photos.map(p => ({
    photoId: p.id,
    transform: identityTransform(),
  }))
  s.caption.sourceId = photos[0]?.id ?? null
  return s
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'poliframe-layout-'))
  assets = []
  for (const [i, color] of ['#ff0000', '#0000ff'].entries()) {
    const path = join(dir, `${i}.png`)
    await sharp({
      create: { width: 600, height: 400, channels: 3, background: color },
    })
      .png()
      .toFile(path)
    assets.push({
      id: String(i),
      name: `${i}.png`,
      path,
      width: 600,
      height: 400,
      thumbnail: '',
      exif: { camera: `Camera ${i}`, iso: `ISO ${100 + i}` },
    })
  }
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('strip geometry, fixed pixel margins and output sizes', async () => {
  const s = state()
  let layout = await calculateLayout(s, assets)
  assert.equal(layout.width, 1208)
  assert.equal(layout.height, 400)
  s.units = 'pixels'
  s.pixels.gap = 24
  s.pixels.frame = 10
  s.output.size = '640w'
  layout = await calculateLayout(s, assets)
  assert.equal(layout.width, 640)
  assert.equal(layout.cells[0].x, 10)
  assert.equal(
    layout.cells[1].x - layout.cells[0].x - layout.cells[0].width,
    24,
  )
  s.output.size = '100x'
  layout = await calculateLayout(s, assets)
  assert.equal(layout.cells[0].height, 1600)
  assert.deepEqual(parseOutputSize('bad'), { axis: 'native', value: 1 })
})

it('rotate and crop geometry and pixels follow rotate then flip then crop', async () => {
  const path = join(dir, 'corners.png')
  const raw = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0])
  await sharp(raw, { raw: { width: 2, height: 2, channels: 3 } })
    .png()
    .toFile(path)
  const asset = { ...assets[0], path, width: 2, height: 2 }
  const t = identityTransform()
  t.rotation = 90
  t.flipX = true
  t.crop = { x: 0, y: 0, width: 0.5, height: 0.5 }
  assert.deepEqual(effectiveSize(asset, t), { width: 1, height: 1 })
  const result = await transformImage(asset, t, 1, 1)
  const pixel = await sharp(result)
    .withIccProfile('srgb')
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer()
  assert.deepEqual([...pixel], [255, 0, 0])
})

it('recursive grid weights, holes and caption stay within chosen aspect', async () => {
  const s = state()
  s.layout = 'grid'
  s.gridAspect = '4:5'
  s.grid = gridTemplate('1+2', ['0', '1'])
  s.grid.weights = [2, 1]
  s.caption.enabled = true
  s.caption.perPhoto = true
  const layout = await calculateLayout(s, assets, async () => 24)
  assert.ok(Math.abs(layout.width / layout.height - 0.8) < 0.002)
  assert.equal(layout.cells.length, 3)
  assert.equal(layout.cells[2].photoId, null)
  assert.equal(layout.captions.length, 1)
  assert.ok(layout.cells[0].width > layout.cells[1].width * 1.9)
  assert.ok(
    layout.cells.every(c => c.y + c.height <= layout.captions[0].y + 0.01),
  )
})

it('print Fit and Fill retain source resolution while Grid uses paper DPI', async () => {
  const large = assets.map(p => ({ ...p, width: 6000, height: 4000 }))
  const s = state(large)
  s.print.enabled = true
  s.print.orientation = 'landscape'
  s.print.width = 40
  s.print.height = 30
  const fit = await calculateLayout(s, large)
  assert.equal(fit.width, 12080)
  assert.equal(fit.height, 9060)
  assert.ok(fit.dpi > 300)
  s.print.fit = 'fill'
  const fill = await calculateLayout(s, large)
  assert.equal(fill.width, 5333)
  assert.equal(fill.height, 4000)
  assert.equal(fill.dpi, 339)
  s.layout = 'grid'
  s.grid = gridTemplate('1x2', ['0', '1'])
  const grid = await calculateLayout(s, large)
  assert.equal(grid.width, 4724)
  assert.equal(grid.height, 3543)
})

it('caption height changes native output and preview returns full geometry', async () => {
  const s = state()
  s.caption.enabled = true
  s.caption.title = 'A title with & markup <escaped>'
  s.caption.copyright = '© Artist'
  const full = await compose(s, assets, resources)
  const preview = await compose(s, assets, resources, 320)
  assert.ok(full.layout.height > 400)
  assert.deepEqual(preview.layout, full.layout)
  const info = await preview.pipeline
    .png()
    .toBuffer({ resolveWithObject: true })
  assert.equal(info.info.width, 320)
  assert.ok(info.info.height > 100)
})

for (const style of [
  'studio',
  'retro',
  'editorial',
  'museum',
  'minimal',
  'classic',
  'luxe',
]) {
  it(`bundled caption style ${style} renders`, async () => {
    const s = state([assets[0]])
    s.caption.enabled = true
    s.caption.title = 'Poliframe'
    s.caption.copyright = '© Artist'
    s.caption.style = style
    const { pipeline, layout } = await compose(s, assets, resources, 300)
    const result = await pipeline.png().toBuffer()
    assert.ok(result.length > 1000)
    assert.equal(layout.captions.length, 1)
    assert.ok(layout.captions[0].height > 0)
  })
}

it('16-bit ramp survives transform and native composition', async () => {
  const width = 1024
  const path = join(dir, 'ramp.png')
  const pixels = Uint16Array.from({ length: width * 3 }, (_, i) =>
    Math.round((Math.floor(i / 3) * 65535) / (width - 1)))
  await sharp(pixels, { raw: { width, height: 1, channels: 3 } })
    .toColourspace('rgb16')
    .png()
    .toFile(path)
  const asset = { ...assets[0], path, width, height: 1 }
  const s = state([asset])
  s.percent.gap = 0
  const { pipeline } = await compose(s, [asset], resources)
  const data = await pipeline.removeAlpha().raw({ depth: 'ushort' }).toBuffer()
  const values = new Set()
  for (let x = 0; x < width; x++) values.add(data.readUInt16LE(x * 6))
  assert.ok(
    values.size > 900,
    `composition reduced precision to ${values.size} levels`,
  )
})

it('watermark preserves source alpha and multiplies opacity', async () => {
  const path = join(dir, 'logo.png')
  await sharp({
    create: {
      width: 10,
      height: 10,
      channels: 4,
      background: { r: 0, g: 255, b: 0, alpha: 0.5 },
    },
  })
    .png()
    .toFile(path)
  const logo = { ...assets[0], id: 'logo', path, width: 10, height: 10 }
  const s = state([assets[0]])
  s.watermark = { photoId: 'logo', size: 20, opacity: 50, position: 'center' }
  const { pipeline } = await compose(s, [...assets, logo], resources)
  const raw = await pipeline
    .removeAlpha()
    .withIccProfile('srgb')
    .toColourspace('srgb')
    .raw()
    .toBuffer()
  const offset = (200 * 600 + 300) * 3
  assert.ok(raw[offset] > 170 && raw[offset] < 230, `red ${raw[offset]}`)
  assert.ok(
    raw[offset + 1] > 40 && raw[offset + 1] < 110,
    `green ${raw[offset + 1]}`,
  )
  assert.ok(raw[offset + 2] < 20)
})

it('watermark beyond the canvas clips without stretching or encoder errors', async () => {
  const path = join(dir, 'tall-logo.png')
  await sharp({
    create: { width: 10, height: 100, channels: 4, background: '#00ff00' },
  })
    .png()
    .toFile(path)
  const logo = { ...assets[0], id: 'tall-logo', path, width: 10, height: 100 }
  const s = state([assets[0]])
  s.watermark = { photoId: logo.id, size: 60, opacity: 50, position: 'center' }
  const { pipeline } = await compose(s, [...assets, logo], resources, 200)
  const result = await pipeline.png().toBuffer({ resolveWithObject: true })
  assert.equal(result.info.width, 200)
  assert.equal(result.info.height, 133)
})

it('small Fill sources do not upscale, and minimum output remains renderable', async () => {
  const s = state()
  s.print.enabled = true
  s.print.fit = 'fill'
  s.print.orientation = 'landscape'
  const fill = await calculateLayout(s, assets)
  assert.ok(fill.height <= 400)
  assert.ok(fill.dpi < 300)
  s.print.enabled = false
  s.output.size = '1w'
  s.caption.enabled = true
  s.caption.title = 'tiny'
  const { pipeline } = await compose(s, assets, resources)
  const result = await pipeline.png().toBuffer({ resolveWithObject: true })
  assert.ok(result.info.width >= 1)
})

it('full render budget rejects oversized canvas while preview remains bounded', async () => {
  const huge = assets.map(p => ({ ...p, width: 20000, height: 20000 }))
  const s = state(huge)
  await assert.rejects(compose(s, huge, resources), /budget/)
  const { pipeline, layout } = await compose(s, huge, resources, 200)
  assert.ok(layout.warnings.length)
  assert.equal(
    (await pipeline.png().toBuffer({ resolveWithObject: true })).info.width,
    200,
  )
})

it('region render matches the same full-resolution composition crop', async () => {
  const s = state()
  s.caption.enabled = true
  s.caption.title = 'Region text'
  s.caption.copyright = '© Artist'
  const full = await compose(s, assets, resources)
  const encoded = await full.pipeline.png().toBuffer()
  const region = {
    x: 540,
    y: 380,
    width: 160,
    height: Math.min(80, full.layout.height - 380),
  }
  const detail = await compose(s, assets, resources, 3200, region)
  assert.deepEqual(detail.layout, full.layout)
  const crop = await sharp(encoded)
    .extract({
      left: region.x,
      top: region.y,
      width: region.width,
      height: region.height,
    })
    .toColourspace('rgb16')
    .raw({ depth: 'ushort' })
    .toBuffer()
  const actual = await detail.pipeline.raw({ depth: 'ushort' }).toBuffer()
  assert.deepEqual(actual, crop)
})

it('tagged and untagged sRGB 8/16-bit sources preserve the same visible saturated colors', async () => {
  const colors = Buffer.from([250, 64, 28, 18, 240, 100, 48, 96, 255])
  const variants = [
    [
      'untagged8',
      await sharp(colors, { raw: { width: 3, height: 1, channels: 3 } })
        .png()
        .toBuffer(),
    ],
    [
      'tagged8',
      await sharp(colors, { raw: { width: 3, height: 1, channels: 3 } })
        .withIccProfile('srgb')
        .png()
        .toBuffer(),
    ],
    [
      'tagged16',
      await sharp(colors, { raw: { width: 3, height: 1, channels: 3 } })
        .toColourspace('rgb16')
        .withIccProfile('srgb')
        .png()
        .toBuffer(),
    ],
    [
      'p3',
      await sharp(colors, { raw: { width: 3, height: 1, channels: 3 } })
        .toColourspace('rgb16')
        .withIccProfile('p3')
        .png()
        .toBuffer(),
    ],
  ]
  const untagged16 = await sharp(variants[2][1], { ignoreIcc: true })
    .toColourspace('rgb16')
    .png()
    .toBuffer()
  variants.push(['untagged16', untagged16])
  for (const [name, data] of variants) {
    const path = join(dir, `${name}.png`)
    await (await import('node:fs/promises')).writeFile(path, data)
    const asset = { ...assets[0], path, width: 3, height: 1 }
    const s = state([asset])
    const { pipeline } = await compose(s, [asset], resources)
    const actual = await pipeline
      .withIccProfile('srgb')
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer()
    for (let i = 0; i < colors.length; i++) {
      assert.ok(
        Math.abs(actual[i] - colors[i]) <= 2,
        `${name} sample ${i}: ${actual[i]} != ${colors[i]}`,
      )
    }
  }
})

it('gesture photos preserve transformed source aspect instead of the old grid cell crop', async () => {
  const s = state()
  s.layout = 'grid'
  s.grid = gridTemplate(
    '2x2',
    assets.map(a => a.id),
  )
  s.panels[0].transform.rotation = 90
  s.panels[0].transform.crop = { x: 0.1, y: 0.1, width: 0.8, height: 0.5 }
  const before = await gestureImages(s, assets)
  const effective = effectiveSize(assets[0], s.panels[0].transform)
  assert.equal(
    before[0].width / before[0].height,
    effective.width / effective.height,
  )
  s.grid.children[0].weights = [0.8, 0.2]
  const after = await gestureImages(s, assets)
  assert.deepEqual(
    after,
    before,
    'divider movement must not crop or re-encode the gesture source',
  )
  const image = await sharp(
    Buffer.from(before[0].dataUrl.split(',')[1], 'base64'),
  ).metadata()
  assert.equal(image.width, before[0].width)
  assert.equal(image.height, before[0].height)
})

it('preview cache invalidates when an imported file changes on disk', async () => {
  const path = join(dir, 'mutable.png')
  const write = color =>
    sharp({ create: { width: 60, height: 40, channels: 3, background: color } })
      .png()
      .toFile(path)
  await write('#ff0000')
  const photo = { ...assets[0], path, width: 60, height: 40 }
  const s = state([photo])
  const first = await compose(s, [photo], resources, 100)
  const red = await first.pipeline.raw().toBuffer()
  await write('#0000ff')
  const second = await compose(s, [photo], resources, 100)
  const blue = await second.pipeline.raw().toBuffer()
  assert.notDeepEqual(blue, red)
})

it('fill matches native source DPI and respects explicit output sizing', async () => {
  const photos = [{ ...assets[0], width: 7563, height: 5042 }]
  const s = state(photos)
  s.print.enabled = true
  s.print.fit = 'fill'
  s.print.orientation = 'landscape'
  s.print.width = 15
  s.print.height = 21
  const full = await calculateLayout(s, photos)
  assert.equal(full.width, 7059)
  assert.equal(full.height, 5042)
  assert.equal(full.dpi, 854)
  s.output.size = '2x'
  const doubled = await calculateLayout(s, photos)
  assert.equal(doubled.height, 10084)
  s.output.size = '2100w'
  const sized = await calculateLayout(s, photos)
  assert.equal(sized.width, 2100)
  assert.equal(sized.height, 1500)
  assert.equal(sized.dpi, 254)
})
