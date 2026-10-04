import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { inject, it, vi } from 'vitest'
import * as color from '../src/main/imaging/color'
import {
  gestureImages,
  gesturePreview,
  previewSourceSize,
  transformImage,
} from '../src/main/imaging/composition'
import { openImage } from '../src/main/imaging/index'
import { defaults, identityTransform } from '../src/shared/defaults'
import { effectiveSize } from '../src/shared/layout'

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
            let pipeline = await color.toWorkingPipeline(path)
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
    create: { width: 1200, height: 800, channels: 3, background: '#958372' },
  })
    .png()
    .toFile(path)
  const photo = {
    id: 'photo',
    path,
    name: 'photo',
    width: 1200,
    height: 800,
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
  assert.equal(first.gestureImages[0].width, 512)
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
  const larger = await restartedWorker.request('preview', {
    ...payload,
    maxSize: 1600,
    knownGestureImagesKey: first.gestureImagesKey,
  })
  assert.notEqual(larger.gestureImagesKey, first.gestureImagesKey)
  assert.equal(larger.gestureImages[0].width, 1200)
  const region = await restartedWorker.request('preview', {
    ...payload,
    region: { x: 0, y: 0, width: 10, height: 10 },
  })
  assert.equal(region.gestureImagesKey, undefined)
  assert.equal(region.gestureImages, undefined)
})

it('gesture pixels match the LZW pipeline across source buckets, transforms and profiles', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'poliframe-gesture-pixels-'))
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  for (const profile of ['untagged', 'srgb', 'p3'] as const) {
    const width = profile === 'untagged' ? 2400 : 48
    const height = profile === 'untagged' ? 1600 : 32
    const channels = profile === 'p3' ? 4 : 3
    const pixels = Buffer.from(
      Array.from(
        { length: width * height * channels },
        (_, i) => (i * 37 + Math.floor(i / 19)) % 256,
      ),
    )
    const path = join(directory, `${profile}.tiff`)
    let fixture = sharp(pixels, {
      raw: { width, height, channels },
    }).withMetadata({ orientation: 6 })
    if (profile === 'untagged')
      fixture = fixture.keepIccProfile()
    else fixture = fixture.withIccProfile(profile).toColourspace('rgb16')
    await fixture.tiff({ compression: 'lzw' }).toFile(path)
    const oriented = (await sharp(path).metadata()).autoOrient
    const asset = { id: profile, name: profile, path, ...oriented, exif: {} }
    for (const [rotation, flipX, flipY, crop] of [
      [0, false, false, { x: 0, y: 0, width: 1, height: 1 }],
      [90, true, false, { x: 0.1, y: 0.05, width: 0.75, height: 0.8 }],
      [270, true, true, { x: 0.2, y: 0.15, width: 0.4, height: 0.6 }],
    ] as const) {
      const transform = {
        ...identityTransform(),
        rotation,
        flipX,
        flipY,
        crop,
      }
      const snapshot = defaults()
      snapshot.panels = [{ photoId: asset.id, transform }]
      const effective = effectiveSize(asset, transform)
      const factor = Math.min(
        1,
        2200 / Math.max(effective.width, effective.height),
      )
      const outputWidth = Math.max(1, Math.round(effective.width * factor))
      const outputHeight = Math.max(1, Math.round(effective.height * factor))
      // Reproduce the original source selection and final LZW stage independently.
      const sourceSize = 2200 / Math.min(crop.width, crop.height)
      const bucket = [512, 1024, 2200, 4096].find(size => size >= sourceSize)
      const source = bucket
        ? await (
            await color.toWorkingPipeline(path)
          )
            .resize({
              width: bucket,
              height: bucket,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .tiff({ compression: 'none' })
            .toBuffer()
        : undefined
      const tile = await transformImage(
        asset,
        transform,
        outputWidth,
        outputHeight,
        { x: 0, y: 0, width: outputWidth, height: outputHeight },
        source,
      )
      const output = openImage(tile)
        .withIccProfile('srgb')
        .toColourspace('srgb')
      const expected = await (
        channels === 4
          ? output.png()
          : output.jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
      ).toBuffer()
      const [actual] = await gestureImages(snapshot, [asset])
      assert.equal(actual!.width, outputWidth)
      assert.equal(actual!.height, outputHeight)
      assert.deepEqual(
        Buffer.from(actual!.dataUrl.split(',')[1]!, 'base64'),
        expected,
        `${profile}, rotation ${rotation}, crop ${crop.width}`,
      )
    }
  }
}, 30_000)

