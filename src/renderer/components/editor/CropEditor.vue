<script setup lang="ts">
import {
  FlipHorizontal2,
  FlipVertical2,
  RotateCcw,
  RotateCw,
} from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useEditorContext } from '@/composables/useEditor'
import { identityTransform } from '../../../shared/defaults'

const e = useEditorContext()
const draft = ref(identityTransform())
const stage = ref<HTMLElement>()
const photo = computed(() => (e.cropId ? e.photos[e.cropId] : null))
const rotated = computed(() => Math.abs(draft.value.rotation % 180) === 90)
const imageRatio = computed(() =>
  photo.value
    ? rotated.value
      ? photo.value.height / photo.value.width
      : photo.value.width / photo.value.height
    : 1,
)
const cell = computed(() =>
  e.preview?.layout.cells.find(c => c.photoId === e.cropId),
)
const locked = computed(
  () =>
    e.state.layout === 'grid'
    || (e.state.print.enabled && e.state.print.fit === 'fill'),
)
const ratio = computed(() => {
  if (locked.value) {
    return cell.value
      ? cell.value.width / cell.value.height
      : e.state.print.width / e.state.print.height
  }
  if (draft.value.aspect === 'Free')
    return 0
  if (draft.value.aspect === 'Original')
    return imageRatio.value
  const [w, h] = draft.value.aspect.split(':').map(Number)
  const value = (w || 1) / (h || 1)
  return imageRatio.value < 1 ? 1 / value : value
})
function aspect() {
  if (!ratio.value)
    return
  const normalized = ratio.value / imageRatio.value
  const w = Math.min(1, normalized)
  const h = Math.min(1, 1 / normalized)
  draft.value.crop = { x: (1 - w) / 2, y: (1 - h) / 2, width: w, height: h }
}
watch(
  () => e.cropId,
  () => {
    const panel = e.state.panels.find(p => p.photoId === e.cropId)
    if (panel) {
      draft.value = JSON.parse(JSON.stringify(panel.transform))
      const currentRatio
        = (imageRatio.value * draft.value.crop.width) / draft.value.crop.height
      if (locked.value && Math.abs(currentRatio / ratio.value - 1) >= 0.03)
        aspect()
    }
  },
)
function rotate(direction: number) {
  draft.value.rotation = (draft.value.rotation + direction + 360) % 360
  draft.value.crop = { x: 0, y: 0, width: 1, height: 1 }
  aspect()
}
function drag(event: PointerEvent, handle = '') {
  event.preventDefault()
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  const bounds = stage.value!.getBoundingClientRect()
  const start = { ...draft.value.crop }
  const x = event.clientX
  const y = event.clientY
  const move = (ev: PointerEvent) => {
    const dx = (ev.clientX - x) / bounds.width
    const dy = (ev.clientY - y) / bounds.height
    if (!handle) {
      draft.value.crop = {
        ...start,
        x: Math.max(0, Math.min(1 - start.width, start.x + dx)),
        y: Math.max(0, Math.min(1 - start.height, start.y + dy)),
      }
      return
    }
    const left = handle.includes('w')
    const top = handle.includes('n')
    const anchorX = left ? start.x + start.width : start.x
    const anchorY = top ? start.y + start.height : start.y
    let width = Math.max(
      0.05,
      Math.min(left ? anchorX : 1 - anchorX, start.width + (left ? -dx : dx)),
    )
    let height = Math.max(
      0.05,
      Math.min(top ? anchorY : 1 - anchorY, start.height + (top ? -dy : dy)),
    )
    if (ratio.value) {
      const normalized = ratio.value / imageRatio.value
      height = width / normalized
      const maxHeight = top ? anchorY : 1 - anchorY
      if (height > maxHeight) {
        height = maxHeight
        width = height * normalized
      }
    }
    draft.value.crop = {
      x: left ? anchorX - width : anchorX,
      y: top ? anchorY - height : anchorY,
      width,
      height,
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
</script>

<template>
  <Dialog
    :open="!!e.cropId"
    @update:open="!$event && (e.cropId = null)"
  >
    <DialogContent
      :show-close-button="false"
      class="sm:max-w-[580px]"
      @keydown.enter.prevent="e.applyCrop(JSON.parse(JSON.stringify(draft)))"
    >
      <DialogHeader class="sr-only">
        <DialogTitle>Crop & rotate</DialogTitle><DialogDescription>
          {{
            locked
              ? "Locked to cell or paper"
              : "Drag the crop area or resize its corners."
          }}
        </DialogDescription>
      </DialogHeader>
      <div class="crop-container">
        <div
          v-if="photo"
          ref="stage"
          class="crop-stage"
          :style="{
            aspectRatio: imageRatio,
            width: `min(100%, ${imageRatio * 424}px)`,
          }"
        >
          <img
            :src="photo.thumbnail"
            alt="Crop preview"
            class="crop-image"
            :style="{
              width: rotated ? `${100 / imageRatio}%` : '100%',
              height: rotated ? `${100 * imageRatio}%` : '100%',
              transform: `translate(-50%, -50%) scale(${draft.flipX ? -1 : 1}, ${draft.flipY ? -1 : 1}) rotate(${draft.rotation}deg)`,
            }"
          >
          <div
            class="crop-selection"
            :style="{
              left: `${draft.crop.x * 100}%`,
              top: `${draft.crop.y * 100}%`,
              width: `${draft.crop.width * 100}%`,
              height: `${draft.crop.height * 100}%`,
            }"
            @pointerdown="drag($event)"
          >
            <span
              v-for="handle in ['nw', 'ne', 'sw', 'se']"
              :key="handle"
              class="crop-handle"
              :class="[handle]"
              @pointerdown.stop="drag($event, handle)"
            />
          </div>
        </div>
      </div>
      <p
        v-if="photo"
        class="text-xs text-muted-foreground tabular-nums"
      >
        Original {{ photo.width }} × {{ photo.height }} px → Cropped
        {{
          Math.round((rotated ? photo.height : photo.width) * draft.crop.width)
        }}
        ×
        {{
          Math.round((rotated ? photo.width : photo.height) * draft.crop.height)
        }}
        px
      </p>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Rotate left"
          @click="rotate(-90)"
        >
          <RotateCcw />
        </Button><Button
          variant="outline"
          size="icon-sm"
          aria-label="Rotate right"
          @click="rotate(90)"
        >
          <RotateCw />
        </Button><Button
          :variant="draft.flipX ? 'secondary' : 'outline'"
          size="icon-sm"
          aria-label="Flip horizontal"
          @click="draft.flipX = !draft.flipX"
        >
          <FlipHorizontal2 />
        </Button><Button
          :variant="draft.flipY ? 'secondary' : 'outline'"
          size="icon-sm"
          aria-label="Flip vertical"
          @click="draft.flipY = !draft.flipY"
        >
          <FlipVertical2 />
        </Button>
        <div class="flex-1" />
        <span
          v-if="locked"
          class="text-xs text-muted-foreground"
        >{{
          e.state.layout === "grid" ? "Locked to cell" : "Locked to paper"
        }}</span>
        <Select
          v-else
          v-model="draft.aspect"
          @update:model-value="aspect"
        >
          <SelectTrigger
            size="sm"
            aria-label="Aspect ratio"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="value in ['Free', '1:1', '3:2', '16:9', 'Original']"
              :key="value"
              :value="value"
            >
              {{ value }}
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="secondary"
          size="sm"
          @click="
            draft = identityTransform();
            draft.aspect = 'Free';
            aspect();
          "
        >
          Reset
        </Button>
      </div>
      <DialogFooter class="border-t pt-3">
        <Button
          variant="outline"
          @click="e.cropId = null"
        >
          Cancel
        </Button><Button @click="e.applyCrop(JSON.parse(JSON.stringify(draft)))">
          Apply
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.crop-container {
  height: min(440px, 60vh);
  display: flex;
  align-items: center;
  justify-content: center;
  background: repeating-conic-gradient(
      var(--muted) 0% 25%,
      color-mix(in srgb, var(--muted), var(--background) 35%) 0% 50%
    )
    0/16px 16px;
  overflow: hidden;
}
.crop-stage {
  position: relative;
  max-height: min(424px, 57vh);
  overflow: hidden;
  touch-action: none;
}
.crop-image {
  position: absolute;
  left: 50%;
  top: 50%;
  max-width: none;
  pointer-events: none;
}
.crop-selection {
  position: absolute;
  border: 2px solid white;
  box-shadow: 0 0 0 1000px #0008;
  cursor: move;
  touch-action: none;
}
.crop-handle {
  position: absolute;
  width: 12px;
  height: 12px;
  background: white;
  border-radius: 50%;
  border: 1px solid #333;
  touch-action: none;
}
.nw {
  left: -6px;
  top: -6px;
  cursor: nwse-resize;
}
.ne {
  right: -6px;
  top: -6px;
  cursor: nesw-resize;
}
.sw {
  left: -6px;
  bottom: -6px;
  cursor: nesw-resize;
}
.se {
  right: -6px;
  bottom: -6px;
  cursor: nwse-resize;
}
</style>
