import type { Buffer } from 'node:buffer'
import type { Composition, PreviewResult } from '../../shared/contracts'
import type { ImageAsset } from './composition'
import { stat } from 'node:fs/promises'
import sharp from 'sharp'
import { calculateLayout } from '../../shared/layout'
import { createCaptionRenderer } from './captions'
import { outputProfile } from './color'
import { gesturePreview } from './composition'
import { openImage } from './index'
import { PreviewCache } from './preview-cache'

const watermarkPreviewCache = new PreviewCache(16 * 1024 * 1024)
const captionPreviewPixels = new WeakMap<
  Buffer,
  { factor: number, profile: string, dataUrl: string }
>()

/** Photo layers stay decoded in Chromium; only caption pixels cross the worker boundary. */
export async function annotationPreview(
  snapshot: Composition,
  assets: ImageAsset[],
  resources: string,
  maxSize: number,
  knownGestureImagesKey?: string,
): Promise<PreviewResult> {
  const captions = createCaptionRenderer(
    snapshot,
    new Map(assets.map(asset => [asset.id, asset])),
    resources,
    true,
  )
  const layout = await calculateLayout(
    snapshot,
    assets,
    async (id, width, scale) => (await captions(id, width, scale)).height,
  )
  const renderedCaptions = await Promise.all(
    layout.captions.map(async cap => ({
      cap,
      text: await captions(
        cap.photoId,
        Math.max(1, cap.width - cap.paddingX * 2),
        cap.scale,
      ),
    })),
  )
  const annotationArea
    = renderedCaptions.reduce(
      (sum, { text }) =>
        sum
        + text.pieces.reduce(
          (area, piece) => area + piece.width * piece.height,
          0,
        ),
      0,
    ) + (snapshot.watermark.photoId ? 2200 * 2200 : 0)
  const annotationFactor = Math.min(
    1,
    Math.sqrt((16 * 1024 * 1024) / 24 / Math.max(1, annotationArea)),
  )
  const factor = Math.min(
    annotationFactor,
    maxSize / Math.max(layout.width, layout.height),
  )
  const profile = outputProfile(snapshot.output.profile, resources)
  const annotationLayers: NonNullable<PreviewResult['annotationLayers']> = []
  for (const { cap, text } of renderedCaptions) {
    for (const piece of text.pieces) {
      const rasterFactor = Math.min(
        annotationFactor,
        Math.ceil(factor * 16) / 16,
      )
      let pixels = captionPreviewPixels.get(piece.input)
      if (
        !pixels
        || pixels.factor !== rasterFactor
        || pixels.profile !== profile
      ) {
        const data = await sharp(piece.input)
          .resize(
            Math.max(1, Math.round(piece.width * rasterFactor)),
            Math.max(1, Math.round(piece.height * rasterFactor)),
            { fit: 'fill' },
          )
          .withIccProfile(profile)
          .toColourspace('srgb')
          .png()
          .toBuffer()
        pixels = {
          factor: rasterFactor,
          profile,
          dataUrl: `data:image/png;base64,${data.toString('base64')}`,
        }
        captionPreviewPixels.set(piece.input, pixels)
      }
      annotationLayers.push({
        x: cap.x + cap.paddingX + piece.x,
        y: cap.y + cap.paddingTop + piece.y,
        width: piece.width,
        height: piece.height,
        dataUrl: pixels.dataUrl,
      })
    }
  }
  const wm = snapshot.watermark
  if (wm.photoId && wm.size > 0 && wm.opacity > 0 && layout.cells.length) {
    const logo = assets.find(asset => asset.id === wm.photoId)
    if (!logo)
      throw new Error('Watermark image is unavailable')
    const minX = Math.min(...layout.cells.map(cell => cell.x))
    const minY = Math.min(...layout.cells.map(cell => cell.y))
    const areaW
      = Math.max(...layout.cells.map(cell => cell.x + cell.width)) - minX
    const areaH
      = Math.max(...layout.cells.map(cell => cell.y + cell.height)) - minY
    const width = Math.min(areaW, (areaW * wm.size) / 100)
    const height = (width * logo.height) / logo.width
    const margin = Math.min(areaW, areaH) * 0.03
    const x = wm.position.endsWith('Left')
      ? minX + margin
      : wm.position.endsWith('Right')
        ? minX + areaW - width - margin
        : minX + (areaW - width) / 2
    const y = wm.position.startsWith('top')
      ? minY + margin
      : wm.position.startsWith('bottom')
        ? minY + areaH - height - margin
        : minY + (areaH - height) / 2
    const info = await stat(logo.path)
    const key = JSON.stringify([
      profile,
      annotationFactor,
      logo.path,
      info.size,
      info.mtimeMs,
      info.ctimeMs,
    ])
    const pixels = await watermarkPreviewCache.get(key, () =>
      openImage(logo.path)
        .resize({
          width: Math.max(1, Math.floor(2200 * annotationFactor)),
          height: Math.max(1, Math.floor(2200 * annotationFactor)),
          fit: 'inside',
          withoutEnlargement: true,
        })
        .withIccProfile(profile)
        .toColourspace('srgb')
        .png()
        .toBuffer())
    annotationLayers.push({
      x,
      y,
      width,
      height,
      opacity: wm.opacity / 100,
      dataUrl: `data:image/png;base64,${pixels.toString('base64')}`,
    })
  }
  return {
    revision: snapshot.revision,
    layout,
    dataUrl: '',
    annotationLayers,
    ...(await gesturePreview(snapshot, assets, knownGestureImagesKey, {
      layout,
      maxSize,
      resources,
    })),
  }
}