it('gesture resolution follows the largest cover requirement and acknowledges only matching pixels', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'poliframe-gesture-size-'))
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'photo.png')
  await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: '#789abc' },
  })
    .png()
    .toFile(path)
  const asset = {
    id: 'photo',
    name: 'photo',
    path,
    width: 3000,
    height: 2000,
    exif: {},
  }
  const snapshot = defaults()
  snapshot.panels = [{ photoId: asset.id, transform: identityTransform() }]
  const layout = {
    width: 3000,
    height: 3000,
    nativeWidth: 3000,
    nativeHeight: 3000,
    dpi: 72,
    captions: [],
    masks: [],
    warnings: [],
    cells: [
      { id: 'small', photoId: asset.id, x: 0, y: 0, width: 100, height: 100 },
      { id: 'large', photoId: asset.id, x: 0, y: 0, width: 1250, height: 1250 },
    ],
  }
  const prepareSource = vi.spyOn(color, 'toWorkingPipeline')
  t.onTestFinished(() => prepareSource.mockRestore())
  const sourceReads = () =>
    prepareSource.mock.calls.filter(([input]) => input === path).length
  const first = await gesturePreview(snapshot, [asset], undefined, {
    layout,
    maxSize: 800,
  })
  assert.equal(first.gestureImages![0]!.width, 512)
  assert.equal(first.gestureImages![0]!.height, 341)
  layout.cells[1]!.x = 100
  layout.cells[1]!.width = 1200
  const moved = await gesturePreview(
    snapshot,
    [asset],
    first.gestureImagesKey,
    { layout, maxSize: 810 },
  )
  assert.equal(moved.gestureImagesKey, first.gestureImagesKey)
  assert.equal(
    moved.gestureImages,
    undefined,
    'geometry within the bucket needs no JPEG payload',
  )
  const zoomed = await gesturePreview(
    snapshot,
    [asset],
    first.gestureImagesKey,
    { layout, maxSize: 1600 },
  )
  assert.notEqual(zoomed.gestureImagesKey, first.gestureImagesKey)
  assert.equal(zoomed.gestureImages![0]!.width, 1024)
  assert.equal(
    sourceReads(),
    1,
    '512 to 1024 reuses the prepared source without another original decode',
  )
  const full = await gesturePreview(
    snapshot,
    [asset],
    zoomed.gestureImagesKey,
    { layout, maxSize: 3200 },
  )
  assert.equal(full.gestureImages![0]!.width, 1982)
  assert.ok(
    full.gestureImages![0]!.width
    * full.gestureImages![0]!.height
    * 16
    * layout.cells.length
    <= 80 * 1024 * 1024,
  )
  assert.notEqual(full.gestureImagesKey, zoomed.gestureImagesKey)
  snapshot.panels[0]!.transform.rotation = 90
  snapshot.panels[0]!.transform.crop = { x: 0, y: 0, width: 1, height: 0.25 }
  // Effective 2000x750 panorama: cover must account for the short axis.
  const cropped = await gesturePreview(snapshot, [asset], undefined, {
    layout,
    maxSize: 800,
  })
  assert.equal(cropped.gestureImages![0]!.width, 1024)
  assert.equal(cropped.gestureImages![0]!.height, 384)
  snapshot.panels[0]!.transform.crop = { x: 0, y: 0, width: 0.1, height: 0.1 }
  const tiny = await gesturePreview(snapshot, [asset], undefined, {
    layout,
    maxSize: 3200,
  })
  assert.equal(tiny.gestureImages![0]!.width, 200)
  assert.equal(
    tiny.gestureImages![0]!.height,
    300,
    'never enlarge original crop pixels',
  )
  const repeated = {
    ...layout,
    cells: Array.from({ length: 128 }, (_, index) => ({
      ...layout.cells[1]!,
      id: `copy-${index}`,
    })),
  }
  snapshot.panels[0]!.transform = identityTransform()
  const bounded = await gesturePreview(snapshot, [asset], undefined, {
    layout: repeated,
    maxSize: 3200,
  })
  const image = bounded.gestureImages![0]!
  assert.ok(image.width < 512, '128 mounted copies use a smaller level')
  assert.ok(
    (image.width * image.height * 8 + image.dataUrl.length * 2) * 128
    <= 80 * 1024 * 1024,
  )
})

