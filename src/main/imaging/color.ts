import type { Buffer } from 'node:buffer'
import type { Sharp } from 'sharp'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExifTool } from 'exiftool-vendored'
import sharp from 'sharp'
import { MAX_IMAGE_PIXELS } from './index'

let srgbProfile: Promise<Buffer> | undefined
function defaultProfile(): Promise<Buffer> {
  srgbProfile ??= (async () => {
    const png = await sharp({
      create: { width: 1, height: 1, channels: 3, background: '#ffffff' },
    })
      .withIccProfile('srgb')
      .png()
      .toBuffer()
    const profile = (await sharp(png).metadata()).icc
    if (!profile)
      throw new Error('sRGB ICC profile is unavailable')
    return profile
  })()
  return srgbProfile
}

/** All compositor pixels use tagged 16-bit Display P3, including matte and text. */
export async function toWorkingPipeline(
  input: string | Buffer,
): Promise<Sharp> {
  const options = {
    limitInputPixels: MAX_IMAGE_PIXELS,
    failOn: 'error' as const,
    pages: 1,
  }
  const info = await sharp(input, options).metadata()
  let source = input
  // Sharp assumes untagged RGB16 is already P3. Assign sRGB without changing samples
  // before asking lcms to transform it. Native ExifTool writes only the ICC payload.
  if (!info.hasProfile && info.space === 'rgb16') {
    const directory = await mkdtemp(join(tmpdir(), 'poliframe-icc-'))
    const tool = new ExifTool({ maxProcs: 1, taskTimeoutMillis: 15_000 })
    try {
      const path = join(directory, 'source.tiff')
      const profile = join(directory, 'srgb.icc')
      await writeFile(profile, await defaultProfile())
      await sharp(input, options)
        .autoOrient()
        .keepIccProfile()
        .toColourspace('rgb16')
        .tiff({ compression: 'lzw' })
        .toFile(path)
      await tool.write(
        path,
        {},
        { writeArgs: ['-overwrite_original', `-ICC_Profile<=${profile}`] },
      )
      source = await readFile(path)
    }
    finally {
      await tool.end()
      await rm(directory, { recursive: true, force: true })
    }
  }
  let pipeline = sharp(source, options).autoOrient()
  // Native 8-bit untagged input is sRGB; keep that processing interpretation until
  // the output transform. Tagged input can enter P3 processing at 16-bit precision.
  if (info.hasProfile || info.space === 'rgb16')
    pipeline = pipeline.pipelineColourspace('rgb16')
  return pipeline
    .toColourspace('rgb16')
    .withIccProfile('p3')
    .tiff({ compression: 'lzw' })
}

export async function toWorkingImage(input: string | Buffer): Promise<Buffer> {
  return (await toWorkingPipeline(input)).toBuffer()
}
