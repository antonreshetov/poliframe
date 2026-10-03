import type { Buffer } from 'node:buffer'
import type { OverlayOptions, Sharp } from 'sharp'
import type {
  Composition,
  LayoutResult,
  Photo,
  PreviewResult,
  Rect,
  Transform,
} from '../../shared/contracts'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import sharp from 'sharp'
import { calculateLayout, effectiveSize } from '../../shared/layout'
import { createCaptionRenderer } from './captions'
import { toWorkingImage, toWorkingPipeline } from './color'
import { openImage, validateDimensions } from './index'
import { PreviewCache } from './preview-cache'

const previewSources = new PreviewCache(96 * 1024 * 1024)
const previewTiles = new PreviewCache(48 * 1024 * 1024)

export interface ImageAsset extends Photo {
  path: string
}
/** Rotate, flip, then crop in oriented image coordinates; each materialized stage stays 16-bit. */
export async function transformImage(
  asset: ImageAsset,
  transform: Transform,
  width: number,
  height: number,
  region?: Rect,
  previewSource?: Buffer,
  compression: 'lzw' | 'none' = 'lzw',
): Promise<Buffer> {
  effectiveSize(asset, transform)
  validateDimensions(region?.width ?? width, region?.height ?? height)
  let pipeline = previewSource
    ? openImage(previewSource)
    : await toWorkingPipeline(asset.path)
  let source = (await sharp(previewSource ?? asset.path).metadata()).autoOrient
  if (transform.rotation % 360 || transform.flipX || transform.flipY) {
    // Sharp applies flips before rotation. Swap their axes for quarter turns
    // to preserve the editor's rotate-then-flip transform in one materialization.
    const swap = transform.rotation % 180 !== 0
    const data = await pipeline
      .rotate(transform.rotation)
      .flop(swap ? transform.flipY : transform.flipX)
      .flip(swap ? transform.flipX : transform.flipY)
      .toColourspace('rgb16')
      .withIccProfile('p3')
      .tiff({ compression: 'none' })
      .toBuffer()
    pipeline = openImage(data)
    source = (await sharp(data).metadata()).autoOrient
  }
  const crop = transform.crop
  const left = Math.min(source.width - 1, Math.round(crop.x * source.width))
  const top = Math.min(source.height - 1, Math.round(crop.y * source.height))
  let output = pipeline
    .extract({
      left,
      top,
      width: Math.min(
        source.width - left,
        Math.max(1, Math.round(crop.width * source.width)),
      ),
      height: Math.min(
        source.height - top,
        Math.max(1, Math.round(crop.height * source.height)),
      ),
    })
    .resize(width, height, { fit: 'cover' })
  if (region) {
    output = output.extract({
      left: region.x,
      top: region.y,
      width: region.width,
      height: region.height,
    })
  }
  return output
    .toColourspace('rgb16')
    .withIccProfile('p3')
    .tiff({ compression })
    .toBuffer()
}

/** Required source long edge for cover after rotation/crop, with rounding headroom. */
export function previewSourceSize(
  asset: Pick<Photo, 'width' | 'height'>,
  transform: Transform,
  width: number,
  height: number,
): number {
  const effective = effectiveSize(asset, transform)
  return Math.ceil(
    Math.max(asset.width, asset.height)
    * Math.max((width + 2) / effective.width, (height + 2) / effective.height),
  )
}

async function previewSource(asset: ImageAsset, sourceSize: number) {
  const info = await stat(asset.path)
  const identity = JSON.stringify([
    asset.path,
    info.size,
    info.mtimeMs,
    info.ctimeMs,
  ])
  const bucket
    = [512, 1024, 2200, 4096].find(size => size >= sourceSize) ?? 0
  return {
    identity,
    bucket,
    load: () =>
      bucket
        ? previewSources.get(`${identity}:${bucket}`, async () =>
            (await toWorkingPipeline(asset.path))
              .resize({
                width: bucket,
                height: bucket,
                fit: 'inside',
                withoutEnlargement: true,
              })
              .tiff({ compression: 'none' })
              .toBuffer())
        : undefined,
  }
}

