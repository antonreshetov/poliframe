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
const layout = computed(() => e.preview?.layout)
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
      !region
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
      })
    }
    node.children.forEach(walk)
  }
  walk(e.state.grid)
  return result
})
function resize(event: PointerEvent, divider: (typeof dividers.value)[number]) {
  event.stopPropagation()
  event.preventDefault()
  e.checkpoint()
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  const horizontal = divider.node.axis === 'horizontal'
  let active = divider
  if (event.altKey) {
    const parent = divider.node
    const rows = parent.children
    const first = rows[0]
    if (
      first?.type === 'split'
      && first.axis !== parent.axis
      && rows.every(
        row =>
          row.type === 'split'
          && row.axis === first.axis
          && row.children.length === first.children.length
          && row.children.every(child => child.type === 'leaf')
          && row.weights.every(
            (w, i) =>
              Math.abs(
                w / row.weights.reduce((a, b) => a + b, 0)
                - first.weights[i]! / first.weights.reduce((a, b) => a + b, 0),
              ) < 0.001,
          ),
      )
    ) {
      const oldAxis = parent.axis
      const oldWeights = [...parent.weights]
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
      parent.axis = first.axis
      parent.children = columns
      parent.weights = [...first.weights]
      active = {
        ...divider,
        node: columns[Math.max(0, column)] as Extract<
          GridNode,
          { type: 'split' }
        >,
      }
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
          * scale.value
          < 2,
      )
  const existingLines = dividers.value
    .filter(
      item =>
        item.node.axis === active.node.axis && !candidates.includes(item),
    )
    .map(item => (horizontal ? item.x : item.y))
  const snapped = new Map<string, number>()
  const initial = candidates.map(item => ({
    item,
    weights: [...item.node.weights],
  }))
  const start = horizontal ? event.clientX : event.clientY
  const move = (ev: PointerEvent) => {
    for (const { item, weights } of initial) {
      const total = weights.reduce((a, b) => a + b, 0)
      const a = weights[item.index]!
      const b = weights[item.index + 1]!
      const pair = a + b
      const delta
        = (((horizontal ? ev.clientX : ev.clientY) - start)
          / (item.span * scale.value))
        * total
      let fraction = Math.max(0.1, Math.min(0.9, (a + delta) / pair))
      const snapKey = `${item.node.id}:${item.index}`
      if (!ev.metaKey && !ev.ctrlKey) {
        const screenSpan = (pair / total) * item.span * scale.value
        const before = weights
          .slice(0, item.index)
          .reduce((sum, weight) => sum + weight, 0)
        const equal
          = ((total * (item.index + 1)) / weights.length - before) / pair
        const position = horizontal ? item.x : item.y
        const targets = [
          1 / 3,
          0.5,
          2 / 3,
          equal,
          ...existingLines.map(
            line =>
              a / pair + (((line - position) / item.span) * total) / pair,
          ),
        ].filter(value => value >= 0.1 && value <= 0.9)
        let snap = snapped.get(snapKey)
        if (snap !== undefined && Math.abs(snap - fraction) * screenSpan > 9) {
          snapped.delete(snapKey)
          snap = undefined
        }
        if (snap === undefined) {
          snap = targets
            .sort((x, y) => Math.abs(x - fraction) - Math.abs(y - fraction))
            .find(value => Math.abs(value - fraction) * screenSpan <= 6)
          if (snap !== undefined)
            snapped.set(snapKey, snap)
        }
        fraction = snap ?? Math.round(fraction * 100) / 100
      }
      else {
        snapped.delete(snapKey)
      }
      item.node.weights[item.index] = fraction * pair
      item.node.weights[item.index + 1] = (1 - fraction) * pair
    }
  }
  const end = () => {
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', end)
    target.removeEventListener('pointercancel', end)
  }
  target.addEventListener('pointermove', move)
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
        />
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
.divider:hover {
  background: #3b82f688;
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
