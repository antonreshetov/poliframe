import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { inject, it } from 'vitest'
import { toWorkingPipeline } from '../src/main/imaging/color'
import {
  gesturePreview,
  previewSourceSize,
  transformImage,
} from '../src/main/imaging/composition'
import { openImage } from '../src/main/imaging/index'
import { defaults, identityTransform } from '../src/shared/defaults'

it('gesture acknowledgment skips payload only while visible content is unchanged', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'poliframe-gesture-'))
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'photo.png')
  await sharp({
    create: { width: 40, height: 30, channels: 3, background: '#958372' },
  })
    .png()
    .toFile(path)
  const photo = {
    id: 'photo',
    path,
    name: 'photo',
    width: 40,
    height: 30,
    exif: {},
  }
  const state = defaults()
  state.panels = [{ photoId: photo.id, transform: identityTransform() }]
  const first = await gesturePreview(state, [photo])
  assert.match(first.gestureImagesKey!, /^[a-f0-9]{64}$/)
  assert.equal(first.gestureImages!.length, 1)
  state.caption.title = 'New title'
  state.percent.frame = 15
  const unchanged = await gesturePreview(
    state,
    [photo],
    first.gestureImagesKey,
  )
  assert.equal(unchanged.gestureImages, undefined)
  assert.equal(unchanged.gestureImagesKey, first.gestureImagesKey)
  // No acknowledged key (including a fresh renderer) always receives pixels.
  assert.deepEqual(
    (await gesturePreview(state, [photo])).gestureImages,
    first.gestureImages,
  )
  state.panels[0]!.transform.flipX = true
  const transformed = await gesturePreview(
    state,
    [photo],
    first.gestureImagesKey,
  )
  assert.notEqual(transformed.gestureImagesKey, first.gestureImagesKey)
  assert.equal(transformed.gestureImages!.length, 1)
  await utimes(path, new Date(), new Date(Date.now() + 10000))
  const changedFile = await gesturePreview(
    state,
    [photo],
    transformed.gestureImagesKey,
  )
  assert.notEqual(changedFile.gestureImagesKey, transformed.gestureImagesKey)
  const replacement = { ...photo, id: 'replacement' }
  state.panels[0]!.photoId = replacement.id
  const replaced = await gesturePreview(
    state,
    [replacement],
    changedFile.gestureImagesKey,
  )
  assert.notEqual(replaced.gestureImagesKey, changedFile.gestureImagesKey)
  assert.equal(replaced.gestureImages![0]!.photoId, 'replacement')
})

it('preview source requirement covers both axes after crop and quarter rotation', () => {
  const photo = { width: 6000, height: 4000 }
  const transform = identityTransform()
  assert.ok(previewSourceSize(photo, transform, 300, 200) <= 512)
  assert.ok(previewSourceSize(photo, transform, 600, 400) <= 1024)
  const panorama = { width: 12000, height: 1000 }
  assert.ok(previewSourceSize(panorama, transform, 500, 500) > 4096)
  transform.rotation = 90
  assert.ok(previewSourceSize(panorama, transform, 500, 500) > 4096)
  transform.crop = { x: 0, y: 0, width: 0.1, height: 0.1 }
  assert.ok(previewSourceSize(photo, transform, 500, 500) > 4096)
})

