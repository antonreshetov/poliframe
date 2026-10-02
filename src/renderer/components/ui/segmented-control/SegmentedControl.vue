<script setup lang="ts">
import type { ToggleGroupRootEmits, ToggleGroupRootProps } from 'reka-ui'
import { ToggleGroupRoot, useForwardPropsEmits } from 'reka-ui'

const props = withDefaults(defineProps<ToggleGroupRootProps>(), {
  orientation: 'horizontal',
})
const emit = defineEmits<ToggleGroupRootEmits>()
const forwarded = useForwardPropsEmits(props, emit)
</script>

<template>
  <ToggleGroupRoot
    v-bind="forwarded"
    class="segmented-control"
  >
    <slot />
  </ToggleGroupRoot>
</template>
