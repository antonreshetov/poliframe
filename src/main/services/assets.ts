import type { Photo } from '../../shared/contracts'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { ImageMetadata } from '../imaging'

export interface Asset extends Photo {
  path: string
}
export class AssetRegistry {
  readonly metadata = new ImageMetadata()
  private pendingImports = 0
  private readonly assets = new Map<string, Asset>()

  async import(file: string): Promise<Photo> {
    if (
      typeof file !== 'string'
      || !path.isAbsolute(file)
      || file.includes('\0')
    ) {
      throw new Error('Invalid image path')
    }
    const stats = await stat(file)
    if (!stats.isFile() || stats.size > 512 * 1024 * 1024)
      throw new Error('Image exceeds the 512 MB input budget')
    if (this.assets.size + this.pendingImports >= 160)
      throw new Error('Image pool is full; remove unused images first')
    this.pendingImports++
    try {
      const [metadata, thumb] = await Promise.all([
        this.metadata.inspect(file),
        sharp(file, { limitInputPixels: 100_000_000 })
          .autoOrient()
          .resize({
            width: 800,
            height: 800,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .withIccProfile('srgb')
          .toColourspace('srgb')
          .jpeg({ quality: 85 })
          .toBuffer(),
      ])
      const tags = metadata.tags as Record<string, unknown>
      const get = (key: string) => tags[key] ?? tags[`EXIF:${key}`]
      const str = (key: string) =>
        get(key) === undefined ? '' : String(get(key))
      const make = str('Make').replace(/FUJIFILM/i, 'Fujifilm')
      const model = str('Model')
      const camera = model.toLowerCase().includes(make.toLowerCase())
        ? model
        : `${make} ${model}`.trim()
      const exposure = Number(get('ExposureTime'))
      const exif: Photo['exif'] = {
        camera,
        lens: str('LensModel'),
        focal: str('FocalLength') ? `${str('FocalLength')}mm` : '',
        aperture: str('FNumber') ? `f/${str('FNumber')}` : '',
        iso: str('ISO') ? `ISO ${str('ISO')}` : '',
        shutter:
          exposure > 0
            ? exposure >= 1
              ? `${exposure}s`
              : `1/${Math.round(1 / exposure)}s`
            : '',
        date: str('DateTimeOriginal').slice(0, 10).replaceAll(':', '-'),
      }
      const asset: Asset = {
        id: randomUUID(),
        path: file,
        name: path.basename(file),
        width: metadata.width,
        height: metadata.height,
        thumbnail: `data:image/jpeg;base64,${thumb.toString('base64')}`,
        exif,
      }
      this.assets.set(asset.id, asset)
      const { path: _, ...photo } = asset
      return photo
    }
    finally {
      this.pendingImports--
    }
  }

  all(ids: string[]): Asset[] {
    return [...new Set(ids)].map((id) => {
      const asset = this.assets.get(id)
      if (!asset)
        throw new Error('An image is no longer available. Import it again.')
      return asset
    })
  }

  release(ids: string[]) {
    ids.forEach(id => this.assets.delete(id))
  }

  async logoData(id: string): Promise<string> {
    const [asset] = this.all([id])
    const png = await sharp(asset.path)
      .autoOrient()
      .resize({
        width: 2048,
        height: 2048,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer()
    return `data:image/png;base64,${png.toString('base64')}`
  }
}
