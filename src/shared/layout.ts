import type {
  CaptionBlock,
  CellLayout,
  Composition,
  GridNode,
  LayoutResult,
  Photo,
  Rect,
  Transform,
} from './contracts'

export interface RenderCaption extends CaptionBlock {
  scale: number
  paddingX: number
  paddingTop: number
}
export interface RenderLayout extends LayoutResult {
  captions: RenderCaption[]
  masks: Rect[]
}
export type CaptionMeasure = (
  photoId: string | null,
  width: number,
  scale: number,
) => Promise<number>
const positive = (value: number) => Number.isFinite(value) && value > 0

export function effectiveSize(
  photo: Pick<Photo, 'width' | 'height'>,
  transform: Transform,
): { width: number, height: number } {
  const { crop, rotation } = transform
  if (
    ![photo.width, photo.height, crop.width, crop.height].every(positive)
    || ![crop.x, crop.y, rotation].every(Number.isFinite)
    || crop.x < 0
    || crop.y < 0
    || crop.x + crop.width > 1.000001
    || crop.y + crop.height > 1.000001
    || rotation % 90 !== 0
  ) {
    throw new Error('Invalid image transform')
  }
  const swapped = Math.abs(rotation / 90) % 2 === 1
  return {
    width: (swapped ? photo.height : photo.width) * crop.width,
    height: (swapped ? photo.width : photo.height) * crop.height,
  }
}

export function parseOutputSize(value: string): {
  axis: 'native' | 'scale' | 'width' | 'height'
  value: number
} {
  const match = /^(\d+(?:\.\d+)?|\.\d+)([xwh]?)$/i.exec(value.trim())
  if (!match || !positive(Number(match[1])))
    return { axis: 'native', value: 1 }
  return {
    axis:
      match[2]?.toLowerCase() === 'x'
        ? 'scale'
        : match[2]?.toLowerCase() === 'h'
          ? 'height'
          : 'width',
    value: Number(match[1]),
  }
}

export function paperSize(
  snapshot: Composition,
  landscape: boolean,
): { width: number, height: number } {
  const p = snapshot.print
  const factor = p.units === 'in' ? 1 : p.units === 'mm' ? 1 / 25.4 : 1 / 2.54
  let width = p.width * factor
  let height = p.height * factor
  if (![width, height].every(positive))
    throw new Error('Invalid paper dimensions')
  const wantsLandscape
    = p.orientation === 'landscape' || (p.orientation === 'auto' && landscape)
  const isLandscape = width > height
  if (isLandscape !== wantsLandscape)
    [width, height] = [height, width]
  return { width, height }
}

function leaves(
  node: GridNode,
  rect: Rect,
  gap: number,
  result: CellLayout[],
  depth = 0,
): void {
  if (depth > 16 || result.length > 256)
    throw new Error('Grid exceeds the render budget')
  if (node.type === 'leaf') {
    result.push({ ...rect, id: node.id, photoId: node.photoId })
    return
  }
  if (
    !node.children.length
    || node.children.length !== node.weights.length
    || !node.weights.every(positive)
  ) {
    throw new Error('Invalid grid weights')
  }
  const horizontal = node.axis === 'horizontal'
  const length
    = (horizontal ? rect.width : rect.height) - gap * (node.children.length - 1)
  if (length < node.children.length)
    throw new Error('Grid gap leaves no image area')
  const sum = node.weights.reduce((a, b) => a + b, 0)
  let offset = 0
  node.children.forEach((child, i) => {
    const size = (length * node.weights[i]!) / sum
    leaves(
      child,
      horizontal
        ? { x: rect.x + offset, y: rect.y, width: size, height: rect.height }
        : { x: rect.x, y: rect.y + offset, width: rect.width, height: size },
      gap,
      result,
      depth + 1,
    )
    offset += size + gap
  })
}

/** Lightweight grid geometry shared by interactive dragging and native composition. */
export function gridCells(
  node: GridNode,
  rect: Rect,
  gap: number,
): CellLayout[] {
  const cells: CellLayout[] = []
  leaves(node, rect, gap, cells)
  return cells
}