async function previewTile(
  asset: ImageAsset,
  transform: Transform,
  width: number,
  height: number,
  region: Rect,
  sourceSize: number,
): Promise<Buffer> {
  const { identity, bucket, load } = await previewSource(asset, sourceSize)
  const key = JSON.stringify([
    identity,
    transform,
    width,
    height,
    region,
    bucket,
  ])
  return previewTiles.get(key, async () =>
    transformImage(asset, transform, width, height, region, await load()))
}

function visiblePanels(snapshot: Composition) {
  const visible = new Set<string>()
  const visit = (node: Composition['grid']) => {
    if (node.type === 'leaf') {
      if (node.photoId)
        visible.add(node.photoId)
    }
    else {
      node.children.forEach(visit)
    }
  }
  if (snapshot.layout === 'grid')
    visit(snapshot.grid)
  else snapshot.panels.forEach(panel => visible.add(panel.photoId))
  return snapshot.panels.filter(panel => visible.has(panel.photoId))
}

/** Stateless content identity: a worker restart never invalidates an acknowledged payload. */
export async function gesturePreview(
  snapshot: Composition,
  assets: ImageAsset[],
  knownGestureImagesKey?: string,
): Promise<Pick<PreviewResult, 'gestureImages' | 'gestureImagesKey'>> {
  const identities = await Promise.all(
    visiblePanels(snapshot).map(async (panel) => {
      const asset = assets.find(item => item.id === panel.photoId)
      if (!asset)
        throw new Error(`Grid image is unavailable: ${panel.photoId}`)
      const info = await stat(asset.path)
      const { rotation, flipX, flipY, crop } = panel.transform
      return [
        panel.photoId,
        asset.path,
        asset.width,
        asset.height,
        info.size,
        info.mtimeMs,
        info.ctimeMs,
        rotation,
        flipX,
        flipY,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
      ]
    }),
  )
  const gestureImagesKey = createHash('sha256')
    .update(JSON.stringify(identities))
    .digest('hex')
  return {
    gestureImagesKey,
    gestureImages:
      gestureImagesKey === knownGestureImagesKey
        ? undefined
        : await gestureImages(snapshot, assets),
  }
}

