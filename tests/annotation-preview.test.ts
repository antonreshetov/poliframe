import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { it } from 'vitest'

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
