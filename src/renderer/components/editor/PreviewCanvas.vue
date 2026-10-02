<script setup lang="ts">
import type { GridNode, PreviewResult, Rect } from '../../../shared/contracts'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Crop,
  Image,
  ImagePlus,
  Merge,
  Plus,
  Trash2,
  X,
} from '@lucide/vue'
import { computed, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue'
import { Button } from '@/components/ui/button'
import { leaves, useEditorContext } from '@/composables/useEditor'
import { gridCells } from '../../../shared/layout'

const { zoom } = defineProps<{ zoom: number | null }>()
const emit = defineEmits<{
  zoom: [number | null]
  scale: [number]
  fit: [number]
}>()
const e = useEditorContext()
const viewport = ref<HTMLElement>()
const size = ref({ width: 600, height: 600 })
const pan = ref({ x: 0, y: 0 })
const dragging = ref('')
const dpr = ref(window.devicePixelRatio || 1)
function updateDpr() {
  dpr.value = window.devicePixelRatio || 1
}
let observer: ResizeObserver
let regionGeneration = 0
let regionTimer: ReturnType<typeof setTimeout>
onMounted(() => {
  window.addEventListener('resize', updateDpr)
  observer = new ResizeObserver(([entry]) => {
    if (entry) {
      updateDpr()
      size.value = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }
    }
  })
  if (viewport.value)
    observer.observe(viewport.value)
})
onUnmounted(() => {
  observer?.disconnect()
  window.removeEventListener('resize', updateDpr)
  clearTimeout(regionTimer)
  regionGeneration++
})
const draftGrid = ref<GridNode | null>(null)
const dragBacking = ref<PreviewResult | null>(null)
const resizing = ref(false)
let finishResize: (() => void) | undefined
onUnmounted(() => finishResize?.())
const layout = computed(() => {
  const base = dragBacking.value?.layout ?? e.preview?.layout
  if (!base || !draftGrid.value || !base.cells.length)
    return base
  const x = Math.min(...base.cells.map(cell => cell.x))
  const y = Math.min(...base.cells.map(cell => cell.y))
  const width = Math.max(...base.cells.map(cell => cell.x + cell.width)) - x
  const height
    = Math.max(...base.cells.map(cell => cell.y + cell.height)) - y
  const measure = e.state[e.state.units]
  const gap
    = e.state.units === 'pixels'
      ? measure.gap
      : (measure.gap / 100) * Math.min(base.width, base.height)
  return {
    ...base,
    cells: gridCells(draftGrid.value, { x, y, width, height }, gap),
  }
})
watch(
  () => e.preview,
  () => {
    if (!resizing.value) {
      draftGrid.value = null
      dragBacking.value = null
    }
  },
)
watch(
  () => e.state.grid,
  () => {
    if (resizing.value || e.state.layout !== 'grid' || !e.preview)
      return
    dragBacking.value ??= e.preview
    draftGrid.value = JSON.parse(JSON.stringify(e.state.grid))
  },
  { deep: true },
)
const fitScale = computed(() =>
  !layout.value
    ? 1 / dpr.value
    : Math.min(
        (size.value.width - 64) / layout.value.width,
        (size.value.height - 64) / layout.value.height,
        1 / dpr.value,
      ),
)
const scale = computed(() =>
  zoom === null
    ? fitScale.value
    : Math.max(fitScale.value, Math.min(100, zoom) / 100 / dpr.value),
)
function liveCellStyle(cell: Rect & { id: string, photoId: string | null }) {
  const backing = dragBacking.value
  const original = backing?.layout.cells.find(
    item => item.photoId === cell.photoId && cell.photoId,
  )
  if (!backing || !original?.photoId)
    return { backgroundColor: e.state.mat }
  const factor
    = Math.max(cell.width / original.width, cell.height / original.height)
      * scale.value
  return {
    backgroundImage: `url("${backing.dataUrl}")`,
    backgroundSize: `${backing.layout.width * factor}px ${backing.layout.height * factor}px`,
    backgroundPosition: `${-original.x * factor + (cell.width * scale.value - original.width * factor) / 2}px ${-original.y * factor + (cell.height * scale.value - original.height * factor) / 2}px`,
  }
}
function clampPan() {
  if (!layout.value || scale.value <= fitScale.value) {
    pan.value = { x: 0, y: 0 }
    return
  }
  const maxX = Math.max(
    0,
    (layout.value.width * scale.value - size.value.width) / 2,
  )
  const maxY = Math.max(
    0,
    (layout.value.height * scale.value - size.value.height) / 2,
  )
  pan.value = {
    x: Math.max(-maxX, Math.min(maxX, pan.value.x)),
    y: Math.max(-maxY, Math.min(maxY, pan.value.y)),
  }
}
watch(
  [scale, fitScale, () => layout.value?.width, () => layout.value?.height],
  clampPan,
)
watch([fitScale, dpr], ([value, ratio]) => emit('fit', value * ratio * 100), {
  immediate: true,
})
watch(
  () => zoom,
  (value) => {
    if (value === null)
      pan.value = { x: 0, y: 0 }
  },
)
function wheel(event: WheelEvent) {
  const bounds = viewport.value!.getBoundingClientRect()
  const point = {
    x: event.clientX - bounds.left - bounds.width / 2,
    y: event.clientY - bounds.top - bounds.height / 2,
  }
  const next = Math.max(
    fitScale.value,
    Math.min(1 / dpr.value, scale.value * (event.deltaY > 0 ? 1 / 1.1 : 1.1)),
  )
  const factor = next / scale.value
  pan.value = {
    x: point.x - (point.x - pan.value.x) * factor,
    y: point.y - (point.y - pan.value.y) * factor,
  }
  emit('zoom', next <= fitScale.value ? null : next * dpr.value * 100)
}
watch([scale, dpr], ([value, ratio]) => emit('scale', value * ratio * 100), {
  immediate: true,
})
watchEffect(() => {
  const ratio = dpr.value
  const rendered = layout.value
    ? Math.max(layout.value.width, layout.value.height) * scale.value
    : Math.max(size.value.width, size.value.height)
  e.previewSize = Math.round(Math.max(800, Math.min(3200, rendered * ratio)))
})
const regionPreview = ref<PreviewResult | null>(null)
const visibleRegion = computed<Rect | null>(() => {
  const output = layout.value
  if (!output || zoom === null || scale.value <= 0)
    return null
  const fit = Math.min(
    (size.value.width - 64) / output.width,
    (size.value.height - 64) / output.height,
    1 / dpr.value,
  )
  if (scale.value <= fit)
    return null
  const left
    = (size.value.width - output.width * scale.value) / 2 + pan.value.x
  const top
    = (size.value.height - output.height * scale.value) / 2 + pan.value.y
  const x = Math.max(0, Math.floor(-left / scale.value))
  const y = Math.max(0, Math.floor(-top / scale.value))
  const right = Math.min(
    output.width,
    Math.ceil((size.value.width - left) / scale.value),
  )
  const bottom = Math.min(
    output.height,
    Math.ceil((size.value.height - top) / scale.value),
  )
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null
})
watch(
  [
    () => e.state,
    () => e.renderRevision,
    () => e.preview,
    () => e.rendering,
    resizing,
    visibleRegion,
    scale,
  ],
  () => {
    const generation = ++regionGeneration
    clearTimeout(regionTimer)
    regionPreview.value = null
    const region = visibleRegion.value
    const backing = e.preview
    if (
      resizing.value
      || !region
      || !backing
      || e.rendering
      || backing.revision !== e.renderRevision
    ) {
      return
    }
    const revision = backing.revision
    const snapshot = JSON.parse(JSON.stringify(e.state))
    snapshot.revision = revision
    const maxSize = Math.round(
      Math.max(
        400,
        Math.min(
          3200,
          Math.max(region.width, region.height) * scale.value * dpr.value,
        ),
      ),
    )
    regionTimer = setTimeout(async () => {
      try {
        const result = await window.poliframe.preview(
          snapshot,
          maxSize,
          region,
        )
        if (
          generation === regionGeneration
          && revision === e.renderRevision
          && result.revision === revision
          && e.preview?.revision === revision
        ) {
          regionPreview.value = result
        }
      }
      catch (error) {
        if (generation === regionGeneration)
          e.fail(error)
      }
    }, 180)
  },
  { deep: true, flush: 'sync' },
)
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
const dividers = computed(() => {
  if (e.state.layout !== 'grid' || !layout.value)
    return []
  const result: {
    node: Extract<GridNode, { type: 'split' }>
    index: number
    x: number
    y: number
    width: number
    height: number
    span: number
    containerStart: number
    pairLength: number
  }[] = []
  function walk(node: GridNode) {
    if (node.type === 'leaf')
      return
    const group = leaves(node)
      .map(l => layout.value!.cells.find(c => c.id === l.id))
      .filter(c => !!c)
    if (!group.length)
      return
    const x = Math.min(...group.map(c => c.x))
    const y = Math.min(...group.map(c => c.y))
    const right = Math.max(...group.map(c => c.x + c.width))
    const bottom = Math.max(...group.map(c => c.y + c.height))
    for (let i = 0; i < node.children.length - 1; i++) {
      const before = leaves(node.children[i]!)
        .map(l => layout.value!.cells.find(c => c.id === l.id))
        .filter(c => !!c)
      const after = leaves(node.children[i + 1]!)
        .map(l => layout.value!.cells.find(c => c.id === l.id))
        .filter(c => !!c)
      if (!before.length || !after.length)
        continue
      const horizontal = node.axis === 'horizontal'
      const position = horizontal
        ? (Math.max(...before.map(c => c.x + c.width))
          + Math.min(...after.map(c => c.x)))
        / 2
        : (Math.max(...before.map(c => c.y + c.height))
          + Math.min(...after.map(c => c.y)))
        / 2
      result.push({
        node,
        index: i,
        x: horizontal ? position : x,
        y: horizontal ? y : position,
        width: horizontal ? 0 : right - x,
        height: horizontal ? bottom - y : 0,
        span: horizontal ? right - x : bottom - y,
        containerStart: horizontal ? x : y,
        pairLength: horizontal
          ? Math.max(...before.map(c => c.x + c.width))
          - Math.min(...before.map(c => c.x))
          + Math.max(...after.map(c => c.x + c.width))
          - Math.min(...after.map(c => c.x))
          : Math.max(...before.map(c => c.y + c.height))
            - Math.min(...before.map(c => c.y))
            + Math.max(...after.map(c => c.y + c.height))
            - Math.min(...after.map(c => c.y)),
      })
    }
    node.children.forEach(walk)
  }
  walk(draftGrid.value ?? e.state.grid)
  return result
})
type Divider = (typeof dividers.value)[number]
const dividerFeedback = ref<{
  horizontal: boolean
  position: number
  lo: number
  hi: number
  percent?: number
  x?: number
  y?: number
  snapped?: boolean
} | null>(null)
function showDivider(items: Divider[], position: number) {
  const horizontal = items[0]!.node.axis === 'horizontal'
  dividerFeedback.value = {
    horizontal,
    position,
    lo: Math.min(...items.map(item => (horizontal ? item.y : item.x))),
    hi: Math.max(
      ...items.map(item =>
        horizontal ? item.y + item.height : item.x + item.width,
      ),
    ),
  }
}
let lastDividerHover: { event: PointerEvent, divider: Divider } | undefined
function leaveDivider() {
  lastDividerHover = undefined
  if (!resizing.value)
    dividerFeedback.value = null
}
function modifierChanged(event: KeyboardEvent) {
  if (lastDividerHover) {
    hoverDivider(
      {
        clientX: lastDividerHover.event.clientX,
        clientY: lastDividerHover.event.clientY,
        currentTarget: lastDividerHover.event.currentTarget,
        altKey: event.altKey,
      } as PointerEvent,
      lastDividerHover.divider,
    )
  }
}
onMounted(() => {
  window.addEventListener('keydown', modifierChanged)
  window.addEventListener('keyup', modifierChanged)
})
onUnmounted(() => {
  window.removeEventListener('keydown', modifierChanged)
  window.removeEventListener('keyup', modifierChanged)
})
function hoverDivider(event: PointerEvent, divider: Divider) {
  if (resizing.value)
    return
  lastDividerHover = {
    event: {
      clientX: event.clientX,
      clientY: event.clientY,
      currentTarget: event.currentTarget,
    } as PointerEvent,
    divider,
  }
  const horizontal = divider.node.axis === 'horizontal'
  const position = horizontal ? divider.x : divider.y
  showDivider(
    event.altKey
      ? [divider]
      : dividers.value.filter(
          item =>
            item.node.axis === divider.node.axis
            && Math.abs((horizontal ? item.x : item.y) - position)
            < (horizontal ? layout.value!.width : layout.value!.height) * 0.002,
        ),
    position,
  )
  const rows = divider.node.children.slice(divider.index, divider.index + 2)
  const first = rows[0]
  const second = rows[1]
  if (
    event.altKey
    && first?.type === 'split'
    && second?.type === 'split'
    && first.axis !== divider.node.axis
    && first.axis === second.axis
    && first.weights.length === second.weights.length
    && first.weights.every(
      (weight, i) =>
        Math.abs(
          weight / first.weights.reduce((a, b) => a + b, 0)
          - second.weights[i]! / second.weights.reduce((a, b) => a + b, 0),
        ) <= 0.000001,
    )
  ) {
    const bounds = (
      event.currentTarget as HTMLElement
    ).parentElement!.getBoundingClientRect()
    const cross = horizontal
      ? (event.clientY - bounds.top) / scale.value
      : (event.clientX - bounds.left) / scale.value
    const start = horizontal ? divider.y : divider.x
    const span = horizontal ? divider.height : divider.width
    const total = first.weights.reduce((a, b) => a + b, 0)
    let lo = start
    for (const [index, weight] of first.weights.entries()) {
      const hi = lo + (span * weight) / total
      if (cross <= hi || index === first.weights.length - 1) {
        dividerFeedback.value = { horizontal, position, lo, hi }
        break
      }
      lo = hi
    }
  }
}
function resize(event: PointerEvent, divider: (typeof dividers.value)[number]) {
  event.stopPropagation()
  event.preventDefault()
  if (!e.preview)
    return
  dragBacking.value = e.preview
  draftGrid.value = JSON.parse(JSON.stringify(e.state.grid))
  divider = dividers.value.find(
    item => item.node.id === divider.node.id && item.index === divider.index,
  )!
  resizing.value = true
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  const horizontal = divider.node.axis === 'horizontal'
  let active = divider
  if (event.altKey) {
    const parent = divider.node
    const rows = parent.children.slice(divider.index, divider.index + 2)
    const first = rows[0]
    if (
      first?.type === 'split'
      && first.axis !== parent.axis
      && rows.every(
        row =>
          row.type === 'split'
          && row.axis === first.axis
          && row.children.length === first.children.length
          && row.weights.every(
            (w, i) =>
              Math.abs(
                w / row.weights.reduce((a, b) => a + b, 0)
                - first.weights[i]! / first.weights.reduce((a, b) => a + b, 0),
              ) <= 0.000001,
          ),
      )
    ) {
      const oldAxis = parent.axis
      const oldWeights = parent.weights.slice(divider.index, divider.index + 2)
      const columns = first.children.map((_, index): GridNode => ({
        id: crypto.randomUUID(),
        type: 'split',
        axis: oldAxis,
        weights: [...oldWeights],
        children: rows.map(row =>
          row.type === 'split' ? row.children[index]! : row,
        ),
      }))
      const bounds = target.parentElement!.getBoundingClientRect()
      const cross = horizontal
        ? (event.clientY - bounds.top) / scale.value
        : (event.clientX - bounds.left) / scale.value
      const start = horizontal ? divider.y : divider.x
      const span = horizontal ? divider.height : divider.width
      const total = first.weights.reduce((a, b) => a + b, 0)
      let accumulated = 0
      const column = first.weights.findIndex((weight) => {
        accumulated += weight / total
        return cross <= start + accumulated * span
      })
      if (parent.children.length === 2) {
        parent.axis = first.axis
        parent.children = columns
        parent.weights = [...first.weights]
      }
      else {
        parent.children.splice(divider.index, 2, {
          id: crypto.randomUUID(),
          type: 'split',
          axis: first.axis,
          children: columns,
          weights: [...first.weights],
        })
        parent.weights.splice(
          divider.index,
          2,
          oldWeights[0]! + oldWeights[1]!,
        )
      }
      active = dividers.value.find(
        item =>
          item.node.id === columns[Math.max(0, column)]!.id && item.index === 0,
      )!
    }
  }
  const candidates = event.altKey
    ? [active]
    : dividers.value.filter(
        item =>
          item.node.axis === divider.node.axis
          && Math.abs(
            (horizontal ? item.x : item.y)
            - (horizontal ? divider.x : divider.y),
          )
          < (horizontal ? layout.value!.width : layout.value!.height) * 0.002,
      )
  const position = horizontal ? active.x : active.y
  const existingLines = dividers.value
    .filter(item => item.node.axis === active.node.axis)
    .map(item => (horizontal ? item.x : item.y))
    .filter(
      line =>
        Math.abs(line - position)
        > (horizontal ? layout.value!.width : layout.value!.height) * 0.002,
    )
  const initial = candidates.map((item) => {
    const weights = [...item.node.weights]
    const pair = weights[item.index]! + weights[item.index + 1]!
    const origin
      = (horizontal ? item.x : item.y)
        - (item.pairLength * weights[item.index]!) / pair
    return { item, pair, origin }
  })
  const first = initial[0]!
  const targets = [
    ...[1 / 3, 0.5, 2 / 3].map(f => first.origin + first.item.pairLength * f),
    ...Array.from(
      {
        length:
          active.node.children.length > 2 ? active.node.children.length - 1 : 0,
      },
      (_, i) =>
        active.containerStart
        + (active.span * (i + 1)) / active.node.children.length,
    ),
    ...existingLines,
  ]
  let snapped: number | undefined
  const start = horizontal ? event.clientX : event.clientY
  showDivider(candidates, position)
  const bounds = target.parentElement?.getBoundingClientRect() ?? {
    left: 0,
    top: 0,
  }
  const applyMove = (ev: PointerEvent) => {
    let next
      = position + ((horizontal ? ev.clientX : ev.clientY) - start) / scale.value
    if (!ev.metaKey) {
      if (snapped !== undefined && Math.abs(snapped - next) * scale.value > 9)
        snapped = undefined
      if (snapped === undefined) {
        snapped = targets
          .slice()
          .sort((a, b) => Math.abs(a - next) - Math.abs(b - next))
          .find(value => Math.abs(value - next) * scale.value <= 6)
      }
      next
        = snapped
          ?? first.origin
          + (Math.round(((next - first.origin) / first.item.pairLength) * 100)
            / 100)
          * first.item.pairLength
    }
    else {
      snapped = undefined
    }
    const lo = Math.max(
      ...initial.map(({ item, origin }) => origin + item.pairLength * 0.1),
    )
    const hi = Math.min(
      ...initial.map(({ item, origin }) => origin + item.pairLength * 0.9),
    )
    const clamped = Math.max(lo, Math.min(hi, next))
    if (clamped !== next)
      snapped = undefined
    next = clamped
    for (const { item, pair, origin } of initial) {
      const fraction = (next - origin) / item.pairLength
      item.node.weights[item.index] = fraction * pair
      item.node.weights[item.index + 1] = (1 - fraction) * pair
    }
    dividerFeedback.value = {
      ...dividerFeedback.value!,
      position: next,
      snapped: snapped !== undefined,
      percent: Math.round(
        ((next - first.origin) / first.item.pairLength) * 100,
      ),
      x: ev.clientX - bounds.left + 14,
      y: ev.clientY - bounds.top + 16,
    }
  }
  let frame = 0
  let pending: PointerEvent | undefined
  let changed = false
  const move = (ev: PointerEvent) => {
    pending = ev
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0
        if (pending) {
          applyMove(pending)
          changed = true
          pending = undefined
        }
      })
    }
  }
  let ended = false
  const end = (ev?: PointerEvent) => {
    if (ended)
      return
    ended = true
    cancelAnimationFrame(frame)
    if (pending && ev?.type !== 'pointercancel') {
      applyMove(pending)
      changed = true
    }
    window.removeEventListener('pointermove', move, true)
    target.removeEventListener('pointerup', end)
    target.removeEventListener('pointercancel', end)
    window.removeEventListener('pointerup', end, true)
    window.removeEventListener('pointercancel', end, true)
    finishResize = undefined
    resizing.value = false
    dividerFeedback.value = null
    lastDividerHover = undefined
    if (ev?.type === 'pointerup' && changed && draftGrid.value) {
      e.checkpoint()
      e.state.grid = JSON.parse(JSON.stringify(draftGrid.value))
    }
    else {
      draftGrid.value = null
      dragBacking.value = null
    }
  }
  finishResize = end
  window.addEventListener('pointerup', end, true)
  window.addEventListener('pointercancel', end, true)
  window.addEventListener('pointermove', move, true)
  target.addEventListener('pointerup', end)
  target.addEventListener('pointercancel', end)
}
function select(id: string, event: MouseEvent) {
  e.selected = event.shiftKey
    ? e.selected.includes(id)
      ? e.selected.filter(i => i !== id)
      : [...e.selected, id]
    : [id]
}
function panStart(event: PointerEvent) {
  if (
    (event.target as HTMLElement).closest('button')
    || scale.value <= fitScale.value
  ) {
    return
  }
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  const start = { x: event.clientX, y: event.clientY }
  const old = { ...pan.value }
  const move = (ev: PointerEvent) => {
    pan.value = {
      x: old.x + ev.clientX - start.x,
      y: old.y + ev.clientY - start.y,
    }
    clampPan()
  }
  const end = () => {
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', end)
  }
  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', end)
}
function key(event: KeyboardEvent) {
  const cells = layout.value?.cells ?? []
  const index = cells.findIndex(c => c.id === e.selected[0])
  if (event.key === 'Escape') {
    e.selected = []
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
      = cells[(index + (event.shiftKey ? -1 : 1) + cells.length) % cells.length]
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
</script>

<template>
  <div
    ref="viewport"
    class="preview-viewport"
    tabindex="0"
    aria-label="Composition preview"
    @keydown="key"
    @pointerdown="panStart"
    @wheel.prevent="wheel"
    @dragover.prevent
    @drop.prevent="!dragging && e.drop($event)"
  >
    <div
      v-if="e.state.panels.length || e.state.layout === 'grid'"
      class="preview-image"
      :style="{
        width: `${(layout?.width ?? 1) * scale}px`,
        height: `${(layout?.height ?? 1) * scale}px`,
        transform: `translate(${zoom === null ? 0 : pan.x}px,${zoom === null ? 0 : pan.y}px)`,
      }"
    >
      <img
        v-if="e.preview"
        :src="e.preview.dataUrl"
        alt="Composition"
        draggable="false"
        class="h-full w-full pointer-events-none"
      >
      <img
        v-if="regionPreview?.region"
        :src="regionPreview.dataUrl"
        alt=""
        draggable="false"
        class="pointer-events-none absolute"
        :style="{
          left: `${regionPreview.region.x * scale}px`,
          top: `${regionPreview.region.y * scale}px`,
          width: `${regionPreview.region.width * scale}px`,
          height: `${regionPreview.region.height * scale}px`,
        }"
      >
      <div
        v-if="draftGrid && layout"
        class="pointer-events-none absolute inset-0"
      >
        <div
          v-for="cell in dragBacking?.layout.cells"
          :key="`old-${cell.id}`"
          class="absolute"
          :style="{
            background: e.state.mat,
            left: `${cell.x * scale}px`,
            top: `${cell.y * scale}px`,
            width: `${cell.width * scale}px`,
            height: `${cell.height * scale}px`,
          }"
        />
        <div
          v-for="cell in layout.cells"
          :key="cell.id"
          class="absolute"
          :style="{
            ...liveCellStyle(cell),
            left: `${cell.x * scale}px`,
            top: `${cell.y * scale}px`,
            width: `${cell.width * scale}px`,
            height: `${cell.height * scale}px`,
          }"
        />
      </div>
      <div
        v-if="e.state.layout === 'grid'"
        class="outer-tracks"
      >
        <button
          v-for="(side, index) in ['left', 'right', 'top', 'bottom']"
          :key="side"
          class="add-track"
          :class="[side]"
          :aria-label="`Add ${side} track`"
          :title="`Add ${side} track`"
          @click="
            e.addTrack(index < 2 ? 'horizontal' : 'vertical', index % 2 === 0)
          "
        >
          <Plus :size="14" />
        </button>
      </div>
      <template v-if="e.state.layout === 'grid' && layout">
        <button
          v-for="cell in layout.cells"
          :key="cell.id"
          class="cell-overlay"
          :class="{
            selected: e.selected.includes(cell.id),
            empty: !cell.photoId,
          }"
          :style="{
            left: `${cell.x * scale}px`,
            top: `${cell.y * scale}px`,
            width: `${cell.width * scale}px`,
            height: `${cell.height * scale}px`,
          }"
          :aria-label="
            cell.photoId
              ? `Select ${e.photos[cell.photoId]?.name}`
              : 'Empty cell'
          "
          draggable="true"
          @click.stop="select(cell.id, $event)"
          @dblclick="
            cell.photoId
              ? (e.cropId = cell.photoId)
              : e.add(undefined, undefined, cell.id)
          "
          @dragstart="dragging = cell.id"
          @dragend="dragging = ''"
          @dragover.prevent
          @drop.stop.prevent="
            dragging
              ? e.swap(dragging, cell.id)
              : e.drop($event, undefined, cell.id);
            dragging = '';
          "
        >
          <Image
            v-if="!cell.photoId"
            :size="24"
          />
        </button>
        <div
          v-for="divider in dividers"
          :key="`${divider.node.id}-${divider.index}`"
          class="divider"
          :style="{
            left: `${divider.x * scale - 3}px`,
            top: `${divider.y * scale - 3}px`,
            width: `${Math.max(6, divider.width * scale)}px`,
            height: `${Math.max(6, divider.height * scale)}px`,
            cursor:
              divider.node.axis === 'horizontal' ? 'col-resize' : 'row-resize',
          }"
          @pointerdown="resize($event, divider)"
          @pointermove="hoverDivider($event, divider)"
          @pointerleave="leaveDivider"
        />
        <template v-if="dividerFeedback">
          <div
            class="divider-line"
            :style="{
              left: `${(dividerFeedback.horizontal ? dividerFeedback.position : dividerFeedback.lo) * scale}px`,
              top: `${(dividerFeedback.horizontal ? dividerFeedback.lo : dividerFeedback.position) * scale}px`,
              width: dividerFeedback.horizontal
                ? '2px'
                : `${(dividerFeedback.hi - dividerFeedback.lo) * scale}px`,
              height: dividerFeedback.horizontal
                ? `${(dividerFeedback.hi - dividerFeedback.lo) * scale}px`
                : '2px',
            }"
          />
          <div
            v-if="dividerFeedback.snapped"
            class="divider-line snap-guide"
            :style="{
              left: dividerFeedback.horizontal
                ? `${dividerFeedback.position * scale}px`
                : '0',
              top: dividerFeedback.horizontal
                ? '0'
                : `${dividerFeedback.position * scale}px`,
              width: dividerFeedback.horizontal ? '1px' : '100%',
              height: dividerFeedback.horizontal ? '100%' : '1px',
            }"
          />
          <div
            v-if="dividerFeedback.percent !== undefined"
            class="divider-percent"
            :style="{
              left: `${dividerFeedback.x}px`,
              top: `${dividerFeedback.y}px`,
            }"
          >
            {{ dividerFeedback.percent }}% /
            {{ 100 - dividerFeedback.percent }}%
          </div>
        </template>
      </template>
    </div>
    <div
      v-else
      class="grid justify-items-center gap-4 text-muted-foreground"
    >
      <p class="text-sm">
        Add an image to begin
      </p>
    </div>
    <div
      v-if="e.state.layout === 'grid' && e.selected.length"
      class="grid-tools rounded-lg border bg-background p-1 shadow-lg"
      :style="toolbarPosition"
    >
      <Button
        v-for="(icon, index) in e.selected.length === 1
          ? [ArrowLeft, ArrowRight, ArrowUp, ArrowDown]
          : []"
        :key="index"
        variant="ghost"
        size="icon-sm"
        :aria-label="
          ['Split left', 'Split right', 'Split up', 'Split down'][index]
        "
        :title="['Split left', 'Split right', 'Split up', 'Split down'][index]"
        @click="e.split(index < 2 ? 'horizontal' : 'vertical', index % 2 === 0)"
      >
        <component :is="icon" />
      </Button><Button
        v-if="e.selected.length === 1 && selectedCell?.photoId"
        variant="ghost"
        size="icon-sm"
        aria-label="Crop selected image"
        title="Crop image"
        @click="e.cropId = selectedCell.photoId"
      >
        <Crop />
      </Button><Button
        v-else-if="e.selected.length === 1"
        variant="ghost"
        size="icon-sm"
        aria-label="Add image to cell"
        @click="e.add(undefined, undefined, e.selected[0])"
      >
        <ImagePlus />
      </Button><Button
        v-if="e.selected.length === 1 && selectedCell?.photoId"
        variant="ghost"
        size="icon-sm"
        aria-label="Clear image"
        title="Clear image"
        @click="e.clearCells"
      >
        <X />
      </Button><Button
        variant="ghost"
        size="icon-sm"
        aria-label="Delete cell"
        title="Delete cell"
        @click="e.deleteCells"
      >
        <Trash2 />
      </Button><Button
        v-if="e.selected.length > 1"
        variant="ghost"
        size="icon-sm"
        aria-label="Merge selected cells"
        title="Merge sibling cells"
        :disabled="!e.mergeParent"
        @click="e.merge"
      >
        <Merge />
      </Button>
    </div>
    <span
      v-if="e.rendering"
      class="absolute right-4 top-4 rounded bg-background px-2 py-1 text-xs text-muted-foreground"
    >Rendering…</span>
  </div>