it('combined TIFF transform preserves exact ushort pixels for EXIF rotations, flips and asymmetric crop', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'poliframe-transform-'))
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  for (const channels of [3, 4] as const) {
    const pixels = Buffer.from(
      Array.from(
        { length: 24 * 16 * channels },
        (_, i) => (i * 37 + Math.floor(i / 19)) % 256,
      ),
    )
    for (let orientation = 1; orientation <= 8; orientation++) {
      const path = join(directory, `${channels}-${orientation}.tiff`)
      let fixture = sharp(pixels, {
        raw: { width: 24, height: 16, channels },
      }).withMetadata({ orientation })
      if (channels === 4)
        fixture = fixture.withIccProfile('p3').toColourspace('rgb16')
      await fixture.tiff({ compression: 'lzw' }).toFile(path)
      const metadata = await sharp(path).metadata()
      if (channels === 4) {
        assert.equal(metadata.depth, 'ushort')
        assert.equal(metadata.hasAlpha, true)
      }
      const oriented = metadata.autoOrient
      const asset = { id: 'photo', name: 'photo', path, ...oriented, exif: {} }
      for (const rotation of [0, 90, 180, 270]) {
        for (const flipX of [false, true]) {
          for (const flipY of [false, true]) {
            const transform = {
              ...identityTransform(),
              rotation,
              flipX,
              flipY,
              crop: { x: 0.1, y: 0.15, width: 0.7, height: 0.65 },
            }
            // Original LZW stages are the independent compatibility oracle.
            let pipeline = await toWorkingPipeline(path)
            let source = oriented
            if (rotation) {
              const normalized = await pipeline.toBuffer()
              const rotated = await openImage(normalized)
                .rotate(rotation)
                .toColourspace('rgb16')
                .withIccProfile('p3')
                .tiff({ compression: 'lzw' })
                .toBuffer()
              pipeline = openImage(rotated)
              source = (await sharp(rotated).metadata()).autoOrient
            }
            if (flipX || flipY) {
              const flipped = await pipeline
                .flop(flipX)
                .flip(flipY)
                .toColourspace('rgb16')
                .withIccProfile('p3')
                .tiff({ compression: 'lzw' })
                .toBuffer()
              pipeline = openImage(flipped)
            }
            const expected = await pipeline
              .extract({
                left: Math.round(source.width * 0.1),
                top: Math.round(source.height * 0.15),
                width: Math.round(source.width * 0.7),
                height: Math.round(source.height * 0.65),
              })
              .resize(9, 7, { fit: 'cover' })
              .toColourspace('rgb16')
              .withIccProfile('p3')
              .tiff({ compression: 'lzw' })
              .toBuffer()
            const actual = await transformImage(asset, transform, 9, 7)
            const raw = (input: Buffer) =>
              sharp(input)
                .pipelineColourspace('rgb16')
                .toColourspace('rgb16')
                .raw({ depth: 'ushort' })
                .toBuffer()
            assert.deepEqual(
              await raw(actual),
              await raw(expected),
              `channels ${channels}, orientation ${orientation}, rotation ${rotation}, flipX ${flipX}, flipY ${flipY}`,
            )
          }
        }
      }
    }
  }
})

it('a restarted render worker honors published gesture keys and sends pixels to a fresh consumer', async (t) => {
  const { RenderJobs } = createRequire(import.meta.url)(
    resolve(inject('workerBuild'), 'main/services/render-jobs.js'),
  )
  const directory = await mkdtemp(join(tmpdir(), 'poliframe-worker-gesture-'))
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'photo.png')
  await sharp({
    create: { width: 40, height: 30, channels: 3, background: '#958372' },
  })
    .png()
    .toFile(path)
  const photo = {
    id: 'photo',
    path,
    name: 'photo',
    width: 40,
    height: 30,
    exif: {},
  }
  const snapshot = defaults()
  snapshot.panels = [{ photoId: photo.id, transform: identityTransform() }]
  const payload = {
    snapshot,
    assets: [photo],
    resources: resolve('resources'),
    maxSize: 400,
  }
  const firstWorker = new RenderJobs()
  t.onTestFinished(() => firstWorker.close())
  const first = await firstWorker.request('preview', payload)
  assert.equal(first.gestureImages.length, 1)
  await firstWorker.close()
  const restartedWorker = new RenderJobs()
  t.onTestFinished(() => restartedWorker.close())
  const acknowledged = await restartedWorker.request('preview', {
    ...payload,
    knownGestureImagesKey: first.gestureImagesKey,
  })
  assert.equal(acknowledged.gestureImagesKey, first.gestureImagesKey)
  assert.equal(acknowledged.gestureImages, undefined)
  const freshConsumer = await restartedWorker.request('preview', payload)
  assert.deepEqual(freshConsumer.gestureImages, first.gestureImages)
  const region = await restartedWorker.request('preview', {
    ...payload,
    region: { x: 0, y: 0, width: 10, height: 10 },
  })
  assert.equal(region.gestureImagesKey, undefined)
  assert.equal(region.gestureImages, undefined)
})
