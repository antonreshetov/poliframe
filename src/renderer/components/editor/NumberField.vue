<script setup lang="ts">
import { Slider } from '@/components/ui/slider'

defineProps<{
  label: string
  max?: number
  min?: number
  suffix?: string
  disabled?: boolean
}>()
const model = defineModel<number>({ required: true })
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center justify-between gap-2 text-xs">
      <span>{{ label }}</span><span class="tabular-nums text-muted-foreground">{{ model }}{{ suffix }}</span>
    </div>
    <Slider
      :disabled="disabled"
      :model-value="[model]"
      :min="min ?? 0"
      :max="max ?? 100"
      :step="1"
      :aria-label="label"
      @update:model-value="model = $event?.[0] ?? 0"
    />
  </div>
</template>
