<script setup lang="ts">
import { CircleCheck, TriangleAlert } from '@lucide/vue'
import { Input } from '@/components/ui/input'
import {
  SegmentedControl as ToggleGroup,
  SegmentedControlItem as ToggleGroupItem,
} from '@/components/ui/segmented-control'
import { useEditorContext } from '@/composables/useEditor'
import CheckField from '../CheckField.vue'
import ChoiceField from '../ChoiceField.vue'

const e = useEditorContext()
function paperDimension(value: string | number) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0.01, Math.min(1000, numeric)) : 1
}
const paperFormats = [
  ...[
    [10, 15],
    [13, 18],
    [15, 21],
    [20, 30],
    [30, 40],
    [40, 50],
    [40, 60],
    [50, 70],
    [60, 90],
  ].map(([width, height]) => ({
    name: `${width} × ${height} cm`,
    width: width!,
    height: height!,
    units: 'cm' as const,
    group: 'Photo (cm)',
  })),
  ...[
    [4, 6],
    [5, 7],
    [8, 10],
    [11, 14],
    [16, 20],
  ].map(([width, height]) => ({
    name: `${width} × ${height} in`,
    width: width!,
    height: height!,
    units: 'in' as const,
    group: 'Photo (inch)',
  })),
  { name: 'A4', width: 21, height: 29.7, units: 'cm' as const, group: 'Paper' },
  { name: 'A3', width: 29.7, height: 42, units: 'cm' as const, group: 'Paper' },
  { name: 'A2', width: 42, height: 59.4, units: 'cm' as const, group: 'Paper' },
  {
    name: 'US Letter',
    width: 8.5,
    height: 11,
    units: 'in' as const,
    group: 'Paper',
  },
]
const paperOptions = [
  ...paperFormats.map(format => ({
    value: format.name,
    label: format.name,
    group: format.group,
  })),
  { value: 'Custom', label: 'Custom…', group: '' },
]
function paper(value: string) {
  const format = paperFormats.find(format => format.name === value)
  if (format) {
    e.state.print.width = format.width
    e.state.print.height = format.height
    e.state.print.units = format.units
  }
}
function orientation(value: unknown) {
  if (value === 'auto' || value === 'portrait' || value === 'landscape')
    e.state.print.orientation = value
}
function fit(value: unknown) {
  if (value === 'fit' || value === 'fill')
    e.state.print.fit = value
}
</script>

<template>
  <section class="space-y-3 border-t pt-3">
    <CheckField
      v-model="e.state.print.enabled"
      label="Print layout"
    />
    <template v-if="e.state.print.enabled">
      <ChoiceField
        v-model="e.state.print.paper"
        label="Paper"
        :options="paperOptions"
        @update:model-value="paper"
      />
      <div
        v-if="e.state.print.paper === 'Custom'"
        class="flex items-center gap-1.5"
      >
        <div class="w-16">
          <Input
            :model-value="e.state.print.width"
            type="number"
            min=".01"
            max="1000"
            step=".01"
            aria-label="Paper width"
            @update:model-value="e.state.print.width = paperDimension($event)"
          />
        </div>
        <span class="text-xs text-muted-foreground">×</span>
        <div class="w-16">
          <Input
            :model-value="e.state.print.height"
            type="number"
            min=".01"
            max="1000"
            step=".01"
            aria-label="Paper height"
            @update:model-value="e.state.print.height = paperDimension($event)"
          />
        </div>
        <ChoiceField
          v-model="e.state.print.units"
          label=""
          aria-label="Paper units"
          :options="['cm', 'mm', 'in']"
        />
      </div>
      <div class="relative space-y-1">
        <h3 class="text-xs">
          Orientation
        </h3>
        <ToggleGroup
          orientation="horizontal"
          :model-value="e.state.print.orientation"
          type="single"
          @update:model-value="orientation"
        >
          <ToggleGroupItem value="auto">
            Auto
          </ToggleGroupItem><ToggleGroupItem value="portrait">
            Portrait
          </ToggleGroupItem><ToggleGroupItem value="landscape">
            Landscape
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <ToggleGroup
        orientation="horizontal"
        :model-value="e.state.layout === 'grid' ? 'fit' : e.state.print.fit"
        type="single"
        :disabled="!e.state.panels.length || e.state.layout === 'grid'"
        aria-label="Print fit"
        @update:model-value="fit"
      >
        <ToggleGroupItem value="fit">
          Fit
        </ToggleGroupItem><ToggleGroupItem value="fill">
          Fill
        </ToggleGroupItem>
      </ToggleGroup>
      <div
        v-if="e.preview && e.state.panels.length"
        class="space-y-0.5 text-xs"
      >
        <p
          class="flex items-center gap-1"
          :class="
            e.preview.layout.dpi < 150 ? 'text-orange-500' : 'text-green-500'
          "
        >
          <component
            :is="e.preview.layout.dpi < 150 ? TriangleAlert : CircleCheck"
            :size="12"
          />{{
            e.preview.layout.dpi < 150
              ? "Low quality"
              : e.preview.layout.dpi < 300
                ? "Good quality"
                : "Excellent quality"
          }}
        </p>
        <p class="tabular-nums text-muted-foreground">
          {{ e.state.print.width }} × {{ e.state.print.height }}
          {{ e.state.print.units }} · {{ Math.round(e.preview.layout.dpi) }} dpi
        </p>
      </div>
    </template>
  </section>
</template>
