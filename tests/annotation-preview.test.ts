import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { it, onTestFinished } from 'vitest'

import { annotationPreview } from '../src/main/imaging/annotations.ts'
import { compose, gesturePreview } from '../src/main/imaging/composition.ts'
import { defaults, identityTransform } from '../src/shared/defaults.ts'

it('layered annotation preview preserves native caption geometry for every preset', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'poliframe-caption-'))
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'photo.jpg')
  await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: '#8090a0' },
  })
    .jpeg()
    .toFile(path)
  const photo = {
    id: 'photo',
    path,
    width: 3000,
    height: 2000,
    name: 'photo.jpg',
    exif: { camera: 'Camera', lens: 'Lens', iso: 'ISO 200' },
  }
  const state = defaults()
  state.panels = [{ photoId: photo.id, transform: identityTransform() }]
  state.caption.enabled = true
  state.caption.sourceId = photo.id
  state.caption.title = 'A caption with Кириллица'
  state.caption.copyright = '© Photographer'
  for (const style of [
    'studio',
    'retro',
    'editorial',
    'museum',
    'minimal',
    'classic',
    'luxe',
  ]) {
    state.caption.style = style
    const layered = await annotationPreview(
      state,
      [photo],
      resolve('resources'),
      1200,
    )
    const native = await compose(state, [photo], resolve('resources'), 1200)
    assert.deepEqual(layered.layout, native.layout, style)
    assert.ok(layered.annotationLayers.length > 0)
    assert.equal(layered.dataUrl, '')
    assert.equal(layered.gestureImages.length, 1)
    assert.equal(
      (
        await gesturePreview(state, [photo], layered.gestureImagesKey, {
          layout: layered.layout,
          maxSize: 1200,
        })
      ).gestureImages,
      undefined,
    )
    const full = await annotationPreview(
      state,
      [photo],
      resolve('resources'),
      100000,
    )
    for (const layer of layered.annotationLayers) {
      assert.ok(layer.width > 0 && layer.height > 0)
      assert.match(layer.dataUrl, /^data:image\/png;base64,/)
      const original
        = full.annotationLayers[layered.annotationLayers.indexOf(layer)]
      const pixels = Buffer.from(layer.dataUrl.split(',')[1], 'base64')
      const info = await sharp(pixels).metadata()
      const expected = await sharp(
        Buffer.from(original.dataUrl.split(',')[1], 'base64'),
      )
        .resize(info.width, info.height, { fit: 'fill' })
        .extractChannel('alpha')
        .raw()
        .toBuffer()
      assert.deepEqual(
        await sharp(pixels).extractChannel('alpha').raw().toBuffer(),
        expected,
        `${style}: scaled text preserves both edges`,
      )
    }
  }
  state.caption.style = 'studio'
  const elapsed = []
  for (let i = 1; i <= 10; i++) {
    state.percent.captionTop = i
    const start = performance.now()
    await annotationPreview(state, [photo], resolve('resources'), 1200)
    elapsed.push(performance.now() - start)
  }
  // eslint-disable-next-line no-console
  console.info(
    `Warm caption padding preview median: ${elapsed.sort((a, b) => a - b)[5].toFixed(1)} ms`,
  )
  for (const field of ['size', 'title']) {
    const samples = []
    for (let i = 1; i <= 10; i++) {
      state.caption[field]
        = field === 'size' ? 80 + i : `Caption ${'a'.repeat(i)}`
      const start = performance.now()
      await annotationPreview(state, [photo], resolve('resources'), 1200)
      samples.push(performance.now() - start)
    }
    // eslint-disable-next-line no-console
    console.info(
      `Caption ${field} median: ${samples.sort((a, b) => a - b)[5].toFixed(1)} ms`,
    )
  }
  state.watermark = {
    photoId: photo.id,
    size: 20,
    opacity: 35,
    position: 'bottomRight',
  }
  const marked = await annotationPreview(
    state,
    [photo],
    resolve('resources'),
    1200,
  )
  assert.equal(marked.annotationLayers.at(-1).opacity, 0.35)
  const plain = structuredClone(state)
  plain.watermark.photoId = null
  assert.deepEqual(
    marked.layout,
    (await compose(plain, [photo], resolve('resources'), 1200)).layout,
  )
})

it('caption lines reuse unchanged pixels while isolating font, color, width, scale and working depth', async () => {
  const { createCaptionRenderer }
    = await import('../src/main/imaging/captions.ts')
  const state = defaults()
  state.caption.style = 'studio'
  state.caption.title = 'First title'
  state.caption.copyright = 'Photographer'
  state.caption.showExif = true
  state.caption.fields = ['camera', 'iso']
  const photo = {
    id: 'line-photo',
    name: 'photo',
    width: 300,
    height: 200,
    exif: { camera: 'Camera model with a long name', iso: 'ISO 200' },
  }
  const assets = new Map([[photo.id, photo]])
  const render = (width = 600, scale = 1, preview = true) =>
    createCaptionRenderer(
      state,
      assets,
      resolve('resources'),
      preview,
    )(photo.id, width, scale)
  const first = await render()
  assert.equal(first.pieces.length, 4)
  state.caption.title = 'Another title'
  const edited = await render()
  assert.notEqual(edited.pieces[0].input, first.pieces[0].input)
  for (let i = 1; i < first.pieces.length; i++) {
    assert.equal(
      edited.pieces[i].input,
      first.pieces[i].input,
      'unchanged line reuses its buffer',
    )
  }
  const narrow = await render(120)
  assert.notDeepEqual(narrow.pieces[1].input, edited.pieces[1].input)
  const larger = await render(600, 2)
  assert.notDeepEqual(larger.pieces[1].input, edited.pieces[1].input)
  state.mat = '#101010'
  const dark = await render()
  assert.notDeepEqual(dark.pieces[1].input, edited.pieces[1].input)
  state.caption.style = 'retro'
  const retro = await render()
  assert.notDeepEqual(retro.pieces[0].input, dark.pieces[1].input)
  const working = await render(600, 1, false)
  assert.equal(
    (await sharp(working.pieces[0].input).metadata()).depth,
    'ushort',
  )
  assert.equal((await sharp(retro.pieces[0].input).metadata()).format, 'png')
  for (const result of [first, edited, narrow, larger, dark, retro, working]) {
    for (const piece of result.pieces) {
      const info = await sharp(piece.input).metadata()
      assert.equal(piece.width, info.width)
      assert.equal(piece.height, info.height)
    }
  }
})

