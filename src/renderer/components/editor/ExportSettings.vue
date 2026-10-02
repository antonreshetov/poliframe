<script setup lang="ts">
import { ChevronDown, SlidersHorizontal } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useEditorContext } from '@/composables/useEditor'
import ChoiceField from './ChoiceField.vue'
import NumberField from './NumberField.vue'

const e = useEditorContext()
const depth = computed({
  get: () => String(e.state.output.depth),
  set: (v: string) => {
    e.state.output.depth = v === '16' ? 16 : 8
  },
})
const dpi = computed({
  get: () => String(e.state.output.dpi),
  set: (v: string) => {
    e.state.output.dpi = Number(v)
  },
})
const source = computed({
  get: () => e.state.output.metadataId ?? 'off',
  set: (v: string) => {
    e.state.output.metadataId = v === 'off' ? null : v
  },
})
const sources = computed(() => [
  { value: 'off', label: 'Off' },
  ...e.state.panels.map((p, i) => ({
    value: p.photoId,
    label: `Image ${i + 1}`,
  })),
])
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <Button
        variant="outline"
        size="icon"
        aria-label="Export settings"
        title="Export settings"
      >
        <SlidersHorizontal />
      </Button>
    </PopoverTrigger><PopoverContent
      side="top"
      align="end"
    >
      <div class="space-y-3">
        <div class="flex items-center justify-between text-xs">
          <label
            for="export-size"
            class="font-medium"
          >Export size</label>
          <span
            v-if="e.preview"
            class="text-muted-foreground"
          >{{ e.preview.layout.width }} ×
            {{ e.preview.layout.height }} px</span>
        </div>
        <InputGroup>
          <InputGroupInput
            id="export-size"
            v-model="e.state.output.size"
            :maxlength="32"
            placeholder="Auto"
          />
          <InputGroupAddon align="inline-end">
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <InputGroupButton aria-label="Export size presets">
                  <ChevronDown />
                </InputGroupButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem
                  v-for="size in [
                    '',
                    '0.5x',
                    '0.75x',
                    '1x',
                    '1280w',
                    '1920w',
                    '2560w',
                    '1080h',
                    '1920h',
                  ]"
                  :key="size"
                  @select="e.state.output.size = size"
                >
                  {{ size || "Auto" }}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </InputGroupAddon>
        </InputGroup>
        <p class="text-xs text-muted-foreground">
          e.g. 1200w · 800h · 2x
        </p>
        <div class="flex items-center gap-2 text-xs">
          <span>Format</span>
          <ToggleGroup
            type="single"
            :model-value="e.state.output.format"
            @update:model-value="
              ['jpeg', 'png', 'tiff'].includes(String($event))
                && (e.state.output.format = $event as 'jpeg' | 'png' | 'tiff')
            "
          >
            <ToggleGroupItem
              v-for="format in ['jpeg', 'png', 'tiff']"
              :key="format"
              :value="format"
            >
              {{ format.toUpperCase() }}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <ChoiceField
          v-model="e.state.output.profile"
          label="Color profile"
          :options="[
            { value: 'srgb', label: 'sRGB' },
            { value: 'p3', label: 'Display P3' },
            { value: 'adobe', label: 'Adobe RGB' },
          ]"
        /><NumberField
          v-if="e.state.output.format === 'jpeg'"
          v-model="e.state.output.quality"
          label="Quality"
          :min="1"
          suffix="%"
        /><ChoiceField
          v-else
          v-model="depth"
          label="Bit depth"
          :options="[
            { value: '8', label: '8-bit' },
            { value: '16', label: '16-bit' },
          ]"
        /><ChoiceField
          v-if="!e.state.print.enabled"
          v-model="dpi"
          label="DPI"
          :options="['72', '150', '300']"
        /><ChoiceField
          v-model="source"
          label="Metadata"
          :options="sources"
        />
      </div>
    </PopoverContent>
  </Popover>
</template>
