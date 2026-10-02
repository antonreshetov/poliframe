<script setup lang="ts">
import { computed } from 'vue'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const props = defineProps<{
  label: string
  options: (string | { value: string, label: string, group?: string })[]
  disabled?: boolean
}>()
const model = defineModel<string>({ required: true })
const groups = computed(() => {
  const result = new Map<string, { value: string, label: string }[]>()
  for (const option of props.options) {
    const item
      = typeof option === 'string' ? { value: option, label: option } : option
    const group = typeof option === 'string' ? '' : (option.group ?? '')
    if (!result.has(group))
      result.set(group, [])
    result.get(group)!.push(item)
  }
  return [...result].map(([label, options]) => ({ label, options }))
})
</script>

<template>
  <label class="flex items-center justify-between gap-2 text-xs"><span
    v-if="label"
    class="shrink-0"
  >{{ label }}</span><Select
    v-model="model"
    :disabled="disabled"
  ><SelectTrigger
    size="sm"
    :aria-label="label || 'Units'"
  ><SelectValue /></SelectTrigger><SelectContent><SelectGroup
    v-for="(group, index) in groups"
    :key="group.label"
  ><SelectSeparator v-if="index > 0" /><SelectLabel
    v-if="group.label"
  >{{ group.label }}</SelectLabel><SelectItem
    v-for="option in group.options"
    :key="option.value"
    :value="option.value"
  >{{ option.label }}</SelectItem></SelectGroup></SelectContent></Select></label>
</template>
