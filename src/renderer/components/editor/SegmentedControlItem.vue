<script setup lang="ts">
import type { ToggleGroupItemProps } from 'reka-ui'
import { ToggleGroupItem, useForwardProps } from 'reka-ui'

const props = defineProps<ToggleGroupItemProps>()
const forwarded = useForwardProps(props)
</script>

<template>
  <ToggleGroupItem
    v-bind="forwarded"
    class="segmented-control-item"
  >
    <slot />
  </ToggleGroupItem>
</template>