</template>

<style scoped>
.preview-viewport {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
  background: repeating-conic-gradient(
      var(--muted) 0% 25%,
      color-mix(in srgb, var(--muted), var(--background) 35%) 0% 50%
    )
    0/20px 20px;
  touch-action: none;
}
.preview-image {
  position: relative;
  flex-shrink: 0;
  box-shadow: 0 8px 30px #0002;
}
.cell-overlay {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #888;
  border: 2px solid transparent;
  background: transparent;
}
.cell-overlay.empty {
  background: #8888881a;
}
.cell-overlay:hover {
  border-color: #8888;
}
.cell-overlay.selected {
  border-color: #3b82f6;
}
.divider {
  position: absolute;
  touch-action: none;
}
.divider-line {
  position: absolute;
  pointer-events: none;
  background: #3b82f6;
  box-shadow: 0 0 0 1px #ffffff59;
  transform: translate(-1px, -1px);
}
.snap-guide {
  box-shadow: none;
}
.divider-percent {
  position: absolute;
  pointer-events: none;
  white-space: nowrap;
  border-radius: 4px;
  padding: 3px 5px;
  background: #242424;
  color: white;
  font-size: 11px;
  font-weight: 600;
}
.outer-tracks {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.add-track {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--background);
  pointer-events: auto;
  z-index: 2;
  opacity: 0;
}
.add-track:hover,
.add-track:focus-visible {
  opacity: 1;
}
.add-track.left {
  left: -27px;
  top: calc(50% - 11px);
}
.add-track.right {
  right: -27px;
  top: calc(50% - 11px);
}
.add-track.top {
  top: -27px;
  left: calc(50% - 11px);
}
.add-track.bottom {
  bottom: -27px;
  left: calc(50% - 11px);
}
.grid-tools {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 2px;
  white-space: nowrap;
}
</style>
