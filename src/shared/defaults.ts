import type { Composition, GridNode, Transform } from './contracts'

export function identityTransform(): Transform {
  return {
    rotation: 0,
    flipX: false,
    flipY: false,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    aspect: 'Original',
  }
}
export function gridTemplate(name = '2x2', photoIds: string[] = []): GridNode {
  let i = 0
  const leaf = (): GridNode => ({
    id: crypto.randomUUID(),
    type: 'leaf',
    photoId: photoIds[i++] ?? null,
  })
  const split = (
    axis: 'horizontal' | 'vertical',
    children: GridNode[],
  ): GridNode => ({
    id: crypto.randomUUID(),
    type: 'split',
    axis,
    children,
    weights: children.map(() => 1 / children.length),
  })
  if (name === '1x2')
    return split('horizontal', [leaf(), leaf()])
  if (name === '2x1')
    return split('vertical', [leaf(), leaf()])
  if (name === '1+2')
    return split('horizontal', [leaf(), split('vertical', [leaf(), leaf()])])
  if (name === '1over2')
    return split('vertical', [leaf(), split('horizontal', [leaf(), leaf()])])
  const n = name === '3x3' ? 3 : 2
  return split(
    'vertical',
    Array.from({ length: n }, () =>
      split('horizontal', Array.from({ length: n }, leaf))),
  )
}
export function defaults(): Composition {
  return {
    revision: 0,
    panels: [],
    layout: 'horizontal',
    units: 'percent',
    separateFrame: false,
    mat: '#FFFFFF',
    percent: {
      gap: 2,
      frame: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      captionTop: 3,
      captionBottom: 3,
      captionHorizontal: 3,
    },
    pixels: {
      gap: 24,
      frame: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      captionTop: 30,
      captionBottom: 30,
      captionHorizontal: 30,
    },
    grid: gridTemplate(),
    gridAspect: '1:1',
    caption: {
      enabled: false,
      style: 'studio',
      title: '',
      copyright: '',
      showExif: true,
      perPhoto: false,
      sourceId: null,
      fields: ['camera', 'lens', 'focal', 'aperture', 'shutter', 'iso'],
      size: 100,
      separatePadding: false,
    },
    watermark: {
      photoId: null,
      position: 'bottomRight',
      opacity: 100,
      size: 20,
    },
    print: {
      enabled: false,
      paper: '30 × 40 cm',
      width: 30,
      height: 40,
      units: 'cm',
      orientation: 'auto',
      fit: 'fit',
    },
    output: {
      size: '',
      format: 'jpeg',
      quality: 92,
      depth: 8,
      profile: 'srgb',
      dpi: 72,
      metadataId: null,
    },
  }
}
export const matColors = [
  '#FFFFFF',
  '#F4EFE3',
  '#E7DECB',
  '#B8B0A2',
  '#6E6A62',
  '#2E2D2B',
  '#101010',
  '#000000',
]
