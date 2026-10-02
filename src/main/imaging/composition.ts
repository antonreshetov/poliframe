import type { Buffer } from 'node:buffer'
import type { OverlayOptions, Sharp } from 'sharp'
import type {
  CaptionStyle,
  Composition,
  LayoutResult,
  Photo,
  PreviewResult,
  Rect,
  Transform,
} from '../../shared/contracts'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { calculateLayout, effectiveSize } from '../../shared/layout'
import { toWorkingImage, toWorkingPipeline } from './color'
import { MAX_IMAGE_PIXELS, openImage, validateDimensions } from './index'
import { PreviewCache } from './preview-cache'

const previewSources = new PreviewCache(96 * 1024 * 1024)
const previewTiles = new PreviewCache(48 * 1024 * 1024)

export interface ImageAsset extends Photo {
  path: string
}
type Role = 'title' | 'camera' | 'exif' | 'copyright'
type Face = [string, number, number, boolean?]
const styles: Record<CaptionStyle, Record<Role, Face>> = {
  studio: {
    title: ['Inter-SemiBold', 16, -0.01],
    camera: ['Inter-Medium', 11.5, 0.01],
    copyright: ['Inter-Regular', 12.5, 0],
    exif: ['JetBrainsMono-Regular', 11, 0.04],
  },
  retro: {
    title: ['MartianMono-Bold', 14, 0],
    camera: ['MartianMono-Bold', 11, 0],
    copyright: ['MartianMono-Regular', 10, 0],
    exif: ['MartianMono-Regular', 11, 0],
  },
  editorial: {
    title: ['CormorantGaramond-MediumItalic', 23, 0],
    camera: ['Inter-Regular', 11, 0.08],
    copyright: ['Inter-Light', 11, 0.06],
    exif: ['Inter-Regular', 11, 0.14, true],
  },
  museum: {
    title: ['CormorantGaramond-MediumItalic', 27, 0],
    camera: ['Inter-Regular', 11, 0.1],
    exif: ['Inter-Light', 11, 0.16, true],
    copyright: ['CormorantGaramond-Medium', 13, 0.04],
  },
  minimal: {
    title: ['GeistMono-Medium', 13, 0.22, true],
    camera: ['GeistMono-Regular', 11, 0.12],
    exif: ['GeistMono-Light', 11, 0.18],
    copyright: ['GeistMono-Regular', 10, 0.14],
  },
  classic: {
    title: ['PlayfairDisplay-MediumItalic', 25, 0],
    camera: ['IBMPlexMono-Regular', 11, 0.1],
    exif: ['IBMPlexMono-Light', 11, 0.14],
    copyright: ['PlayfairDisplay-MediumItalic', 13, 0],
  },
  luxe: {
    title: ['Montserrat-Light', 13, 0.38, true],
    camera: ['Montserrat-Regular', 10, 0.2, true],
    exif: ['Montserrat-Light', 10, 0.24, true],
    copyright: ['Montserrat-Light', 9, 0.3, true],
  },
}
const families: Record<string, string> = {
  Inter: 'Inter',
  JetBrainsMono: 'JetBrains Mono',
  MartianMono: 'Martian Mono',
  CormorantGaramond: 'Cormorant Garamond',
  GeistMono: 'Geist Mono',
  PlayfairDisplay: 'Playfair Display',
  IBMPlexMono: 'IBM Plex Mono',
  Montserrat: 'Montserrat',
}
const separators: Record<CaptionStyle, string> = {
  studio: ' / ',
  retro: ' · ',
  editorial: ' · ',
  museum: ' · ',
  minimal: ' | ',
  classic: ' — ',
  luxe: '   ',
}
function escape(text: string) {
  return text.replace(
    /[&<>"']/g,
    ch =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&apos;',
      })[ch]!,
  )
}
interface TextPiece {
  input: Buffer
  x: number
  y: number
}
interface CaptionImage {
  pieces: TextPiece[]
  height: number
}

