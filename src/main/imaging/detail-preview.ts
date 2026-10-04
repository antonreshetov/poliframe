import type { Buffer } from 'node:buffer'
import type {
  CellLayout,
  Composition,
  PreviewResult,
  Rect,
  Transform,
} from '../../shared/contracts'
import type { ImageAsset } from './composition'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import sharp from 'sharp'
import { calculateLayout, effectiveSize } from '../../shared/layout'
import { outputProfile, toWorkingPipeline } from './color'
import { MAX_IMAGE_PIXELS } from './index'
import { PreviewCache } from './preview-cache'

// Lazy, worker-local caches. Originals remain on disk; only visible photos enter.
const sources = new PreviewCache(256 * 1024 * 1024)
const tiles = new PreviewCache(32 * 1024 * 1024)
const edge = 256
const displayBudget = 64 * 1024 * 1024

/** Fixed photo-local tiles survive panning; complex compositing uses the exact ROI path. */
export async function detailPreview(
  snapshot: Composition,
  assets: ImageAsset[],
  resources: string,
  region: Rect,
  maxSize: number,
): Promise<PreviewResult | undefined> {
  if (snapshot.caption.enabled || snapshot.watermark.photoId)
    return
  const layout = await calculateLayout(snapshot, assets)
  if (layout.masks.length)
    return
  if (
    ![region.x, region.y, region.width, region.height, maxSize].every(
      Number.isFinite,
    )
    || region.x < 0
    || region.y < 0
    || region.width < 1
    || region.height < 1
    || region.x + region.width > layout.width
    || region.y + region.height > layout.height
    || maxSize < 1
    || maxSize > 4096
  ) {
    throw new Error('Invalid preview region')
  }
  const visible = layout.cells.filter(
    cell =>
      cell.photoId
      && cell.x < region.x + region.width
      && cell.y < region.y + region.height
      && cell.x + cell.width > region.x
      && cell.y + cell.height > region.y,
  )
  const inputs: {
    cell: CellLayout
    asset: ImageAsset
    transform: Transform
    identity: string
  }[] = []
  for (const cell of visible) {
    const asset = assets.find(item => item.id === cell.photoId)
    const panel = snapshot.panels.find(item => item.photoId === cell.photoId)
    if (!asset || !panel)
      throw new Error('Grid image is unavailable')
    effectiveSize(asset, panel.transform)
    const metadata = await sharp(asset.path, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: 'error',
      pages: 1,
    }).metadata()
    // Keep alpha/16-bit/CMYK and oversized sources on the established exact path.
    if (
      metadata.depth !== 'uchar'
      || metadata.hasAlpha
      || !['srgb', 'rgb'].includes(metadata.space)
      || metadata.width * metadata.height * 3 > 256 * 1024 * 1024
    ) {
      return
    }
    const info = await stat(asset.path)
    const identity = JSON.stringify([
      asset.path,
      info.size,
      info.mtimeMs,
      info.ctimeMs,
      panel.transform.rotation,
      panel.transform.flipX,
      panel.transform.flipY,
    ])
    inputs.push({ cell, asset, transform: panel.transform, identity })
  }
  let factor
    = 2
      ** Math.min(
        0,
        Math.ceil(Math.log2(maxSize / Math.max(region.width, region.height))),
      )
  const plan = () =>
    inputs.flatMap((input) => {
      const { cell } = input
      const width = Math.max(1, Math.round(cell.width * factor))
      const height = Math.max(1, Math.round(cell.height * factor))
      const xScale = width / cell.width
      const yScale = height / cell.height
      const left = Math.max(
        0,
        Math.floor(((region.x - cell.x) * xScale) / edge) * edge,
      )
      const top = Math.max(
        0,
        Math.floor(((region.y - cell.y) * yScale) / edge) * edge,
      )
      const right = Math.min(
        width,
        Math.ceil((region.x + region.width - cell.x) * xScale),
      )
      const bottom = Math.min(
        height,
        Math.ceil((region.y + region.height - cell.y) * yScale),
      )
      const result = []
      for (let y = top; y < bottom; y += edge) {
        for (let x = left; x < right; x += edge) {
          result.push({
            ...input,
            width,
            height,
            xScale,
            yScale,
            tile: {
              left: x,
              top: y,
              width: Math.min(edge, width - x),
              height: Math.min(edge, height - y),
            },
          })
        }
      }
      return result
    })
  let planned = plan()
  while (
    planned.reduce(
      (sum, item) => sum + item.tile.width * item.tile.height * 16,
      0,
    ) > displayBudget
  ) {
    factor /= 2
    planned = plan()
  }
  if (planned.some(item => item.width * item.height * 3 > 256 * 1024 * 1024))
    return
  const detailTiles: NonNullable<PreviewResult['detailTiles']> = []
  const keyed = planned.map(item => ({
    ...item,
    key: createHash('sha256')
      .update(
        JSON.stringify([
          item.identity,
          item.transform.crop,
          item.width,
          item.height,
          item.tile,
          snapshot.output.profile,
        ]),
      )
      .digest('hex'),
  }))
  const batches = new Map<
    string,
    { data: Buffer, left: number, top: number }
  >()
  for (const item of keyed) {
    const {
      identity,
      asset,
      transform,
      cell,
      width,
      height,
      tile,
      xScale,
      yScale,
      key,
    } = item
    const data = await tiles.get(key, async () => {
      let batch = batches.get(cell.id)
      if (!batch) {
        const sourceKey = JSON.stringify([
          identity,
          transform.crop,
          width,
          height,
        ])
        const source = await sources.get(sourceKey, async () => {
          let pipeline = sharp(asset.path, {
            limitInputPixels: MAX_IMAGE_PIXELS,
            failOn: 'error',
            pages: 1,
          })
            .autoOrient()
            .keepIccProfile()
          const metadata = await pipeline.metadata()
          let sourceWidth = metadata.autoOrient.width
          let sourceHeight = metadata.autoOrient.height
          // EXIF orientation must complete before an independent user rotation.
          if (transform.rotation || transform.flipX || transform.flipY) {
            const oriented = await pipeline
              .tiff({ compression: 'none' })
              .toBuffer()
            const swap = transform.rotation % 180 !== 0
            const transformed = await sharp(oriented)
              .keepIccProfile()
              .rotate(transform.rotation)
              .flop(swap ? transform.flipY : transform.flipX)
              .flip(swap ? transform.flipX : transform.flipY)
              .tiff({ compression: 'none' })
              .toBuffer()
            pipeline = sharp(transformed).keepIccProfile()
            const info = await pipeline.metadata()
            sourceWidth = info.width
            sourceHeight = info.height
          }
          const left = Math.min(
            sourceWidth - 1,
            Math.round(transform.crop.x * sourceWidth),
          )
          const top = Math.min(
            sourceHeight - 1,
            Math.round(transform.crop.y * sourceHeight),
          )
          return pipeline
            .extract({
              left,
              top,
              width: Math.min(
                sourceWidth - left,
                Math.max(1, Math.round(transform.crop.width * sourceWidth)),
              ),
              height: Math.min(
                sourceHeight - top,
                Math.max(1, Math.round(transform.crop.height * sourceHeight)),
              ),
            })
            .resize(width, height, { fit: 'cover', fastShrinkOnLoad: false })
            .tiff({ compression: 'none' })
            .toBuffer()
        })
        const missing = keyed.filter(
          other => other.cell.id === cell.id && !tiles.peek(other.key),
        )
        const left = Math.min(...missing.map(other => other.tile.left))
        const top = Math.min(...missing.map(other => other.tile.top))
        const right = Math.max(
          ...missing.map(other => other.tile.left + other.tile.width),
        )
        const bottom = Math.max(
          ...missing.map(other => other.tile.top + other.tile.height),
        )
        // Convert the missing visible rectangle once, rather than opening an ICC
        // transform for each tiny tile. A batch never spans different photo cells.
        const pixels = await sharp(source)
          .keepIccProfile()
          .extract({ left, top, width: right - left, height: bottom - top })
          .tiff({ compression: 'none' })
          .toBuffer()
        const working = await (
          await toWorkingPipeline(pixels)
        )
          .tiff({ compression: 'none' })
          .toBuffer()
        const data = await sharp(working)
          .withIccProfile(outputProfile(snapshot.output.profile, resources))
          .toColourspace('srgb')
          .tiff({ compression: 'none' })
          .toBuffer()
        batch = { data, left, top }
        batches.set(cell.id, batch)
      }
      return sharp(batch.data)
        .keepIccProfile()
        .extract({
          left: tile.left - batch.left,
          top: tile.top - batch.top,
          width: tile.width,
          height: tile.height,
        })
        .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
        .toBuffer()
    })
    detailTiles.push({
      key: `${cell.id}:${key}`,
      x: cell.x + tile.left / xScale,
      y: cell.y + tile.top / yScale,
      width: tile.width / xScale,
      height: tile.height / yScale,
      pixelWidth: tile.width,
      pixelHeight: tile.height,
      dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`,
    })
  }
  const displayCost = detailTiles.reduce(
    (sum, tile) =>
      sum + tile.pixelWidth * tile.pixelHeight * 8 + tile.dataUrl.length * 2,
    0,
  )
  if (displayCost > displayBudget)
    return
  return {
    revision: snapshot.revision,
    layout,
    region,
    dataUrl: '',
    detailTiles,
  }
}