/** Shared output geometry. A native text measurer is supplied by the renderer. */
export async function calculateLayout(
  s: Composition,
  photos: Photo[],
  measure?: CaptionMeasure,
): Promise<RenderLayout> {
  const photoMap = new Map(photos.map(p => [p.id, p]))
  const sizes = new Map(
    s.panels.map((p) => {
      const photo = photoMap.get(p.photoId)
      if (!photo)
        throw new Error(`Image is unavailable: ${p.photoId}`)
      return [p.photoId, effectiveSize(photo, p.transform)] as const
    }),
  )
  if (s.panels.length > 256)
    throw new Error('Too many images')
  if (s.layout !== 'grid' && !s.panels.length)
    throw new Error('Add an image to begin')
  const m = s.units === 'pixels' ? s.pixels : s.percent
  if (Object.values(m).some(v => !Number.isFinite(v) || v < 0))
    throw new Error('Invalid frame or gap')
  const metric = (v: number, target: number) =>
    s.units === 'percent' ? (v * target) / 100 : v
  const frames = (target: number) =>
    Object.fromEntries(
      ['top', 'right', 'bottom', 'left'].map(side => [
        side,
        metric(s.separateFrame ? m[side as 'top'] : m.frame, target),
      ]),
    ) as Record<'top' | 'right' | 'bottom' | 'left', number>
  const caption = async (
    photoId: string | null,
    width: number,
    target: number,
  ): Promise<RenderCaption> => {
    const scale = (target / 540) * Math.max(0.01, s.caption.size / 100)
    const paddingX = metric(m.captionHorizontal, target)
    const paddingTop = metric(m.captionTop, target)
    const bottom = metric(
      s.caption.separatePadding ? m.captionBottom : m.captionTop,
      target,
    )
    if (s.caption.enabled && !measure)
      throw new Error('Native caption measurement is required')
    const textHeight = s.caption.enabled
      ? await measure!(photoId, Math.max(1, width - 2 * paddingX), scale)
      : 0
    return {
      x: 0,
      y: 0,
      width,
      height: textHeight > 0 ? textHeight + paddingTop + bottom : 0,
      photoId,
      scale,
      paddingX,
      paddingTop,
    }
  }
  const empty = (width: number, height: number): RenderLayout => ({
    width,
    height,
    nativeWidth: 0,
    nativeHeight: 0,
    dpi: s.output.dpi,
    cells: [],
    captions: [],
    masks: [],
    warnings: [],
  })
  const horizontal = s.layout !== 'vertical'
  const rawSizes = [...sizes.values()]
  const naturalAspect
    = s.layout === 'grid'
      ? Number(s.gridAspect.split(':')[0]) / Number(s.gridAspect.split(':')[1])
      : horizontal
        ? rawSizes.reduce((v, p) => v + p.width / p.height, 0)
        : 1 / rawSizes.reduce((v, p) => v + p.height / p.width, 0)
  const naturalPrintLayout = s.print.enabled
    ? await calculateLayout(
        {
          ...s,
          print: { ...s.print, enabled: false },
          output: { ...s.output, size: '' },
        },
        photos,
        measure,
      )
    : null
  const paper = s.print.enabled
    ? paperSize(s, naturalPrintLayout!.width >= naturalPrintLayout!.height)
    : null
  let nativeTarget
    = s.layout === 'grid'
      ? 2000
      : Math.min(...rawSizes.map(p => (horizontal ? p.height : p.width)))

  const strip = async (
    target: number,
    forceCommon = false,
  ): Promise<RenderLayout> => {
    const frame = frames(target)
    const gap = metric(m.gap, target)
    const dimensions = s.panels
      .map(p => sizes.get(p.photoId)!)
      .map(p =>
        horizontal
          ? { width: (p.width / p.height) * target, height: target }
          : { width: target, height: (p.height / p.width) * target },
      )
    const contentW = horizontal
      ? dimensions.reduce((v, p) => v + p.width, 0)
      + (dimensions.length - 1) * gap
      : target
    let contentH = horizontal
      ? target
      : dimensions.reduce((v, p) => v + p.height, 0)
        + (dimensions.length - 1) * gap
    const out = empty(contentW + frame.left + frame.right, 0)
    const perPhoto = s.caption.enabled && s.caption.perPhoto && !forceCommon
    let x = frame.left
    let y = frame.top
    for (const [i, size] of dimensions.entries()) {
      const photoId = s.panels[i]!.photoId
      out.cells.push({ x, y, ...size, id: photoId, photoId })
      if (perPhoto) {
        const cap = await caption(photoId, size.width, target)
        cap.x = x
        cap.y = y + size.height
        out.captions.push(cap)
        if (!horizontal) {
          contentH += cap.height
          y += cap.height
        }
      }
      if (horizontal)
        x += size.width + gap
      else y += size.height + gap
    }
    if (!perPhoto) {
      const cap = await caption(s.caption.sourceId, contentW, target)
      cap.x = frame.left
      cap.y = frame.top + contentH
      if (cap.height)
        out.captions.push(cap)
      contentH += cap.height
    }
    else if (horizontal) {
      contentH += Math.max(0, ...out.captions.map(c => c.height))
    }
    out.height = contentH + frame.top + frame.bottom
    if (paper) {
      // Fit preserves the native bare strip, extends to paper aspect, and fits decoration inside it.
      const baseH = horizontal
        ? target
        : dimensions.reduce((v, p) => v + p.height, 0)
          + (dimensions.length - 1) * gap
          + (perPhoto ? out.captions.reduce((v, c) => v + c.height, 0) : 0)
      const aspect = paper.width / paper.height
      const width = Math.max(contentW, baseH * aspect)
      const height = Math.max(baseH, contentW / aspect)
      const scale = Math.min(width / out.width, height / out.height)
      const dx = (width - out.width * scale) / 2
      const dy = (height - out.height * scale) / 2
      for (const rect of [...out.cells, ...out.captions]) {
        rect.x = rect.x * scale + dx
        rect.y = rect.y * scale + dy
        rect.width *= scale
        rect.height *= scale
      }
      for (const c of out.captions) {
        c.scale *= scale
        c.paddingX *= scale
        c.paddingTop *= scale
      }
      out.width = width
      out.height = height
    }
    return out
  }

  const grid = async (height: number): Promise<RenderLayout> => {
    const aspect = paper ? paper.width / paper.height : naturalAspect
    if (!positive(aspect))
      throw new Error('Invalid grid aspect')
    const width = height * aspect
    const target = Math.min(width, height)
    const f = frames(target)
    const cap = await caption(
      s.caption.sourceId,
      Math.max(1, width - f.left - f.right),
      target,
    )
    const inner = {
      x: f.left,
      y: f.top,
      width: width - f.left - f.right,
      height: height - f.top - f.bottom - cap.height,
    }
    if (inner.width < 1 || inner.height < 1)
      throw new Error('Frame or caption leaves no image area')
    const out = empty(width, height)
    leaves(s.grid, inner, metric(m.gap, target), out.cells)
    if (cap.height)
      out.captions.push({ ...cap, x: f.left, y: f.top + inner.height })
    return out
  }

  const fill = async (target: number): Promise<RenderLayout> => {
    const aspect = paper!.width / paper!.height
    const width = horizontal ? target * aspect : target
    const height = width / aspect
    const out = empty(width, height)
    const f = frames(target)
    const gap = metric(m.gap, target)
    const n = s.panels.length
    for (const [i, p] of s.panels.entries()) {
      out.cells.push({
        id: p.photoId,
        photoId: p.photoId,
        x: horizontal ? (width * i) / n : 0,
        y: horizontal ? 0 : (height * i) / n,
        width: horizontal ? width / n : width,
        height: horizontal ? height : height / n,
      })
      if (i) {
        out.masks.push(
          horizontal
            ? { x: (width * i) / n - gap / 2, y: 0, width: gap, height }
            : { x: 0, y: (height * i) / n - gap / 2, width, height: gap },
        )
      }
    }
    out.masks.push(
      { x: 0, y: 0, width, height: f.top },
      { x: 0, y: height - f.bottom, width, height: f.bottom },
      { x: 0, y: 0, width: f.left, height },
      { x: width - f.right, y: 0, width: f.right, height },
    )
    const fit = await strip(target, true)
    const fitCaption = fit.captions[0]
    if (fitCaption) {
      const cap = {
        ...fitCaption,
        x: f.left,
        y: Math.max(f.top, height - f.bottom - fitCaption.height),
        width: Math.max(1, width - f.left - f.right),
      }
      out.captions.push(cap)
      out.masks.push({ x: 0, y: cap.y, width, height: height - cap.y })
    }
    return out
  }

  const isFill = !!paper && s.print.fit === 'fill' && s.layout !== 'grid'
  const build = s.layout === 'grid' ? grid : isFill ? fill : strip
  if (s.layout === 'grid') {
    for (let i = 0; i < 4; i++) {
      const layout = await grid(nativeTarget)
      const factors = layout.cells.flatMap((c) => {
        const size = c.photoId ? sizes.get(c.photoId) : null
        return size
          ? [Math.min(size.width / c.width, size.height / c.height)]
          : []
      })
      if (!factors.length)
        break
      nativeTarget = Math.max(1, nativeTarget * Math.min(...factors))
    }
  }
  else if (isFill) {
    const aspect = paper!.width / paper!.height
    const n = s.panels.length
    nativeTarget = Math.min(
      ...rawSizes.map(p =>
        horizontal
          ? Math.min(p.width / (aspect / n), p.height)
          : Math.min(p.width, p.height * aspect * n),
      ),
    )
  }
  const native = await build(nativeTarget)
  const sizing = parseOutputSize(s.output.size)
  let target = nativeTarget
  if (paper && (s.layout === 'grid' || isFill)) {
    target
      = s.layout === 'grid' || horizontal
        ? paper.height * 300
        : paper.width * 300
  }
  else if (sizing.axis === 'scale') {
    target *= sizing.value
  }
  else if (sizing.axis !== 'native') {
    // The measured caption and fixed pixel padding are included in the sizing equation.
    for (let i = 0; i < 6; i++) {
      const candidate = await build(Math.max(1, target))
      target
        *= sizing.value
          / (sizing.axis === 'width' ? candidate.width : candidate.height)
      target = Math.min(nativeTarget * 4, Math.max(1, target))
    }
  }
  target = Math.min(nativeTarget * (isFill ? 1 : 4), Math.max(1, target))
  const result = await build(target)
  result.width = Math.max(1, Math.round(result.width))
  result.height = Math.max(1, Math.round(result.height))
  result.nativeWidth = Math.max(1, Math.round(native.width))
  result.nativeHeight = Math.max(1, Math.round(native.height))
  if (paper) {
    result.dpi = Math.max(1, Math.round(result.width / paper.width))
    result.nativeWidth = naturalPrintLayout!.width
    result.nativeHeight = naturalPrintLayout!.height
  }
  if (
    result.width > 32768
    || result.height > 32768
    || result.width * result.height > 100_000_000
  ) {
    result.warnings.push(
      'Composition exceeds the full-resolution render budget',
    )
  }
  return result
}