function inks(mat: string): Record<Role | 'rule', string> {
  const colors
    = mat.toUpperCase() === '#B8B0A2'
      ? ['#232220', '#3D3A35', '#55514A', '#5C5850', '#8A8478']
      : mat.toUpperCase() === '#6E6A62'
        ? ['#F7F4EE', '#E2DDD3', '#CDC7BB', '#C4BDB1', '#A09A8E']
        : ['#2E2D2B', '#101010', '#000000'].includes(mat.toUpperCase())
            ? ['#F2EEE7', '#C8C2B6', '#938D82', '#8A8278', '#4A4843']
            : ['#2F2D2A', '#67635B', '#9F9A90', '#A7A197', '#CFC9BF']
  return {
    title: colors[0]!,
    camera: colors[1]!,
    exif: colors[2]!,
    copyright: colors[3]!,
    rule: colors[4]!,
  }
}

const captionCache = new Map<string, CaptionImage>()
let captionCacheBytes = 0
const captionCacheBudget = 32 * 1024 * 1024

function textRenderer(
  s: Composition,
  assets: Map<string, ImageAsset>,
  resources: string,
  preview = false,
) {
  const cache = new Map<string, Promise<CaptionImage>>()
  return (
    photoId: string | null,
    width: number,
    scale: number,
  ): Promise<CaptionImage> => {
    const key = JSON.stringify([
      preview,
      resources,
      s.caption,
      s.mat,
      photoId ? assets.get(photoId)?.exif : null,
      width,
      scale,
    ])
    const cached = captionCache.get(key)
    if (cached) {
      captionCache.delete(key)
      captionCache.set(key, cached)
      return Promise.resolve(cached)
    }
    const previous = cache.get(key)
    if (previous)
      return previous
    const pending = (async () => {
      const photo = photoId ? assets.get(photoId) : undefined
      const fields = s.caption.showExif ? s.caption.fields : []
      const values = (keys: string[]) =>
        keys
          .filter(k => fields.includes(k))
          .map(k => photo?.exif[k as keyof Photo['exif']])
          .filter(Boolean)
      const text: Record<Role, string> = {
        title: s.caption.title.trim(),
        copyright: s.caption.copyright.trim(),
        camera: values(['camera', 'lens']).join(
          s.caption.style === 'classic' ? ' — ' : ' · ',
        ),
        exif: values(['iso', 'focal', 'aperture', 'shutter', 'date']).join(
          separators[s.caption.style],
        ),
      }
      const colors = inks(s.mat)
      const out: CaptionImage = { pieces: [], height: 0 }
      const render = async (
        role: Role,
        available: number,
        align: 'left' | 'right' | 'center',
      ) => {
        if (!text[role])
          return null
        if (text[role].length > 4096)
          throw new Error('Caption text exceeds the render budget')
        const [face, pointSize, tracking, upper]
          = styles[s.caption.style][role]
        const [family, weight] = face.split('-')
        const font = `${families[family!]} ${weight!.replace('SemiBold', 'Semi-Bold').replace('Italic', ' Italic')} ${Math.max(1, pointSize * scale)}`
        const content = escape(upper ? text[role].toUpperCase() : text[role])
        const { data, info } = await sharp({
          text: {
            text: `<span foreground="${colors[role]}" letter_spacing="${Math.round(tracking * pointSize * scale * 1024)}">${content}</span>`,
            font,
            fontfile: join(resources, 'fonts', `${face}.ttf`),
            width: Math.max(1, Math.floor(available)),
            rgba: true,
            align,
            dpi: 72,
          },
          limitInputPixels: MAX_IMAGE_PIXELS,
        })
          .png()
          .toBuffer({ resolveWithObject: true })
        return {
          input: preview ? data : await toWorkingImage(data),
          width: info.width,
          height: info.height,
          size: pointSize * scale,
        }
      }
      const inline = ['studio', 'retro', 'editorial'].includes(s.caption.style)
      if (inline) {
        const colGap = (s.caption.style === 'retro' ? 16 : 20) * scale
        const colWidth = Math.max(1, (width - colGap) / 2)
        const rows: [Role, Role][]
          = s.caption.style === 'retro'
            ? [
                ['camera', 'title'],
                ['exif', 'copyright'],
              ]
            : [
                ['title', 'camera'],
                ['copyright', 'exif'],
              ]
        for (const roles of rows) {
          const [left, right] = await Promise.all([
            render(roles[0], colWidth, 'left'),
            render(roles[1], colWidth, 'right'),
          ])
          if (!left && !right)
            continue
          if (out.height)
            out.height += (s.caption.style === 'editorial' ? 12 : 11) * scale
          const baseline = Math.max(left?.size ?? 0, right?.size ?? 0)
          let bottom = out.height
          for (const [i, item] of [left, right].entries()) {
            if (!item)
              continue
            const y = out.height + baseline - item.size
            out.pieces.push({
              input: item.input,
              x: i === 0 ? 0 : Math.max(0, width - item.width),
              y,
            })
            bottom = Math.max(bottom, y + item.height)
          }
          out.height = bottom
        }
      }
      else {
        const margins
          = s.caption.style === 'luxe'
            ? [0, 18, 8, 16]
            : s.caption.style === 'classic'
              ? [0, 16, 7, 14]
              : [0, 14, 7, 14]
        const roles: Role[] = ['title', 'camera', 'exif', 'copyright']
        for (const [i, role] of roles.entries()) {
          if (i === 1 && s.caption.style === 'museum' && text.title) {
            out.height += 16 * scale
            const ruleWidth = Math.max(
              1,
              Math.round(Math.min(width, 34 * scale)),
            )
            const ruleHeight = Math.max(1, Math.round(scale))
            const rule = await sharp({
              create: {
                width: ruleWidth,
                height: ruleHeight,
                channels: 4,
                background: colors.rule,
              },
            })
              .toColourspace('rgb16')
              .withIccProfile('p3')
              .tiff({ compression: 'lzw' })
              .toBuffer()
            out.pieces.push({
              input: await toWorkingImage(rule),
              x: Math.max(0, (width - ruleWidth) / 2),
              y: out.height,
            })
            out.height += ruleHeight + 16 * scale
          }
          const item = await render(role, width, 'center')
          if (!item)
            continue
          if (out.height && !(s.caption.style === 'museum' && i === 1))
            out.height += margins[i]! * scale
          out.pieces.push({
            input: item.input,
            x: Math.max(0, (width - item.width) / 2),
            y: out.height,
          })
          out.height += item.height
        }
      }
      return out
    })()
    const remembered = pending.then((result) => {
      const bytes = result.pieces.reduce(
        (sum, piece) => sum + piece.input.byteLength,
        0,
      )
      if (bytes <= captionCacheBudget) {
        while (
          (captionCacheBytes + bytes > captionCacheBudget
            || captionCache.size >= 128)
          && captionCache.size
        ) {
          const oldest = captionCache.keys().next().value!
          captionCacheBytes -= captionCache
            .get(oldest)!
            .pieces
            .reduce((sum, piece) => sum + piece.input.byteLength, 0)
          captionCache.delete(oldest)
        }
        captionCache.set(key, result)
        captionCacheBytes += bytes
      }
      return result
    })
    cache.set(key, remembered)
    return remembered
  }
}

