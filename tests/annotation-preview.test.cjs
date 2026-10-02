const assert = require('node:assert/strict')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { test } = require('node:test')
const sharp = require('sharp')

const build = process.env.POLIFRAME_TEST_BUILD || resolve('build')
const { annotationPreview, compose } = require(join(build, 'main/imaging/composition.js'))
const { defaults, identityTransform } = require(join(build, 'shared/defaults.js'))

test('layered annotation preview preserves native caption geometry for every preset', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'poliframe-caption-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'photo.jpg')
  await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#8090a0' } }).jpeg().toFile(path)
  const photo = { id: 'photo', path, width: 3000, height: 2000, name: 'photo.jpg', exif: { camera: 'Camera', lens: 'Lens', iso: 'ISO 200' } }
  const state = defaults()
  state.panels = [{ photoId: photo.id, transform: identityTransform() }]
  state.caption.enabled = true
  state.caption.sourceId = photo.id
  state.caption.title = 'A caption with Кириллица'
  state.caption.copyright = '© Photographer'
  for (const style of ['studio', 'retro', 'editorial', 'museum', 'minimal', 'classic', 'luxe']) {
    state.caption.style = style
    const layered = await annotationPreview(state, [photo], resolve('resources'), 1200)
    const native = await compose(state, [photo], resolve('resources'), 1200)
    assert.deepEqual(layered.layout, native.layout, style)
    assert.ok(layered.annotationLayers.length > 0)
    assert.equal(layered.dataUrl, '')
    assert.equal(layered.gestureImages.length, 1)
    for (const layer of layered.annotationLayers) {
      assert.ok(layer.width > 0 && layer.height > 0)
      assert.match(layer.dataUrl, /^data:image\/png;base64,/)
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
  t.diagnostic(`Warm caption padding preview median: ${elapsed.sort((a, b) => a - b)[5].toFixed(1)} ms`)
  for (const field of ['size', 'title']) {
    const samples = []
    for (let i = 1; i <= 10; i++) {
      state.caption[field] = field === 'size' ? 80 + i : `Caption ${'a'.repeat(i)}`
      const start = performance.now()
      await annotationPreview(state, [photo], resolve('resources'), 1200)
      samples.push(performance.now() - start)
    }
    t.diagnostic(`Caption ${field} median: ${samples.sort((a, b) => a - b)[5].toFixed(1)} ms`)
  }
  state.watermark = { photoId: photo.id, size: 20, opacity: 35, position: 'bottomRight' }
  const marked = await annotationPreview(state, [photo], resolve('resources'), 1200)
  assert.equal(marked.annotationLayers.at(-1).opacity, 0.35)
  const plain = structuredClone(state)
  plain.watermark.photoId = null
  assert.deepEqual(marked.layout, (await compose(plain, [photo], resolve('resources'), 1200)).layout)
})
