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

<style>
.segmented-control {
    display: inline-flex;
    align-items: stretch;
    width: fit-content;
    height: 24px;
    padding: 0;
    gap: 0;
    border-radius: 5px;
    background: var(--secondary);
    color: var(--foreground);
}
.segmented-control-item {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 36px;
    padding: 0 10px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    font-size: 13px;
    font-weight: 500;
    line-height: 24px;
    white-space: nowrap;
    user-select: none;
    transition: none;
}
.segmented-control-item + .segmented-control-item::before {
    content: "";
    position: absolute;
    left: 0;
    top: 5px;
    bottom: 5px;
    width: 1px;
    background: var(--muted-foreground);
    opacity: 0.45;
}
.segmented-control-item[data-state="on"] {
    background: var(--primary);
    color: var(--primary-foreground);
}
.segmented-control-item[data-state="on"]::before,
.segmented-control-item[data-state="on"] + .segmented-control-item::before {
    display: none;
}
.segmented-control-item:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
    z-index: 1;
}
.segmented-control-item:disabled {
    opacity: 0.5;
    pointer-events: none;
}

</style>
