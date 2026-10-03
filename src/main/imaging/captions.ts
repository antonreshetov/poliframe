import type { Buffer } from 'node:buffer'
import type { CaptionStyle, Composition, Photo } from '../../shared/contracts'
import { join } from 'node:path'
import sharp from 'sharp'
import { toWorkingImage } from './color'
import { captionFonts } from './fonts'
import { MAX_IMAGE_PIXELS } from './index'

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
  width: number
  height: number
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

interface RenderedLine {
  input: Buffer
  width: number
  height: number
  size: number
}
const lineCache = new Map<string, RenderedLine>()
let lineCacheBytes = 0
const lineCacheBudget = 8 * 1024 * 1024

const captionCache = new Map<string, CaptionImage>()
let captionCacheBytes = 0
const captionCacheBudget = 32 * 1024 * 1024

export function createCaptionRenderer(
  s: Composition,
  assets: Map<string, Photo>,
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
        const font = `${captionFonts[face]} ${Math.max(1, pointSize * scale)}`
        const content = escape(upper ? text[role].toUpperCase() : text[role])
        const size = pointSize * scale
        const textOptions = {
          text: `<span foreground="${colors[role]}" letter_spacing="${Math.round(tracking * pointSize * scale * 1024)}">${content}</span>`,
          font,
          fontfile: join(resources, 'fonts', `${face}.ttf`),
          width: Math.max(1, Math.floor(available)),
          rgba: true,
          align,
          dpi: 72,
        }
        const lineKey = JSON.stringify([preview, textOptions, size])
        const cachedLine = lineCache.get(lineKey)
        if (cachedLine) {
          lineCache.delete(lineKey)
          lineCache.set(lineKey, cachedLine)
          return cachedLine
        }
        const { data, info } = await sharp({
          text: textOptions,
          limitInputPixels: MAX_IMAGE_PIXELS,
        })
          .png()
          .toBuffer({ resolveWithObject: true })
        const result = {
          input: preview ? data : await toWorkingImage(data),
          width: info.width,
          height: info.height,
          size,
        }
        const bytes = result.input.byteLength
        if (bytes <= lineCacheBudget) {
          const previous = lineCache.get(lineKey)
          if (previous) {
            lineCacheBytes -= previous.input.byteLength
            lineCache.delete(lineKey)
          }
          while (
            (lineCacheBytes + bytes > lineCacheBudget
              || lineCache.size >= 128)
            && lineCache.size
          ) {
            const oldest = lineCache.keys().next().value!
            lineCacheBytes -= lineCache.get(oldest)!.input.byteLength
            lineCache.delete(oldest)
          }
          lineCache.set(lineKey, result)
          lineCacheBytes += bytes
        }
        return result
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
              width: item.width,
              height: item.height,
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
              width: ruleWidth,
              height: ruleHeight,
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
            width: item.width,
            height: item.height,
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
