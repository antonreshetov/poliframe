<script setup lang="ts">
import { Checkbox } from '@/components/ui/checkbox'

defineProps<{ label: string, disabled?: boolean }>()
const model = defineModel<boolean>({ required: true })
</script>

<template>
  <label class="flex items-center gap-1.5 text-xs"><Checkbox
    :model-value="model"
    :disabled="disabled"
    @update:model-value="model = $event === true"
  />{{ label }}</label>
</template>