it('fast scene source preserves oriented dimensions, alpha and selected ICC after shrinking', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'poliframe-fast-source-'))
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  for (const profile of ['srgb', 'p3'] as const) {
    const path = join(directory, `${profile}.png`)
    await sharp({
      create: {
        width: 3001,
        height: 1903,
        channels: 4,
        background: { r: 210, g: 70, b: 30, alpha: 0.6 },
      },
    })
      .withMetadata({ orientation: 6 })
      .withIccProfile(profile)
      .png()
      .toFile(path)
    const asset = {
      id: profile,
      path,
      name: profile,
      ...(await sharp(path).metadata()).autoOrient,
      exif: {},
    }
    const snapshot = defaults()
    snapshot.output.profile = profile
    const transform = {
      ...identityTransform(),
      rotation: 90,
      flipX: true,
      crop: { x: 0.1, y: 0.1, width: 0.7, height: 0.8 },
    }
    snapshot.panels = [{ photoId: profile, transform }]
    const layout = {
      width: 3000,
      height: 3000,
      nativeWidth: 3000,
      nativeHeight: 3000,
      dpi: 72,
      captions: [],
      warnings: [],
      cells: [
        { id: 'cell', photoId: profile, x: 0, y: 0, width: 500, height: 500 },
      ],
    }
    const first = await gesturePreview(snapshot, [asset], undefined, {
      layout,
      maxSize: 800,
    })
    const actual = first.gestureImages![0]!
    // Independently materialize the 8-bit source in its embedded profile, then
    // use the exact transform oracle. Odd oriented dimensions guard NaN/rounding.
    const resized = await sharp(path)
      .autoOrient()
      .keepIccProfile()
      .resize(Math.round((asset.width * 1024) / 3001), 1024, {
        fit: 'fill',
        fastShrinkOnLoad: false,
      })
      .tiff({ compression: 'none' })
      .toBuffer()
    assert.equal((await sharp(resized).metadata()).hasAlpha, true)
    const working = await (
      await color.toWorkingPipeline(resized)
    )
      .tiff({ compression: 'none' })
      .toBuffer()
    const tile = await transformImage(
      asset,
      transform,
      actual.width,
      actual.height,
      undefined,
      working,
    )
    const matte = await color.toWorkingImage(
      await sharp({
        create: { width: 1, height: 1, channels: 3, background: snapshot.mat },
      })
        .png()
        .toBuffer(),
    )
    const expected = await openImage(matte)
      .resize(actual.width, actual.height, { fit: 'fill' })
      .pipelineColourspace('rgb16')
      .composite([{ input: tile, left: 0, top: 0 }])
      .withIccProfile(profile)
      .toColourspace('srgb')
      .png()
      .toBuffer()
    const bytes = Buffer.from(actual.dataUrl.split(',')[1]!, 'base64')
    assert.deepEqual(bytes, expected)
    const metadata = await sharp(bytes).metadata()
    assert.equal(metadata.width, actual.width)
    assert.equal(metadata.height, actual.height)
    assert.ok(metadata.icc)
    assert.equal(metadata.hasAlpha, true)
    assert.equal(metadata.format, 'png')
    snapshot.output.profile = profile === 'srgb' ? 'p3' : 'srgb'
    const changed = await gesturePreview(
      snapshot,
      [asset],
      first.gestureImagesKey,
      { layout, maxSize: 800 },
    )
    assert.notEqual(changed.gestureImagesKey, first.gestureImagesKey)
    assert.ok(changed.gestureImages)
    const changedIcc = (
      await sharp(
        Buffer.from(changed.gestureImages[0]!.dataUrl.split(',')[1]!, 'base64'),
      ).metadata()
    ).icc
    assert.notDeepEqual(changedIcc, metadata.icc)
    const repeated = {
      ...layout,
      cells: Array.from({ length: 128 }, (_, index) => ({
        ...layout.cells[0]!,
        id: `alpha-${index}`,
      })),
    }
    const bounded = await gesturePreview(snapshot, [asset], undefined, {
      layout: repeated,
      maxSize: 3200,
    })
    const small = bounded.gestureImages![0]!
    assert.ok(small.width < 512)
    assert.ok(
      (small.width * small.height * 8 + small.dataUrl.length * 2) * 128
      <= 80 * 1024 * 1024,
    )
  }
})
