import type { Composition, GridNode } from '../../shared/contracts'

function object(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function number(v: unknown, min: number, max: number): asserts v is number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    throw new Error('Invalid numeric setting')
}
function text(v: unknown, limit = 4096): asserts v is string {
  if (typeof v !== 'string' || v.length > limit)
    throw new Error('Invalid text setting')
}
function member(v: unknown, choices: unknown[]) {
  if (!choices.includes(v))
    throw new Error('Invalid option')
}
export function validateComposition(
  value: unknown,
): asserts value is Composition {
  if (!object(value) || JSON.stringify(value).length > 200_000)
    throw new Error('Invalid composition')
  const s = value as unknown as Composition
  number(s.revision, 0, Number.MAX_SAFE_INTEGER)
  member(s.layout, ['horizontal', 'vertical', 'grid'])
  member(s.units, ['percent', 'pixels'])
  if (!Array.isArray(s.panels) || s.panels.length > 128)
    throw new Error('Too many images')
  const photos = new Set<string>()
  for (const p of s.panels) {
    text(p.photoId, 64)
    if (photos.has(p.photoId))
      throw new Error('Duplicate image')
    photos.add(p.photoId)
    const t = p.transform
    if (!object(t) || !object(t.crop))
      throw new Error('Invalid crop')
    member(t.rotation, [0, 90, 180, 270])
    member(t.flipX, [true, false])
    member(t.flipY, [true, false])
    text(t.aspect, 32)
    number(t.crop.x, 0, 1)
    number(t.crop.y, 0, 1)
    number(t.crop.width, 0.001, 1)
    number(t.crop.height, 0.001, 1)
    if (
      t.crop.x + t.crop.width > 1.000001
      || t.crop.y + t.crop.height > 1.000001
    ) {
      throw new Error('Crop is outside the image')
    }
  }
  for (const [settings, max] of [
    [s.percent, 20],
    [s.pixels, 400],
  ] as const) {
    if (!object(settings))
      throw new Error('Invalid measurements')
    for (const key of [
      'gap',
      'frame',
      'top',
      'right',
      'bottom',
      'left',
      'captionTop',
      'captionBottom',
      'captionHorizontal',
    ] as const)
      number(settings[key], 0, max)
  }
  member(s.separateFrame, [true, false])
  if (!/^#[0-9a-f]{6}$/i.test(s.mat))
    throw new Error('Invalid mat color')
  const ids = new Set<string>()
  const assigned = new Set<string>()
  let count = 0
  function grid(n: GridNode, depth = 0) {
    if (!object(n) || ++count > 255 || depth > 32)
      throw new Error('Grid exceeds the editing budget')
    text(n.id, 64)
    if (ids.has(n.id))
      throw new Error('Duplicate grid cell')
    ids.add(n.id)
    if (n.type === 'leaf') {
      if (n.photoId !== null) {
        if (!photos.has(n.photoId) || assigned.has(n.photoId))
          throw new Error('Invalid grid photo')
        assigned.add(n.photoId)
      }
    }
    else if (n.type === 'split') {
      member(n.axis, ['horizontal', 'vertical'])
      if (
        !Array.isArray(n.children)
        || n.children.length < 2
        || n.children.length > 128
        || !Array.isArray(n.weights)
        || n.weights.length !== n.children.length
      ) {
        throw new Error('Invalid grid split')
      }
      n.weights.forEach(w => number(w, 0.001, 100))
      n.children.forEach(c => grid(c, depth + 1))
    }
    else {
      throw new Error('Invalid grid node')
    }
  }
  grid(s.grid)
  member(s.gridAspect, ['1:1', '4:5', '3:2', '2:3', '16:9', '9:16'])
  if (
    !object(s.caption)
    || !object(s.watermark)
    || !object(s.print)
    || !object(s.output)
  ) {
    throw new Error('Missing settings')
  }
  const c = s.caption
  for (const v of [
    c.enabled,
    c.showExif,
    c.perPhoto,
    c.separatePadding,
    s.print.enabled,
  ])
    member(v, [true, false])
  member(c.style, [
    'studio',
    'retro',
    'editorial',
    'museum',
    'minimal',
    'classic',
    'luxe',
  ])
  text(c.title)
  text(c.copyright)
  number(c.size, 20, 200)
  if (!Array.isArray(c.fields) || c.fields.length > 7)
    throw new Error('Invalid EXIF fields')
  c.fields.forEach(f =>
    member(f, [
      'camera',
      'lens',
      'focal',
      'aperture',
      'shutter',
      'iso',
      'date',
    ]),
  )
  for (const id of [c.sourceId, s.output.metadataId]) {
    if (id !== null && !photos.has(id))
      throw new Error('Missing metadata source')
  }
  if (s.watermark.photoId !== null)
    text(s.watermark.photoId, 64)
  member(s.watermark.position, [
    'topLeft',
    'topCenter',
    'topRight',
    'midLeft',
    'center',
    'midRight',
    'bottomLeft',
    'bottomCenter',
    'bottomRight',
  ])
  number(s.watermark.opacity, 0, 100)
  number(s.watermark.size, 5, 60)
  text(s.print.paper, 64)
  number(s.print.width, 0.01, 1000)
  number(s.print.height, 0.01, 1000)
  member(s.print.units, ['cm', 'mm', 'in'])
  member(s.print.orientation, ['auto', 'portrait', 'landscape'])
  member(s.print.fit, ['fit', 'fill'])
  text(s.output.size, 32)
  member(s.output.format, ['jpeg', 'png', 'tiff'])
  member(s.output.depth, [8, 16])
  member(s.output.profile, ['srgb', 'p3', 'adobe'])
  number(s.output.quality, 1, 100)
  number(s.output.dpi, 1, 2400)
}
