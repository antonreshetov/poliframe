<script setup lang="ts">
import type { GridNode, PreviewResult, Rect } from '../../../shared/contracts'
import { Crop, Image, ImagePlus, Merge, Plus, Trash2, X } from '@lucide/vue'
import { computed, onUnmounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { useCellSelection } from '@/composables/preview/useCellSelection'
import { useGridResize } from '@/composables/preview/useGridResize'
import { usePreviewViewport } from '@/composables/preview/usePreviewViewport'
import { useEditorContext } from '@/composables/useEditor'
import { gridCells } from '../../../shared/layout'

const { zoom } = defineProps<{ zoom: number | null }>()
const emit = defineEmits<{
  zoom: [number | null]
  scale: [number]
  fit: [number]
}>()
const e = useEditorContext()
const draftGrid = ref<GridNode | null>(null)
const dragBacking = ref<PreviewResult | null>(null)
const resizing = ref(false)
const layout = computed(() => {
  const base
    = e.interactivePreview?.layout
      ?? dragBacking.value?.layout
      ?? e.preview?.layout
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
    if (
      e.spacingEditing
      || resizing.value
      || e.state.layout !== 'grid'
      || !e.preview
    ) {
      return
    }
    dragBacking.value ??= e.preview
    draftGrid.value = JSON.parse(JSON.stringify(e.state.grid))
  },
  { deep: true },
)
const {
  viewport,
  size,
  pan,
  scale,
  regionPreview,
  regionAllowed,
  regionRendering,
  wheel,
  panStart,
  clearSelection,
} = usePreviewViewport({
  layout,
  resizing,
  zoom: () => zoom,
  emit,
})
const showRendering = ref(false)
let renderingTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => e.rendering || regionRendering.value,
  (active) => {
    clearTimeout(renderingTimer)
    if (!active) {
      showRendering.value = false
      return
    }
    renderingTimer = setTimeout(() => {
      showRendering.value = true
    }, 300)
  },
  { immediate: true },
)
onUnmounted(() => clearTimeout(renderingTimer))

