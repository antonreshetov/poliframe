import type { Ref } from 'vue'
import type {
  LayoutResult,
  PreviewResult,
  Rect,
} from '../../../shared/contracts'
import { computed, onUnmounted, ref } from 'vue'
import { useEditorContext } from '../useEditor'

interface CellSelectionDependencies {
  layout: Readonly<Ref<LayoutResult | undefined>>
  scale: Readonly<Ref<number>>
  size: Ref<{ width: number, height: number }>
  pan: Ref<{ x: number, y: number }>
  clearSelection: () => void
  viewport: Ref<HTMLElement | undefined>
  liveCellSource: (
    cell: Rect & { photoId: string | null },
  ) => NonNullable<PreviewResult['gestureImages']>[number] | undefined
}

export function useCellSelection({
  layout,
  scale,
  size,
  pan,
  viewport,
  liveCellSource,
  clearSelection,
}: CellSelectionDependencies) {
  const e = useEditorContext()
  const dragging = ref('')
  const dropTarget = ref('')
  let dragGhost: HTMLCanvasElement | undefined
  function endCellDrag() {
    dragging.value = ''
    dropTarget.value = ''
    dragGhost?.remove()
    dragGhost = undefined
  }
  function leaveCell(event: DragEvent) {
    const cell = event.currentTarget as HTMLElement
    if (!event.relatedTarget || !cell.contains(event.relatedTarget as Node))
      dropTarget.value = ''
  }
  const selectedCell = computed(() =>
    layout.value?.cells.find(c => c.id === e.selected[0]),
  )
  const toolbarPosition = computed(() => {
    const cells
      = layout.value?.cells.filter(cell => e.selected.includes(cell.id)) ?? []
    if (!cells.length || !layout.value)
      return {}
    const left = Math.min(...cells.map(cell => cell.x))
    const right = Math.max(...cells.map(cell => cell.x + cell.width))
    const top = Math.min(...cells.map(cell => cell.y))
    return {
      left: `${Math.max(110, Math.min(size.value.width - 110, (size.value.width - layout.value.width * scale.value) / 2 + ((left + right) / 2) * scale.value + pan.value.x))}px`,
      top: `${Math.max(4, (size.value.height - layout.value.height * scale.value) / 2 + top * scale.value + pan.value.y - 36)}px`,
    }
  })
  function select(id: string, event: MouseEvent) {
    e.selected = event.shiftKey
      ? e.selected.includes(id)
        ? e.selected.filter(i => i !== id)
        : [...e.selected, id]
      : [id]
  }
  function startCellDrag(event: DragEvent, id: string) {
    endCellDrag()
    dragging.value = id
    e.selected = [id]
    const cell = layout.value?.cells.find(cell => cell.id === id)
    if (!cell || !event.dataTransfer)
      return
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
    const ratio = Math.min(
      scale.value,
      120 / Math.max(cell.width, cell.height),
    )
    const width = cell.width * ratio
    const height = cell.height * ratio
    const canvas = document.createElement('canvas')
    const pixelRatio = window.devicePixelRatio || 1
    canvas.width = Math.ceil(width * pixelRatio)
    canvas.height = Math.ceil(height * pixelRatio)
    canvas.style.cssText = `position:fixed;left:-1000px;top:0;width:${width}px;height:${height}px;pointer-events:none`
    const context = canvas.getContext('2d')
    if (!context)
      return
    context.scale(pixelRatio, pixelRatio)
    context.globalAlpha = 0.85
    context.beginPath()
    context.roundRect(0, 0, width, height, 5)
    context.clip()
    context.fillStyle = e.state.mat
    context.fillRect(0, 0, width, height)
    const image
      = viewport.value?.querySelector<HTMLImageElement>('.composition-image')
    const composition = e.preview?.layout
    const source = liveCellSource(cell)
    const liveImage
      = source
        && Array.from(
          viewport.value?.querySelectorAll<HTMLImageElement>(
            '.live-cell-image',
          ) ?? [],
        ).find(item => item.getAttribute('src') === source.dataUrl)
    if (e.interactivePreview && liveImage?.complete && liveImage.naturalWidth) {
      const cover = Math.max(
        width / liveImage.naturalWidth,
        height / liveImage.naturalHeight,
      )
      const w = liveImage.naturalWidth * cover
      const h = liveImage.naturalHeight * cover
      context.drawImage(liveImage, (width - w) / 2, (height - h) / 2, w, h)
    }
    else if (image?.complete && image.naturalWidth && composition) {
      const sx = image.naturalWidth / composition.width
      const sy = image.naturalHeight / composition.height
      context.drawImage(
        image,
        cell.x * sx,
        cell.y * sy,
        cell.width * sx,
        cell.height * sy,
        0,
        0,
        width,
        height,
      )
    }
    context.strokeStyle = 'rgba(255,255,255,0.6)'
    context.lineWidth = 1
    context.beginPath()
    context.roundRect(0.5, 0.5, width - 1, height - 1, 5)
    context.stroke()
    document.body.append(canvas)
    dragGhost = canvas
    event.dataTransfer.setDragImage(canvas, width / 2, height / 2)
  }

  function key(event: KeyboardEvent) {
    const cells = layout.value?.cells ?? []
    const index = cells.findIndex(c => c.id === e.selected[0])
    if (event.key === 'Escape') {
      event.preventDefault()
      clearSelection()
    }
    else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      e.deleteCells()
    }
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (selectedCell.value?.photoId)
        e.cropId = selectedCell.value.photoId
    }
    else if (event.key === 'Tab') {
      event.preventDefault()
      const next
        = cells[
          (index + (event.shiftKey ? -1 : 1) + cells.length) % cells.length
        ]
      if (next)
        e.selected = [next.id]
    }
    else if (event.key.startsWith('Arrow')) {
      event.preventDefault()
      const current = cells[index]
      if (!current) {
        if (cells[0])
          e.selected = [cells[0].id]
        return
      }
      const cx = current.x + current.width / 2
      const cy = current.y + current.height / 2
      const direction = event.key
      const next = cells
        .filter((cell) => {
          const dx = cell.x + cell.width / 2 - cx
          const dy = cell.y + cell.height / 2 - cy
          return direction === 'ArrowLeft'
            ? dx < -1
            : direction === 'ArrowRight'
              ? dx > 1
              : direction === 'ArrowUp'
                ? dy < -1
                : dy > 1
        })
        .sort(
          (a, b) =>
            Math.hypot(a.x + a.width / 2 - cx, a.y + a.height / 2 - cy)
            - Math.hypot(b.x + b.width / 2 - cx, b.y + b.height / 2 - cy),
        )[0]
      if (next)
        e.selected = [next.id]
    }
  }
  onUnmounted(endCellDrag)
  return {
    dragging,
    dropTarget,
    endCellDrag,
    leaveCell,
    selectedCell,
    toolbarPosition,
    select,
    startCellDrag,
    key,
  }
}
