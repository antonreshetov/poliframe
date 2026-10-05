<script setup lang="ts">
import type { DecodedTile } from '../../composables/preview/tile-cache'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { tileSurface } from '../../composables/preview/tile-cache'

const props = defineProps<{
  tiles: DecodedTile[]
  scale: number
  colorSpace: PredefinedColorSpace
}>()
const canvas = ref<HTMLCanvasElement>()

// One visible rectangle per cell preserves its pixel grid: no extra resampling
// when fractional layout coordinates are mapped to the canvas backing pixels.
const surface = computed(() => tileSurface(props.tiles))
watch(
  [canvas, () => props.tiles],
  () => {
    const target = canvas.value
    if (!target)
      return
    const region = surface.value
    target.width = region.pixelWidth
    target.height = region.pixelHeight
    // CPU assembly avoids retaining each tile in Chromium's separate GPU image cache.
    const context = target.getContext('2d', {
      colorSpace: props.colorSpace,
      willReadFrequently: true,
    })
    if (!context)
      return
    for (const tile of props.tiles) {
      context.drawImage(
        tile.bitmap,
        Math.round((tile.x - region.x) * region.xScale),
        Math.round((tile.y - region.y) * region.yScale),
      )
    }
  },
  { flush: 'post' },
)

onBeforeUnmount(() => {
  if (canvas.value) {
    canvas.value.width = 0
    canvas.value.height = 0
  }
})
</script>

<template>
  <canvas
    ref="canvas"
    class="pointer-events-none absolute"
    :style="{
      left: `${surface.x * scale}px`,
      top: `${surface.y * scale}px`,
      width: `${surface.width * scale}px`,
      height: `${surface.height * scale}px`,
    }"
  />
</template>