const compositionImageStyle = computed(() => {
  const output = e.preview?.layout
  if (!output)
    return {}
  const longest = Math.max(output.width, output.height)
  return {
    width: `${(output.width / longest) * 1600}px`,
    height: `${(output.height / longest) * 1600}px`,
    transform: `scale(${(longest * scale.value) / 1600})`,
  }
})
function liveCellSource(cell: Rect & { photoId: string | null }) {
  return (e.interactivePreview ?? dragBacking.value)?.gestureImages?.find(
    item => item.photoId === cell.photoId,
  )
}
function liveCellImage(cell: Rect & { photoId: string | null }) {
  const image = liveCellSource(cell)
  if (!image)
    return null
  const factor
    = Math.max(cell.width / image.width, cell.height / image.height)
      * scale.value
  const x = (cell.width * scale.value - image.width * factor) / 2
  const y = (cell.height * scale.value - image.height * factor) / 2
  return {
    width: `${image.width}px`,
    height: `${image.height}px`,
    transform: `translate3d(${x}px, ${y}px, 0) scale(${factor})`,
  }
}
const {
  dragging,
  dropTarget,
  endCellDrag,
  leaveCell,
  selectedCell,
  toolbarPosition,
  select,
  startCellDrag,
  key,
} = useCellSelection({
  layout,
  scale,
  size,
  pan,
  viewport,
  liveCellSource,
  clearSelection,
})
const { dividers, dividerFeedback, hoverDivider, leaveDivider, resize }
  = useGridResize({ layout, scale, draftGrid, dragBacking, resizing })
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
    @dragover.prevent="dropTarget = ''"
    @drop.prevent="
      !dragging && e.drop($event);
      endCellDrag();
    "
  >
    <div
      v-if="e.state.panels.length || e.state.layout === 'grid'"
      class="preview-image"
      :class="{ 'is-interacting': resizing || dragging || e.spacingEditing }"
      :style="{
        width: `${(layout?.width ?? 1) * scale}px`,
        height: `${(layout?.height ?? 1) * scale}px`,
        transform: `translate(${zoom === null ? 0 : pan.x}px,${zoom === null ? 0 : pan.y}px)`,
      }"
    >
      <img
        v-if="e.preview?.dataUrl"
        v-show="!e.interactivePreview"
        :src="e.preview.dataUrl"
        alt="Composition"
        draggable="false"
        class="composition-image pointer-events-none"
        :style="compositionImageStyle"
      >
      <div
        v-if="(draftGrid || e.interactivePreview) && layout"
        :style="e.interactivePreview ? { background: e.state.mat } : {}"
        class="pointer-events-none absolute inset-0"
      >
        <div
          v-for="cell in e.interactivePreview ? [] : dragBacking?.layout.cells"
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
          class="absolute overflow-hidden"
          :style="{
            backgroundColor: e.state.mat,
            left: `${cell.x * scale}px`,
            top: `${cell.y * scale}px`,
            width: `${cell.width * scale}px`,
            height: `${cell.height * scale}px`,
          }"
        >
          <img
            v-if="liveCellImage(cell)"
            :src="liveCellSource(cell)!.dataUrl"
            alt=""
            draggable="false"
            class="live-cell-image"
            :style="liveCellImage(cell)!"
          >
        </div>
        <div
          v-for="(mask, index) in e.interactivePreview?.layout.masks ?? []"
          :key="`mask-${index}`"
          class="absolute"
          :style="{
            background: e.state.mat,
            left: `${mask.x * scale}px`,
            top: `${mask.y * scale}px`,
            width: `${mask.width * scale}px`,
            height: `${mask.height * scale}px`,
          }"
        />
        <div class="absolute inset-0 overflow-hidden pointer-events-none">
          <img
            v-for="(layer, index) in e.interactivePreview?.annotationLayers
              ?? []"
            :key="`annotation-${index}`"
            :src="layer.dataUrl"
            class="absolute pointer-events-none"
            alt=""
            draggable="false"
            :style="{
              left: `${layer.x * scale}px`,
              top: `${layer.y * scale}px`,
              width: `${layer.width * scale}px`,
              height: `${layer.height * scale}px`,
              opacity: layer.opacity ?? 1,
            }"
          >
        </div>
      </div>
      <img
        v-if="regionPreview?.region"
        v-show="regionAllowed && !dragging"
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
            'selected': e.selected.includes(cell.id),
            'empty': !cell.photoId,
            'drop-target': dropTarget === cell.id,
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
          @dragstart="startCellDrag($event, cell.id)"
          @dragend="endCellDrag"
          @dragover.stop.prevent="
            dropTarget = dragging === cell.id ? '' : cell.id
          "
          @dragleave="leaveCell"
          @drop.stop.prevent="
            dragging
              ? e.swap(dragging, cell.id)
              : e.drop($event, undefined, cell.id);
            endCellDrag();
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
        v-for="(_, index) in e.selected.length === 1 ? 4 : 0"
        :key="index"
        variant="ghost"
        size="icon-sm"
        :aria-label="
          ['Split left', 'Split right', 'Split up', 'Split down'][index]
        "
        :title="['Split left', 'Split right', 'Split up', 'Split down'][index]"
        @click="e.split(index < 2 ? 'horizontal' : 'vertical', index % 2 === 0)"
      >
        <svg
          class="size-4"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <rect
            x="2"
            y="4"
            width="20"
            height="16"
            rx="2"
            stroke="currentColor"
            stroke-width="1.75"
          />
          <rect
            :x="index === 1 ? 12.5 : 4.5"
            :y="index === 3 ? 12.5 : 6.5"
            :width="index < 2 ? 7 : 15"
            :height="index < 2 ? 11 : 5"
            rx=".7"
            fill="currentColor"
          />
        </svg>
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
      v-if="showRendering"
      class="absolute right-4 top-4 rounded bg-background px-2 py-1 text-xs text-muted-foreground"
    >Rendering…</span>
  </div>
</template>

<style scoped>
.composition-image {
  position: absolute;
  top: 0;
  left: 0;
  max-width: none;
  transform-origin: 0 0;
  will-change: transform;
}
.live-cell-image {
  position: absolute;
  max-width: none;
  transform-origin: 0 0;
  will-change: transform;
}
.preview-viewport {
  outline: none;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
  background: repeating-conic-gradient(
      var(--background) 0% 25%,
      color-mix(in srgb, var(--muted-foreground) 8%, var(--background)) 0% 50%
    )
    0/24px 24px;
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
.cell-overlay.drop-target {
  background: color-mix(in srgb, var(--primary) 22%, transparent);
  border-color: var(--primary);
  border-radius: 2px;
}
.cell-overlay.selected {
  border-color: var(--primary);
}
.divider {
  position: absolute;
  touch-action: none;
}
.divider-line {
  position: absolute;
  pointer-events: none;
  background: var(--primary);
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
.preview-viewport:hover .preview-image:not(.is-interacting) .add-track,
.add-track:focus-visible {
  opacity: 1;
}
.add-track:hover {
  background: var(--primary);
  color: var(--primary-foreground);
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
@keyframes grid-tools-appear {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.grid-tools {
  animation: grid-tools-appear 120ms ease-out;
  transition:
    left 150ms ease-in-out,
    top 150ms ease-in-out;
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 2px;
  white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .grid-tools {
    animation: none;
    transition: none;
  }
}
</style>