it('scene without annotations publishes photo layers without a composed JPEG', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'poliframe-scene-'))
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'photo.png')
  await sharp({
    create: { width: 80, height: 60, channels: 3, background: '#906030' },
  })
    .png()
    .toFile(path)
  const photo = {
    id: 'photo',
    name: 'photo',
    path,
    width: 80,
    height: 60,
    exif: {},
  }
  const snapshot = defaults()
  snapshot.panels = [{ photoId: photo.id, transform: identityTransform() }]
  const result = await annotationPreview(
    snapshot,
    [photo],
    resolve('resources'),
    800,
  )
  assert.equal(result.dataUrl, '')
  assert.deepEqual(result.annotationLayers, [])
  assert.equal(result.gestureImages.length, 1)
  assert.deepEqual(
    (
      await annotationPreview(
        snapshot,
        [photo],
        resolve('resources'),
        800,
        result.gestureImagesKey,
      )
    ).gestureImages,
    undefined,
  )
  snapshot.mat = '#336699'
  assert.deepEqual(
    (
      await annotationPreview(
        snapshot,
        [photo],
        resolve('resources'),
        800,
        result.gestureImagesKey,
      )
    ).gestureImages,
    undefined,
    'opaque photo payload is independent of mat',
  )
})

it.each(['srgb', 'p3'] as const)(
  'transparent photo layers reveal the colored mat like the compositor (%s)',
  async (profile) => {
    const directory = await mkdtemp(join(tmpdir(), 'poliframe-scene-alpha-'))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const width = 80
    const height = 60
    const pixels = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4
        pixels.set(
          [210, 70, 30, x < width / 3 ? 0 : x < (width * 2) / 3 ? 128 : 255],
          offset,
        )
      }
    }
    const path = join(directory, 'transparent.png')
    await sharp(pixels, { raw: { width, height, channels: 4 } })
      .withIccProfile('srgb')
      .png()
      .toFile(path)
    const photo = { id: 'photo', name: 'photo', path, width, height, exif: {} }
    const snapshot = defaults()
    snapshot.panels = [{ photoId: photo.id, transform: identityTransform() }]
    snapshot.mat = '#336699'
    snapshot.output.profile = profile
    const scene = await annotationPreview(
      snapshot,
      [photo],
      resolve('resources'),
      800,
    )
    const changedMat = { ...snapshot, mat: '#996633' }
    const changed = await annotationPreview(
      changedMat,
      [photo],
      resolve('resources'),
      800,
      scene.gestureImagesKey,
    )
    assert.notEqual(changed.gestureImagesKey, scene.gestureImagesKey)
    assert.ok(changed.gestureImages)
    assert.notEqual(
      changed.gestureImages[0].dataUrl,
      scene.gestureImages[0].dataUrl,
    )
    const image = scene.gestureImages[0]
    assert.match(image.dataUrl, /^data:image\/png;/)
    const bytes = Buffer.from(image.dataUrl.split(',')[1], 'base64')
    assert.equal((await sharp(bytes).metadata()).hasAlpha, true)
    const layerOverMat = await sharp(bytes)
      .flatten({ background: snapshot.mat })
      .removeAlpha()
      .raw()
      .toBuffer()
    const exact = await compose(snapshot, [photo], resolve('resources'))
    const output = await exact.pipeline
      .withIccProfile('srgb')
      .toColourspace('srgb')
      .png()
      .toBuffer()
    const cell = exact.layout.cells[0]
    for (const fraction of [0.15, 0.5, 0.85]) {
      const reference = await sharp(output)
        .extract({
          left: Math.round(cell.x + cell.width * fraction),
          top: Math.round(cell.y + cell.height / 2),
          width: 1,
          height: 1,
        })
        .removeAlpha()
        .raw()
        .toBuffer()
      const index
        = (Math.floor(image.height / 2) * image.width
          + Math.floor(image.width * fraction))
        * 3
      const actual = layerOverMat.subarray(index, index + 3)
      if (fraction === 0.5 && profile === 'srgb') {
        assert.deepEqual(
          actual,
          reference,
          'semi-transparent pixels use the exact working-space blend',
        )
      }
      assert.ok(
        actual.every(
          (value, channel) => Math.abs(value - reference[channel]) <= 1,
        ),
        `mat/photo sample ${fraction}: ${Array.from(actual)} vs ${Array.from(reference)}`,
      )
    }
  },
)
