<script setup lang="ts">
import type { GridNode } from '../../../shared/contracts'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import {
  SegmentedControl as ToggleGroup,
  SegmentedControlItem as ToggleGroupItem,
} from '@/components/ui/segmented-control'
import { useEditorContext } from '@/composables/useEditor'
import { gridTemplate, matColors } from '../../../shared/defaults'
import { gridCells } from '../../../shared/layout'
import CheckField from './CheckField.vue'
import ChoiceField from './ChoiceField.vue'
import PhotoList from './compose/PhotoList.vue'
import PrintSettings from './compose/PrintSettings.vue'
import NumberField from './NumberField.vue'

const e = useEditorContext()
const measure = computed(() => e.state[e.state.units])
const suffix = computed(() => (e.state.units === 'percent' ? '%' : 'px'))
const thumbnailSize = computed(() => {
  const [w, h] = e.state.gridAspect.split(':').map(Number)
  const aspect = Math.max(0.6, Math.min(1.7, w! / h!))
  return aspect >= 1
    ? { width: 28, height: 28 / aspect }
    : { width: 28 * aspect, height: 28 }
})
function thumbnailCells(node: GridNode) {
  const { width, height } = thumbnailSize.value
  return gridCells(
    node,
    { x: (34 - width) / 2, y: (34 - height) / 2, width, height },
    Math.max(1.2, Math.min(width, height) * 0.05),
  )
}
const templates = computed(() =>
  ['2x2', '3x3', '1x2', '2x1', '1+2', '1over2'].map(name => ({
    name,
    cells: thumbnailCells(gridTemplate(name)),
  })),
)
function setLayout(value: unknown) {
  if (value === 'horizontal' || value === 'vertical' || value === 'grid')
    e.state.layout = value
}
function setUnits(value: unknown) {
  if (value === 'percent' || value === 'pixels')
    e.state.units = value
}
function separate() {
  if (e.state.separateFrame) {
    for (const unit of ['percent', 'pixels'] as const) {
      for (const edge of ['top', 'right', 'bottom', 'left'] as const)
        e.state[unit][edge] = e.state[unit].frame
    }
  }
}
function gridSignature(node: GridNode): string {
  if (node.type === 'leaf')
    return 'L'
  const total = node.weights.reduce((a, b) => a + b, 0)
  if (
    node.weights.some(
      weight => Math.abs(weight / total - 1 / node.children.length) > 0.001,
    )
  ) {
    return 'custom'
  }
  return `${node.axis === 'horizontal' ? 'H' : 'V'}(${node.children.map(gridSignature).join('')})`
}
const activeTemplate = computed(
  () =>
    ({
      'V(H(LL)H(LL))': '2x2',
      'V(H(LLL)H(LLL)H(LLL))': '3x3',
      'H(LL)': '1x2',
      'V(LL)': '2x1',
      'H(LV(LL))': '1+2',
      'V(LH(LL))': '1over2',
    })[gridSignature(e.state.grid)],
)
const customCells = computed(() => thumbnailCells(e.state.grid))
</script>

<template>
  <div class="space-y-3">
    <PhotoList />
    <section class="space-y-3 border-t pt-3">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-[13px]">
          Layout
        </h2>
        <ToggleGroup
          orientation="horizontal"
          class="layout-segments"
          :model-value="e.state.layout"
          type="single"
          @update:model-value="setLayout"
        >
          <ToggleGroupItem value="horizontal">
            Side by side
          </ToggleGroupItem>
          <ToggleGroupItem value="vertical">
            Stacked
          </ToggleGroupItem>
          <ToggleGroupItem value="grid">
            Grid
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <template v-if="e.state.layout === 'grid'">
        <div class="space-y-1.5">
          <h3 class="text-xs">
            Template
          </h3>
          <div class="grid w-full min-w-0 grid-cols-7 gap-1">
            <Button
              v-for="template in [
                ...templates,
                ...(!activeTemplate
                  ? [{ name: 'Custom', cells: customCells }]
                  : []),
              ]"
              :key="template.name"
              variant="ghost"
              size="icon"
              class="grid-template-thumb"
              :aria-pressed="
                activeTemplate === template.name || template.name === 'Custom'
              "
              :aria-label="
                template.name === 'Custom'
                  ? 'Custom grid'
                  : `Grid template ${template.name}`
              "
              :title="template.name === '1over2' ? '1 over 2' : template.name"
              @click="template.name !== 'Custom' && e.template(template.name)"
            >
              <svg
                class="size-[34px]"
                viewBox="0 0 34 34"
                fill="currentColor"
                aria-hidden="true"
              >
                <rect
                  v-for="cell in template.cells"
                  :key="cell.id"
                  :x="cell.x"
                  :y="cell.y"
                  :width="cell.width"
                  :height="cell.height"
                  rx="1.5"
                />
              </svg>
            </Button>
          </div>
        </div>
        <ChoiceField
          v-model="e.state.gridAspect"
          label="Aspect"
          :options="['1:1', '4:5', '3:2', '2:3', '16:9', '9:16']"
          :disabled="e.state.print.enabled"
        />
      </template>
      <div class="flex items-center gap-2">
        <h2 class="text-[13px]">
          Units
        </h2>
        <ToggleGroup
          orientation="horizontal"
          :model-value="e.state.units"
          type="single"
          @update:model-value="setUnits"
        >
          <ToggleGroupItem value="percent">
            %
          </ToggleGroupItem><ToggleGroupItem value="pixels">
            px
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <NumberField
        v-model="measure.gap"
        label="Gap"
        :disabled="e.state.layout !== 'grid' && e.state.panels.length < 2"
        :max="e.state.units === 'percent' ? 15 : 400"
        :suffix="suffix"
        @interaction-start="e.beginSpacing"
        @interaction-end="e.endSpacing"
      />
      <div class="space-y-1.5">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-xs">
            Frame
          </h2>
          <CheckField
            v-model="e.state.separateFrame"
            label="Separate sides"
            @update:model-value="separate"
          />
        </div>
        <NumberField
          v-if="!e.state.separateFrame"
          v-model="measure.frame"
          label="All"
          :max="e.state.units === 'percent' ? 15 : 400"
          :suffix="suffix"
          @interaction-start="e.beginSpacing"
          @interaction-end="e.endSpacing"
        /><template v-else>
          <NumberField
            v-for="edge in ['top', 'right', 'bottom', 'left'] as const"
            :key="edge"
            v-model="measure[edge]"
            :label="edge[0]!.toUpperCase() + edge.slice(1)"
            :max="e.state.units === 'percent' ? 15 : 400"
            :suffix="suffix"
            @interaction-start="e.beginSpacing"
            @interaction-end="e.endSpacing"
          />
        </template>
      </div>
      <div class="space-y-1.5">
        <h2 class="text-xs">
          Mat color
        </h2>
        <div class="flex gap-2 py-1">
          <button
            v-for="color in matColors"
            :key="color"
            class="h-5 w-5 rounded-full border"
            :style="{
              background: color,
              outline:
                e.state.mat === color ? '2px solid var(--primary)' : 'none',
              outlineOffset: '2px',
            }"
            :aria-label="`Mat ${color}`"
            :aria-pressed="e.state.mat === color"
            @click="e.state.mat = color"
          />
        </div>
      </div>
    </section>
    <PrintSettings />
  </div>
</template>
