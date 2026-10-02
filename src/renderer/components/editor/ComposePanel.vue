<script setup lang="ts">
import type { GridNode } from '../../../shared/contracts'
import { CircleCheck, Crop, Plus, TriangleAlert, X } from '@lucide/vue'
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useEditorContext } from '@/composables/useEditor'
import { matColors } from '../../../shared/defaults'
import CheckField from './CheckField.vue'
import ChoiceField from './ChoiceField.vue'
import NumberField from './NumberField.vue'

const e = useEditorContext()
const dragging = ref('')
const measure = computed(() => e.state[e.state.units])
const suffix = computed(() => (e.state.units === 'percent' ? '%' : 'px'))
const templates = [
  {
    name: '2x2',
    cells: [
      [2, 2, 9, 9],
      [13, 2, 9, 9],
      [2, 13, 9, 9],
      [13, 13, 9, 9],
    ],
  },
  {
    name: '3x3',
    cells: Array.from({ length: 9 }, (_, i) => [
      2 + (i % 3) * 7,
      2 + Math.floor(i / 3) * 7,
      6,
      6,
    ]),
  },
  {
    name: '1x2',
    cells: [
      [2, 2, 9, 20],
      [13, 2, 9, 20],
    ],
  },
  {
    name: '2x1',
    cells: [
      [2, 2, 20, 9],
      [2, 13, 20, 9],
    ],
  },
  {
    name: '1+2',
    cells: [
      [2, 2, 9, 20],
      [13, 2, 9, 9],
      [13, 13, 9, 9],
    ],
  },
  {
    name: '1over2',
    cells: [
      [2, 2, 20, 9],
      [2, 13, 9, 9],
      [13, 13, 9, 9],
    ],
  },
]
function setLayout(value: unknown) {
  if (value === 'horizontal' || value === 'vertical' || value === 'grid')
    e.state.layout = value
}
function setUnits(value: unknown) {
  if (value === 'percent' || value === 'pixels')
    e.state.units = value
}
function paperDimension(value: string | number) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0.01, Math.min(1000, numeric)) : 1
}
function separate() {
  if (e.state.separateFrame) {
    for (const unit of ['percent', 'pixels'] as const) {
      for (const edge of ['top', 'right', 'bottom', 'left'] as const)
        e.state[unit][edge] = e.state[unit].frame
    }
  }
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
const customCells = computed(() => {
  const cells: number[][] = []
  function walk(
    node: GridNode,
    x: number,
    y: number,
    width: number,
    height: number,
  ) {
    if (node.type === 'leaf') {
      cells.push([x, y, width, height])
      return
    }
    const sum = node.weights.reduce((a, b) => a + b, 0)
    let offset = 0
    node.children.forEach((child, i) => {
      const fraction = node.weights[i]! / sum
      node.axis === 'horizontal'
        ? walk(child, x + width * offset, y, width * fraction, height)
        : walk(child, x, y + height * offset, width, height * fraction)
      offset += fraction
    })
  }
  walk(e.state.grid, 2, 2, 20, 20)
  return cells
})
</script>

<template>
  <div class="space-y-3">
    <section class="space-y-2">
      <div class="flex justify-between text-sm">
        <h2 class="text-base font-semibold">
          Images
        </h2>
        <span
          :class="
            e.state.panels.length > e.capacity
              ? 'text-orange-500'
              : 'text-muted-foreground'
          "
        >{{ e.state.panels.length }} / {{ e.capacity }}</span>
      </div>
      <div
        v-for="(panel, i) in e.state.panels"
        :key="panel.photoId"
        class="flex items-center gap-2 rounded-md bg-muted p-1"
        draggable="true"
        @dragstart="dragging = panel.photoId"
        @dragover.prevent
        @drop.prevent="
          dragging
            ? e.reorder(dragging, panel.photoId)
            : e.drop($event, panel.photoId);
          dragging = '';
        "
        @dragend="dragging = ''"
      >
        <button
          class="relative shrink-0"
          :aria-label="`Replace image ${i + 1}`"
          title="Replace image"
          @click="e.add(undefined, panel.photoId)"
        >
          <img
            :src="e.photos[panel.photoId]?.thumbnail"
            class="h-10 w-10 rounded object-cover"
            alt=""
          ><span
            v-if="
              panel.transform.rotation
                || panel.transform.flipX
                || panel.transform.flipY
                || panel.transform.crop.width < 1
                || panel.transform.crop.height < 1
            "
            class="absolute bottom-0 right-0 rounded-full bg-primary p-0.5 text-primary-foreground"
          ><Crop :size="10" /></span>
        </button>
        <div class="min-w-0 flex-1">
          <p class="text-xs text-muted-foreground">
            {{ i + 1 }}
          </p>
          <p class="truncate text-xs">
            {{ e.photos[panel.photoId]?.name }}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          :aria-label="`Crop image ${i + 1}`"
          title="Crop & rotate"
          @click="e.cropId = panel.photoId"
        >
          <Crop />
        </Button><Button
          variant="ghost"
          size="icon-xs"
          :aria-label="`Remove image ${i + 1}`"
          @click="e.remove(panel.photoId)"
        >
          <X />
        </Button>
      </div>
      <div
        v-if="e.state.panels.length < e.capacity"
        class="flex h-14 items-center justify-center rounded-lg border border-dashed"
        @dragover.prevent
        @drop.prevent="e.drop($event)"
      >
        <Button
          variant="ghost"
          size="sm"
          :disabled="e.importing"
          @click="e.add()"
        >
          <Plus />{{ e.importing ? "Importing…" : "Add image" }}
        </Button>
      </div>
    </section>
    <section class="space-y-3 border-t pt-3">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-xs">
          Layout
        </h2>
        <ToggleGroup
          orientation="horizontal"
          :spacing="1"
          :model-value="e.state.layout"
          type="single"
          variant="outline"
          size="sm"
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
          <div class="flex gap-1">
            <Button
              v-for="template in templates"
              :key="template.name"
              :variant="
                activeTemplate === template.name ? 'default' : 'outline'
              "
              size="icon"
              :aria-label="`Grid template ${template.name}`"
              :title="template.name === '1over2' ? '1 over 2' : template.name"
              @click="e.template(template.name)"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
                aria-hidden="true"
              >
                <rect
                  v-for="(cell, index) in template.cells"
                  :key="index"
                  :x="cell[0]"
                  :y="cell[1]"
                  :width="cell[2]"
                  :height="cell[3]"
                  rx="1"
                />
              </svg>
            </Button>
            <Button
              v-if="!activeTemplate"
              variant="default"
              size="icon"
              aria-label="Custom grid"
              title="Custom"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1"
                aria-hidden="true"
              >
                <rect
                  v-for="(cell, index) in customCells"
                  :key="index"
                  :x="cell[0]! + 0.5"
                  :y="cell[1]! + 0.5"
                  :width="Math.max(0, cell[2]! - 1)"
                  :height="Math.max(0, cell[3]! - 1)"
                  rx=".5"
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
        <h2 class="text-xs">
          Units
        </h2>
        <ToggleGroup
          orientation="horizontal"
          :spacing="1"
          :model-value="e.state.units"
          type="single"
          variant="outline"
          size="sm"
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
        <div class="flex gap-1.5 py-1">
          <button
            v-for="color in matColors"
            :key="color"
            class="h-6 w-6 rounded-full border"
            :style="{
              background: color,
              outline:
                e.state.mat === color ? '2px solid var(--foreground)' : 'none',
              outlineOffset: '2px',
            }"
            :aria-label="`Mat ${color}`"
            :aria-pressed="e.state.mat === color"
            @click="e.state.mat = color"
          />
        </div>
      </div>
    </section>
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
              @update:model-value="
                e.state.print.height = paperDimension($event)
              "
            />
          </div>
          <ChoiceField
            v-model="e.state.print.units"
            label=""
            aria-label="Paper units"
            :options="['cm', 'mm', 'in']"
          />
        </div>
        <div class="space-y-1">
          <h3 class="text-xs">
            Orientation
          </h3>
          <ToggleGroup
            orientation="horizontal"
            :spacing="1"
            :model-value="e.state.print.orientation"
            type="single"
            variant="outline"
            size="sm"
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
          :spacing="1"
          :model-value="e.state.layout === 'grid' ? 'fit' : e.state.print.fit"
          type="single"
          variant="outline"
          size="sm"
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
            {{ e.state.print.units }} ·
            {{ Math.round(e.preview.layout.dpi) }} dpi
          </p>
        </div>
      </template>
    </section>
  </div>
</template>