/** Rotate, flip, then crop in oriented image coordinates; each materialized stage stays 16-bit. */
export async function transformImage(
  asset: ImageAsset,
  transform: Transform,
  width: number,
  height: number,
  region?: Rect,
  previewSource?: Buffer,
): Promise<Buffer> {
  effectiveSize(asset, transform)
  validateDimensions(region?.width ?? width, region?.height ?? height)
  let pipeline = previewSource
    ? openImage(previewSource)
    : await toWorkingPipeline(asset.path)
  let source = (await sharp(previewSource ?? asset.path).metadata()).autoOrient
  if (transform.rotation % 360) {
    const normalized = await pipeline.toBuffer()
    const data = await openImage(normalized)
      .rotate(transform.rotation)
      .toColourspace('rgb16')
      .withIccProfile('p3')
      .tiff({ compression: 'lzw' })
      .toBuffer()
    pipeline = openImage(data)
    source = (await sharp(data).metadata()).autoOrient
  }
  if (transform.flipX || transform.flipY) {
    const data = await pipeline
      .flop(transform.flipX)
      .flip(transform.flipY)
      .toColourspace('rgb16')
      .withIccProfile('p3')
      .tiff({ compression: 'lzw' })
      .toBuffer()
    pipeline = openImage(data)
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
    .tiff({ compression: 'lzw' })
    .toBuffer()
}

async function previewTile(
  asset: ImageAsset,
  transform: Transform,
  width: number,
  height: number,
  region: Rect,
  sourceSize: number,
): Promise<Buffer> {
  const info = await stat(asset.path)
  const identity = JSON.stringify([
    asset.path,
    info.size,
    info.mtimeMs,
    info.ctimeMs,
  ])
  const bucket = sourceSize > 4096 ? 0 : sourceSize <= 2200 ? 2200 : 4096
  const key = JSON.stringify([
    identity,
    transform,
    width,
    height,
    region,
    bucket,
  ])
  return previewTiles.get(key, async () => {
    let source: Buffer | undefined
    if (bucket) {
      source = await previewSources.get(`${identity}:${bucket}`, async () =>
        (await toWorkingPipeline(asset.path))
          .resize({
            width: bucket,
            height: bucket,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .tiff({ compression: 'none' })
          .toBuffer())
    }
    return transformImage(asset, transform, width, height, region, source)
  })
}

const gestureCache = new PreviewCache(24 * 1024 * 1024)
/** Native gridLeafGestureImages equivalent: transformed photo, before cell cover-crop. */
export async function gestureImages(
  snapshot: Composition,
  assets: ImageAsset[],
): Promise<NonNullable<PreviewResult['gestureImages']>> {
  const result: NonNullable<PreviewResult['gestureImages']> = []
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
  for (const panel of snapshot.panels) {
    if (!visible.has(panel.photoId))
      continue
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
      const tile = await previewTile(
        asset,
        panel.transform,
        width,
        height,
        { x: 0, y: 0, width, height },
        2200
        / Math.min(panel.transform.crop.width, panel.transform.crop.height),
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
  const captions = textRenderer(snapshot, byId, resourcesPath)
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
      const crop = panel.transform.crop
      const sourceSize = region
        ? Infinity
        : Math.max(
            2200,
            Math.ceil(maxSize / Math.min(crop.width, crop.height)),
          )
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
      const info = await sharp(piece.input).metadata()
      const input
        = factor === 1
          ? piece.input
          : await sharp(piece.input)
              .resize(
                Math.max(1, Math.round(info.width * factor)),
                Math.max(1, Math.round(info.height * factor)),
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

const watermarkPreviewCache = new PreviewCache(16 * 1024 * 1024)
const captionPreviewPixels = new WeakMap<
  Buffer,
  { factor: number, dataUrl: string }
>()

/** Photo layers stay decoded in Chromium; only caption pixels cross the worker boundary. */
export async function annotationPreview(
  snapshot: Composition,
  assets: ImageAsset[],
  resources: string,
  maxSize: number,
): Promise<PreviewResult> {
  const captions = textRenderer(
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
  const factor = Math.min(1, maxSize / Math.max(layout.width, layout.height))
  const annotationLayers: NonNullable<PreviewResult['annotationLayers']> = []
  for (const cap of layout.captions) {
    const text = await captions(
      cap.photoId,
      Math.max(1, cap.width - cap.paddingX * 2),
      cap.scale,
    )
    for (const piece of text.pieces) {
      const info = await sharp(piece.input).metadata()
      const rasterFactor = Math.min(1, Math.ceil(factor * 16) / 16)
      let pixels = captionPreviewPixels.get(piece.input)
      if (!pixels || pixels.factor !== rasterFactor) {
        const data = await sharp(piece.input)
          .resize(
            Math.max(1, Math.round(info.width! * rasterFactor)),
            Math.max(1, Math.round(info.height! * rasterFactor)),
          )
          .withIccProfile('srgb')
          .toColourspace('srgb')
          .png()
          .toBuffer()
        pixels = {
          factor: rasterFactor,
          dataUrl: `data:image/png;base64,${data.toString('base64')}`,
        }
        captionPreviewPixels.set(piece.input, pixels)
      }
      annotationLayers.push({
        x: cap.x + cap.paddingX + piece.x,
        y: cap.y + cap.paddingTop + piece.y,
        width: info.width!,
        height: info.height!,
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
      logo.path,
      info.size,
      info.mtimeMs,
      info.ctimeMs,
    ])
    const pixels = await watermarkPreviewCache.get(key, () =>
      openImage(logo.path)
        .resize({
          width: 2200,
          height: 2200,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .withIccProfile('srgb')
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
    gestureImages: await gestureImages(snapshot, assets),
  }
}
