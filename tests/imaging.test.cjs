const assert = require('node:assert/strict')
const {
  mkdtemp,
  rm,
  access,
  writeFile,
  readFile,
  readdir,
} = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const process = require('node:process')
const { test, before, after } = require('node:test')
const { ExifTool } = require('exiftool-vendored')
const sharp = require('sharp')

const {
  ImageMetadata,
  openImage,
  resizeImage,
  exportImage,
  renderText,
  validateDimensions,
} = require(join(process.env.POLIFRAME_TEST_BUILD || resolve('build'), 'main/imaging/index.js'))

let dir, source
const metadata = new ImageMetadata()
const verifier = new ExifTool({ maxProcs: 1 })
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'poliframe-imaging-'))
  source = join(dir, 'source.jpg')
  await sharp({
    create: { width: 12, height: 8, channels: 3, background: '#ac582b' },
  })
    .withIccProfile('p3')
    .jpeg()
    .toFile(source)
  await verifier.write(
    source,
    {
      Make: 'Fixture camera',
      Model: 'Selected source',
      ISO: 200,
      Artist: 'Fixture author',
      GPSLatitude: 12.5,
      GPSLongitude: 42.25,
    },
    { writeArgs: ['-overwrite_original', '-Orientation#=6'] },
  )
})
after(async () => {
  await Promise.all([metadata.close(), verifier.end()])
  await rm(dir, { recursive: true, force: true })
})

test('orientation and bounded native image primitives', async () => {
  const info = await metadata.inspect(source)
  assert.equal(info.orientation, 6)
  assert.equal(info.width, 8)
  assert.equal(info.height, 12)
  const rendered = await openImage(source).png().toBuffer()
  assert.equal((await sharp(rendered).metadata()).width, 8)
  assert.equal((await sharp(rendered).metadata()).height, 12)
  assert.throws(() => resizeImage(source, 100_001, 100_001), /budget/)
  assert.throws(() => validateDimensions(20_000, 20_000), /budget/)
})

for (const format of ['png', 'tiff', 'jpeg']) {
  for (const bitDepth of [8, 16]) {
    for (const copy of [false, true]) {
      test(`${format} ${bitDepth} bit, metadata ${copy ? 'selected source' : 'off'}`, async () => {
        const destination = join(
          dir,
          `${format}-${bitDepth}-${copy}.${format}`,
        )
        await exportImage(
          resizeImage(source, 6, 4),
          destination,
          {
            format,
            bitDepth,
            profile: 'srgb',
            dpi: 300,
            metadataSource: copy ? source : undefined,
          },
          metadata,
        )
        const tags = await verifier.readRaw(destination, { readArgs: ['-n'] })
        assert.equal(tags.ImageWidth, 6)
        assert.equal(tags.ImageHeight, 4)
        const actualDepth = tags.BitsPerSample ?? tags.BitDepth
        assert.ok(
          String(actualDepth)
            .split(' ')
            .every(n => Number(n) === (format === 'jpeg' ? 8 : bitDepth)),
          `depth: ${actualDepth}`,
        )
        assert.ok(tags.ProfileDescription, 'ICC profile must exist')
        assert.match(tags.ProfileDescription, /srgb/i)
        if (tags.Orientation !== undefined)
          assert.equal(tags.Orientation, 1)
        if (format === 'tiff')
          assert.equal(tags.Compression, 5)
        const density = tags.XResolution ?? tags.PixelsPerUnitX * 0.0254
        assert.ok(Math.abs(density - 300) < 0.1, `DPI: ${density}`)
        assert.equal(tags.Make, copy ? 'Fixture camera' : undefined)
        assert.equal(tags.Model, copy ? 'Selected source' : undefined)
        assert.equal(tags.ISO, copy ? 200 : undefined)
        assert.equal(tags.Artist, copy ? 'Fixture author' : undefined)
        assert.equal(tags.GPSLatitude, copy ? 12.5 : undefined)
      })
    }
  }
}

for (const profile of [
  'p3',
  { path: '/System/Library/ColorSync/Profiles/AdobeRGB1998.icc' },
]) {
  test(`ICC transform ${typeof profile === 'string' ? profile : 'Adobe RGB'}`, async (t) => {
    if (typeof profile !== 'string') {
      try {
        await access(profile.path)
      }
      catch {
        t.skip('Adobe RGB profile must be supplied by the host')
        return
      }
    }
    const destination = join(
      dir,
      `${typeof profile === 'string' ? profile : 'adobe'}.png`,
    )
    await exportImage(openImage(source), destination, {
      format: 'png',
      bitDepth: 16,
      profile,
    })
    const tags = await verifier.readRaw(destination)
    assert.match(
      tags.ProfileDescription,
      typeof profile === 'string' ? /p3/i : /adobe/i,
    )
    assert.equal(tags.BitDepth, 16)
  })
}