const gestureCache = new PreviewCache(24 * 1024 * 1024)
/** Native gridLeafGestureImages equivalent: transformed photo, before cell cover-crop. */
export async function gestureImages(
  snapshot: Composition,
  assets: ImageAsset[],
): Promise<NonNullable<PreviewResult['gestureImages']>> {
  const result: NonNullable<PreviewResult['gestureImages']> = []
  for (const panel of visiblePanels(snapshot)) {
    const asset = assets.find(item => item.id === panel.photoId)
    if (!asset)
      continue
    const effective = effectiveSize(asset, panel.transform)
    const factor = Math.min(
      1,
      2200 / Math.max(effective.width, effective.height),
    )
    const width = Math.max(1, Math.round(effective.width * factor))
    const height = Math.max(1, Math.round(effective.height * factor))
    const info = await stat(asset.path)
    const key = JSON.stringify([
      asset.path,
      info.size,
      info.mtimeMs,
      info.ctimeMs,
      panel.transform,
    ])
    const data = await gestureCache.get(key, async () => {
      const source = await previewSource(
        asset,
        2200
        / Math.min(panel.transform.crop.width, panel.transform.crop.height),
      )
      // This intermediate is consumed immediately; keep compressed tiles out of
      // this path without retaining large uncompressed buffers in previewTiles.
      const tile = await transformImage(
        asset,
        panel.transform,
        width,
        height,
        { x: 0, y: 0, width, height },
        await source.load(),
        'none',
      )
      return openImage(tile)
        .withIccProfile('srgb')
        .toColourspace('srgb')
        .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
        .toBuffer()
    })
    result.push({
      photoId: panel.photoId,
      width,
      height,
      dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`,
    })
  }
  return result
}

/** Geometry always describes the full output; maxSize only reduces preview pixels. */
export async function compose(
  snapshot: Composition,
  assets: ImageAsset[],
  resourcesPath: string,
  maxSize?: number,
  region?: Rect,
): Promise<{ pipeline: Sharp, layout: LayoutResult }> {
  if (
    maxSize !== undefined
    && (!Number.isFinite(maxSize) || maxSize < 1 || maxSize > 4096)
  ) {
    throw new Error('Invalid preview size')
  }
  const byId = new Map(assets.map(asset => [asset.id, asset]))
  const captions = createCaptionRenderer(snapshot, byId, resourcesPath)
  const layout = await calculateLayout(
    snapshot,
    assets,
    async (id, width, scale) => (await captions(id, width, scale)).height,
  )
  if (
    region
    && (![region.x, region.y, region.width, region.height].every(
      Number.isFinite,
    )
    || region.x < 0
    || region.y < 0
    || region.width < 1
    || region.height < 1
    || region.x + region.width > layout.width
    || region.y + region.height > layout.height)
  ) {
    throw new Error('Invalid preview region')
  }
  const view = region
    ? {
        x: Math.floor(region.x),
        y: Math.floor(region.y),
        width: Math.min(
          layout.width - Math.floor(region.x),
          Math.ceil(region.width),
        ),
        height: Math.min(
          layout.height - Math.floor(region.y),
          Math.ceil(region.height),
        ),
      }
    : { x: 0, y: 0, width: layout.width, height: layout.height }
  const factor = maxSize
    ? Math.min(1, maxSize / Math.max(view.width, view.height))
    : 1
  const width = Math.max(1, Math.round(view.width * factor))
  const height = Math.max(1, Math.round(view.height * factor))
  validateDimensions(width, height)
  const overlays: OverlayOptions[] = []
  const addClipped = async (input: Buffer, left: number, top: number) => {
    const info = await sharp(input).metadata()
    const cropLeft = Math.max(0, -left)
    const cropTop = Math.max(0, -top)
    const visibleWidth = Math.min(
      info.width - cropLeft,
      width - Math.max(0, left),
    )
    const visibleHeight = Math.min(
      info.height - cropTop,
      height - Math.max(0, top),
    )
    if (visibleWidth < 1 || visibleHeight < 1)
      return
    const clipped
      = cropLeft
        || cropTop
        || visibleWidth !== info.width
        || visibleHeight !== info.height
        ? await openImage(input)
            .extract({
              left: cropLeft,
              top: cropTop,
              width: visibleWidth,
              height: visibleHeight,
            })
            .toColourspace('rgb16')
            .withIccProfile('p3')
            .tiff({ compression: 'lzw' })
            .toBuffer()
        : input
    overlays.push({
      input: clipped,
      left: Math.max(0, left),
      top: Math.max(0, top),
    })
  }
  const rounded = (rect: Rect) => {
    const left = Math.max(0, Math.round((rect.x - view.x) * factor))
    const top = Math.max(0, Math.round((rect.y - view.y) * factor))
    return {
      left,
      top,
      width: Math.max(
        0,
        Math.min(width, Math.round((rect.x + rect.width - view.x) * factor))
        - left,
      ),
      height: Math.max(
        0,
        Math.min(height, Math.round((rect.y + rect.height - view.y) * factor))
        - top,
      ),
    }
  }
  for (const cell of layout.cells) {
    if (!cell.photoId)
      continue
    const asset = byId.get(cell.photoId)
    const panel = snapshot.panels.find(p => p.photoId === cell.photoId)
    if (!asset || !panel)
      throw new Error(`Grid image is unavailable: ${cell.photoId}`)
    const rect = rounded(cell)
    if (!rect.width || !rect.height)
      continue
    const cellLeft = Math.round((cell.x - view.x) * factor)
    const cellTop = Math.round((cell.y - view.y) * factor)
    const cellWidth = Math.max(
      1,
      Math.round((cell.x + cell.width - view.x) * factor) - cellLeft,
    )
    const cellHeight = Math.max(
      1,
      Math.round((cell.y + cell.height - view.y) * factor) - cellTop,
    )
    const regionRect = {
      x: Math.max(0, -cellLeft),
      y: Math.max(0, -cellTop),
      width: rect.width,
      height: rect.height,
    }
    const render = (source?: Buffer) =>
      transformImage(
        asset,
        panel.transform,
        cellWidth,
        cellHeight,
        regionRect,
        source,
      )
    let input: Buffer
    if (maxSize !== undefined) {
      const sourceSize = region
        ? Infinity
        : previewSourceSize(asset, panel.transform, cellWidth, cellHeight)
      input = await previewTile(
        asset,
        panel.transform,
        cellWidth,
        cellHeight,
        regionRect,
        sourceSize,
      )
    }
    else {
      input = await render()
    }
    overlays.push({ input, left: rect.left, top: rect.top })
  }
  for (const mask of layout.masks) {
    const rect = rounded(mask)
    if (!rect.width || !rect.height)
      continue
    overlays.push({
      input: await toWorkingImage(
        await sharp({
          create: {
            width: rect.width,
            height: rect.height,
            channels: 4,
            background: snapshot.mat,
          },
        })
          .png()
          .toBuffer(),
      ),
      left: rect.left,
      top: rect.top,
    })
  }
  for (const cap of layout.captions) {
    const text = await captions(
      cap.photoId,
      Math.max(1, cap.width - cap.paddingX * 2),
      cap.scale,
    )
    for (const piece of text.pieces) {
      const input
        = factor === 1
          ? piece.input
          : await sharp(piece.input)
              .resize(
                Math.max(1, Math.round(piece.width * factor)),
                Math.max(1, Math.round(piece.height * factor)),
                { fit: 'fill' },
              )
              .toColourspace('rgb16')
              .withIccProfile('p3')
              .tiff({ compression: 'lzw' })
              .toBuffer()
      await addClipped(
        input,
        Math.round((cap.x + cap.paddingX + piece.x - view.x) * factor),
        Math.round((cap.y + cap.paddingTop + piece.y - view.y) * factor),
      )
    }
  }
  const wm = snapshot.watermark
  if (wm.photoId && wm.size > 0 && wm.opacity > 0 && layout.cells.length) {
    const logo = byId.get(wm.photoId)
    if (!logo)
      throw new Error('Watermark image is unavailable')
    const minX = Math.min(...layout.cells.map(c => c.x))
    const minY = Math.min(...layout.cells.map(c => c.y))
    const maxX = Math.max(...layout.cells.map(c => c.x + c.width))
    const maxY = Math.max(...layout.cells.map(c => c.y + c.height))
    const areaW = maxX - minX
    const areaH = maxY - minY
    const logoW = Math.min(areaW, (areaW * wm.size) / 100)
    const logoH = (logoW * logo.height) / logo.width
    const margin = Math.min(areaW, areaH) * 0.03
    const x = wm.position.endsWith('Left')
      ? minX + margin
      : wm.position.endsWith('Right')
        ? maxX - logoW - margin
        : minX + (areaW - logoW) / 2
    const y = wm.position.startsWith('top')
      ? minY + margin
      : wm.position.startsWith('bottom')
        ? maxY - logoH - margin
        : minY + (areaH - logoH) / 2
    const logoWidth = Math.max(1, Math.round(logoW * factor))
    const logoHeight = Math.max(1, Math.round(logoH * factor))
    validateDimensions(logoWidth, logoHeight)
    const opacity = Math.max(0, Math.min(1, wm.opacity / 100))
    const input = await openImage(await toWorkingImage(logo.path))
      .resize(logoWidth, logoHeight, { fit: 'fill' })
      .ensureAlpha()
      .linear([1, 1, 1, opacity], [0, 0, 0, 0])
      .toColourspace('rgb16')
      .withIccProfile('p3')
      .tiff({ compression: 'lzw' })
      .toBuffer()
    await addClipped(
      input,
      Math.round((x - view.x) * factor),
      Math.round((y - view.y) * factor),
    )
  }
  const matte = await toWorkingImage(
    await sharp({
      create: { width: 1, height: 1, channels: 3, background: snapshot.mat },
    })
      .png()
      .toBuffer(),
  )
  const pipeline = openImage(matte)
    .resize(width, height, { fit: 'fill' })
    .pipelineColourspace('rgb16')
    .composite(overlays)
    .toColourspace('rgb16')
    .withIccProfile('p3')
  return { pipeline, layout }
}
