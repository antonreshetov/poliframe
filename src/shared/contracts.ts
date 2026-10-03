export type Units = 'percent' | 'pixels'
export type LayoutMode = 'horizontal' | 'vertical' | 'grid'
export type CaptionStyle
  = 'studio' | 'retro' | 'editorial' | 'museum' | 'minimal' | 'classic' | 'luxe'
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}
export interface Transform {
  rotation: number
  flipX: boolean
  flipY: boolean
  crop: Rect
  aspect: string
}
export interface Photo {
  id: string
  name: string
  width: number
  height: number
  thumbnail: string
  exif: Partial<
    Record<
      'camera' | 'lens' | 'focal' | 'aperture' | 'shutter' | 'iso' | 'date',
      string
    >
  >
}
export interface Panel {
  photoId: string
  transform: Transform
}
export interface GridLeaf {
  id: string
  type: 'leaf'
  photoId: string | null
}
export interface GridSplit {
  id: string
  type: 'split'
  axis: 'horizontal' | 'vertical'
  children: GridNode[]
  weights: number[]
}
export type GridNode = GridLeaf | GridSplit
export interface Measurements {
  gap: number
  frame: number
  top: number
  right: number
  bottom: number
  left: number
  captionTop: number
  captionBottom: number
  captionHorizontal: number
}
export interface Composition {
  revision: number
  panels: Panel[]
  layout: LayoutMode
  units: Units
  percent: Measurements
  pixels: Measurements
  separateFrame: boolean
  mat: string
  grid: GridNode
  gridAspect: string
  caption: {
    enabled: boolean
    style: CaptionStyle
    title: string
    copyright: string
    showExif: boolean
    perPhoto: boolean
    sourceId: string | null
    fields: string[]
    size: number
    separatePadding: boolean
  }
  watermark: {
    photoId: string | null
    position: string
    opacity: number
    size: number
  }
  print: {
    enabled: boolean
    paper: string
    width: number
    height: number
    units: 'cm' | 'mm' | 'in'
    orientation: 'auto' | 'portrait' | 'landscape'
    fit: 'fit' | 'fill'
  }
  output: {
    size: string
    format: 'jpeg' | 'png' | 'tiff'
    quality: number
    depth: 8 | 16
    profile: 'srgb' | 'p3' | 'adobe'
    dpi: number
    metadataId: string | null
  }
}
export interface CellLayout extends Rect {
  id: string
  photoId: string | null
}
export interface CaptionBlock extends Rect {
  photoId: string | null
}
export interface LayoutResult {
  masks?: Rect[]
  width: number
  height: number
  nativeWidth: number
  nativeHeight: number
  dpi: number
  cells: CellLayout[]
  captions: CaptionBlock[]
  warnings: string[]
}
export interface PreviewResult {
  annotationLayers?: (Rect & { dataUrl: string, opacity?: number })[]
  gestureImages?: {
    photoId: string
    dataUrl: string
    width: number
    height: number
  }[]
  region?: Rect
  revision: number
  dataUrl: string
  layout: LayoutResult
}
export interface Preset {
  id: string
  name: string
  createdAt: string
  settings: Omit<Composition, 'panels' | 'revision'>
  logo?: string
}
export interface AppNotification {
  id: string
  type: 'info' | 'success' | 'error'
  message: string
  description?: string
  action?: 'install-update'
}
export interface AppApi {
  importImages: (
    paths?: string[],
  ) => Promise<{ photos: Photo[], errors: string[] }>
  importLogo: () => Promise<Photo | null>
  releaseImages: (ids: string[]) => Promise<void>
  preview: (
    snapshot: Composition,
    maxSize: number,
    region?: Rect,
    annotationsOnly?: boolean,
  ) => Promise<PreviewResult>
  exportImage: (
    snapshot: Composition,
  ) => Promise<{ status: 'saved' | 'cancelled', path?: string }>
  cancelExport: () => Promise<void>
  presets: {
    list: () => Promise<Preset[]>
    save: (preset: Preset) => Promise<void>
    remove: (id: string) => Promise<void>
  }
  info: () => Promise<{ version: string, platform: string }>
  checkUpdates: () => Promise<void>
  installUpdate: () => Promise<void>
  onNotification: (
    callback: (notification: AppNotification) => void,
  ) => () => void
  droppedFilePath: (file: File) => string
}