test('16-bit PNG and TIFF retain more than 256 distinct ramp samples', async () => {
  const width = 1024
  const pixels = Uint16Array.from({ length: width * 3 }, (_, i) =>
    Math.round((Math.floor(i / 3) * 65535) / (width - 1)))
  const ramp = join(dir, 'ramp-input.png')
  await sharp(pixels, { raw: { width, height: 1, channels: 3 } })
    .toColourspace('rgb16')
    .png()
    .toFile(ramp)
  for (const format of ['png', 'tiff']) {
    const destination = join(dir, `ramp.${format}`)
    await exportImage(
      openImage(ramp),
      destination,
      { format, bitDepth: 16, profile: 'srgb', metadataSource: source },
      metadata,
    )
    const { data } = await sharp(destination)
      .toColourspace('rgb16')
      .raw({ depth: 'ushort' })
      .toBuffer({ resolveWithObject: true })
    const values = new Set()
    for (let x = 0; x < width; x++) values.add(data.readUInt16LE(x * 6))
    assert.ok(
      values.size > 900,
      `${format}: ${values.size} distinct samples; 8-bit quantization detected`,
    )
  }
})

test('fontfile text primitive escapes markup and renders native text', async (t) => {
  const font = '/System/Library/Fonts/Supplemental/Arial.ttf'
  try {
    await access(font)
  }
  catch {
    t.skip('Supply a platform font fixture')
    return
  }
  const image = await renderText('Poliframe <&> © 2026', font, 'Arial 24', 320)
  const info = await sharp(image).metadata()
  assert.ok(info.width > 0 && info.width <= 320)
  assert.ok(info.height > 0)
  assert.equal(info.hasAlpha, true)
})

test('failed metadata transfer preserves an existing destination', async () => {
  const destination = join(dir, 'existing.png')
  await writeFile(destination, 'existing content')
  await assert.rejects(
    exportImage(
      openImage(source),
      destination,
      {
        format: 'png',
        bitDepth: 16,
        profile: 'srgb',
        metadataSource: join(dir, 'missing.jpg'),
      },
      metadata,
    ),
  )
  assert.equal(await readFile(destination, 'utf8'), 'existing content')
})

for (const format of ['png', 'jpeg']) {
  test(`metadata source without safe tags is a no-op (${format})`, async () => {
    const plain = join(dir, `plain.${format}`)
    await sharp({ create: { width: 4, height: 3, channels: 3, background: '#123456' } })[format]().toFile(plain)
    const destination = join(dir, `plain-export-${format}.tiff`)
    await exportImage(openImage(plain), destination, { format: 'tiff', bitDepth: 16, profile: 'srgb', metadataSource: plain }, metadata)
    const tags = await verifier.readRaw(destination, { readArgs: ['-n'] })
    assert.equal(tags.ImageWidth, 4)
    assert.equal(tags.ImageHeight, 3)
    assert.equal(tags.BitsPerSample, '16 16 16')
    assert.equal(tags.Make, undefined)
    assert.match(tags.ProfileDescription, /srgb/i)
  })
}

test('invalid ICC preserves destination and removes temporary output', async () => {
  const profile = join(dir, 'invalid.icc')
  const destination = join(dir, 'invalid-profile.png')
  await writeFile(profile, 'invalid ICC data')
  await writeFile(destination, 'original destination')
  await assert.rejects(exportImage(openImage(source), destination, {
    format: 'png',
    bitDepth: 16,
    profile: { path: profile },
  }), /profile|ICC/i)
  assert.equal(await readFile(destination, 'utf8'), 'original destination')
  assert.ok(!(await readdir(dir)).some(name => name.startsWith('.invalid-profile.png.')))
})

test('native Print Fit exports computed DPI above 2400 without changing pixels', async () => {
  const destination = join(dir, 'native-print-dpi.tiff')
  await exportImage(resizeImage(source, 6, 4), destination, { format: 'tiff', bitDepth: 16, profile: 'srgb', dpi: 5080 })
  const tags = await verifier.readRaw(destination, { readArgs: ['-n'] })
  assert.equal(tags.ImageWidth, 6)
  assert.equal(tags.ImageHeight, 4)
  assert.equal(tags.XResolution, 5080)
  assert.equal(tags.YResolution, 5080)
})
