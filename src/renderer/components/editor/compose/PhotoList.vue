<script setup lang="ts">
import { CircleX, Crop, ImagePlus } from '@lucide/vue'
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { useEditorContext } from '@/composables/useEditor'

const e = useEditorContext()
const dragging = ref('')
const dragOrder = ref<string[] | null>(null)
let dragSlots: { top: number, bottom: number }[] = []
const displayedPanels = computed(() =>
  dragOrder.value
    ? dragOrder.value
        .map(id => e.state.panels.find(panel => panel.photoId === id)!)
        .filter(Boolean)
    : e.state.panels,
)
function startPanelDrag(event: DragEvent, id: string) {
  const list = (event.currentTarget as HTMLElement).parentElement!
  dragSlots = Array.from(list.querySelectorAll<HTMLElement>('.photo-row')).map(
    row => ({
      top: row.offsetTop,
      bottom: row.offsetTop + row.offsetHeight,
    }),
  )
  dragging.value = id
  dragOrder.value = e.state.panels.map(panel => panel.photoId)
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
  }
}
function movePanelDrag(event: DragEvent) {
  if (!dragOrder.value || !dragging.value)
    return
  const list = event.currentTarget as HTMLElement
  const y = event.clientY - list.getBoundingClientRect().top
  const from = dragOrder.value.indexOf(dragging.value)
  const current = dragSlots[from]
  if (!current)
    return
  // Keep a small dead zone around the current slot so boundary jitter cannot reverse a move.
  if (y >= current.top - 4 && y <= current.bottom + 4)
    return
  const target = dragSlots.findIndex(
    slot => y >= slot.top && y <= slot.bottom,
  )
  if (target < 0 || from === target)
    return
  const next = [...dragOrder.value]
  next.splice(target, 0, next.splice(from, 1)[0]!)
  dragOrder.value = next
}
function endPanelDrag() {
  dragging.value = ''
  dragOrder.value = null
  dragSlots = []
}
function dropPanel(event: DragEvent, id: string) {
  if (dragging.value && dragOrder.value) {
    const index = dragOrder.value.indexOf(dragging.value)
    const target = e.state.panels[index]?.photoId
    if (target)
      e.reorder(dragging.value, target)
  }
  else {
    e.drop(event, id)
  }
  endPanelDrag()
}
</script>

<template>
  <section class="space-y-2">
    <div class="flex justify-between text-sm">
      <h2 class="text-base font-semibold">
        Images
      </h2>
      <span
        class="self-center text-[11px]"
        :class="
          e.state.panels.length > e.capacity
            ? 'text-orange-500'
            : 'text-muted-foreground'
        "
      >{{ e.state.panels.length }}/{{ e.capacity }}</span>
    </div>
    <TransitionGroup
      name="photo-reorder"
      tag="div"
      class="relative space-y-1"
      @dragover.prevent="movePanelDrag"
    >
      <div
        v-for="(panel, i) in displayedPanels"
        :key="panel.photoId"
        class="photo-row flex items-center gap-2 rounded-md bg-card p-1"
        :class="{ 'is-dragging': dragging === panel.photoId }"
        draggable="true"
        @dragstart="startPanelDrag($event, panel.photoId)"
        @dragover.prevent
        @drop.stop.prevent="dropPanel($event, panel.photoId)"
        @dragend="endPanelDrag"
      >
        <button
          class="relative shrink-0"
          :aria-label="`Replace image ${i + 1}`"
          title="Replace image"
          @click="e.add(undefined, panel.photoId)"
        >
          <img
            :src="e.photos[panel.photoId]?.thumbnail"
            class="h-10 w-10 rounded object-cover"
            alt=""
            draggable="false"
          ><span
            v-if="
              panel.transform.rotation
                || panel.transform.flipX
                || panel.transform.flipY
                || panel.transform.crop.width < 1
                || panel.transform.crop.height < 1
            "
            class="absolute bottom-0 right-0 rounded-full bg-primary p-0.5 text-primary-foreground"
          ><Crop :size="10" /></span>
        </button>
        <div class="min-w-0 flex-1">
          <p class="text-xs text-muted-foreground">
            {{ i + 1 }}
          </p>
          <p class="truncate text-xs">
            {{ e.photos[panel.photoId]?.name }}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          :aria-label="`Crop image ${i + 1}`"
          title="Crop & rotate"
          @click="e.cropId = panel.photoId"
        >
          <Crop />
        </Button><Button
          variant="ghost"
          size="icon-xs"
          :aria-label="`Remove image ${i + 1}`"
          @click="e.remove(panel.photoId)"
        >
          <CircleX class="remove-photo-icon" />
        </Button>
      </div>
    </TransitionGroup>
    <Button
      v-if="e.state.panels.length < e.capacity"
      variant="ghost"
      class="add-image-zone"
      :disabled="e.importing"
      @click="e.add()"
      @dragover.prevent
      @drop.prevent="e.drop($event)"
    >
      <ImagePlus />{{ e.importing ? "Importing…" : "Add image" }}
    </Button>
  </section>
</template>

<style scoped>
.photo-row.is-dragging {
  opacity: 0.18;
}
.photo-reorder-move {
  transition: transform 140ms ease-in-out;
}
</style>
