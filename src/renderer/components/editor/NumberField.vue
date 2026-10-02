<script setup lang="ts">
import { onUnmounted } from 'vue'
import { Slider } from '@/components/ui/slider'

defineProps<{
  label: string
  max?: number
  min?: number
  suffix?: string
  disabled?: boolean
}>()
const emit = defineEmits<{ interactionStart: [], interactionEnd: [] }>()
let interacting = false
function end() {
  if (!interacting)
    return
  interacting = false
  window.removeEventListener('pointerup', end)
  window.removeEventListener('pointercancel', end)
  window.removeEventListener('blur', end)
  emit('interactionEnd')
}
function start() {
  if (interacting)
    return
  interacting = true
  emit('interactionStart')
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
  window.addEventListener('blur', end)
}
onUnmounted(end)
const model = defineModel<number>({ required: true })
</script>

<template>
  <div class="number-field space-y-0.5">
    <div class="flex items-center justify-between gap-2 text-xs">
      <span>{{ label }}</span><span class="tabular-nums text-muted-foreground">{{ model }}{{ suffix }}</span>
    </div>
    <div class="relative">
      <Slider
        :disabled="disabled"
        :model-value="[model]"
        :min="min ?? 0"
        :max="max ?? 100"
        :step="1"
        :aria-label="label"
        @pointerdown="start"
        @value-commit="end"
        @update:model-value="model = $event?.[0] ?? 0"
      />
      <div
        v-if="max === 15 && suffix === '%'"
        class="pointer-events-none absolute inset-x-2 bottom-0 flex justify-between"
        aria-hidden="true"
      >
        <span
          v-for="tick in 16"
          :key="tick"
          class="size-[2px] rounded-full bg-muted-foreground/50"
        />
      </div>
    </div>
  </div>
</template>
