<script setup lang="ts">
import { ImagePlus, X } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useEditorContext } from '@/composables/useEditor'
import CheckField from './CheckField.vue'
import ChoiceField from './ChoiceField.vue'
import NumberField from './NumberField.vue'

const e = useEditorContext()
const measure = computed(() => e.state[e.state.units])
const source = computed({
  get: () => e.state.caption.sourceId ?? 'off',
  set: (v: string) => {
    e.state.caption.sourceId = v === 'off' ? null : v
  },
})
const sources = computed(() => [
  { value: 'off', label: 'Off' },
  ...e.state.panels.map((p, i) => ({
    value: p.photoId,
    label: `Image ${i + 1}`,
  })),
])
function field(key: string, on: boolean) {
  e.state.caption.fields = on
    ? [...e.state.caption.fields, key]
    : e.state.caption.fields.filter(f => f !== key)
}
function separate() {
  if (e.state.caption.separatePadding) {
    for (const unit of ['percent', 'pixels'] as const)
      e.state[unit].captionBottom = e.state[unit].captionTop
  }
}
const captionStyles = [
  'studio',
  'retro',
  'editorial',
  'museum',
  'minimal',
  'classic',
  'luxe',
].map((value, index) => ({
  value,
  label: value[0]!.toUpperCase() + value.slice(1),
  group: index < 3 ? 'Inline' : 'Centered',
}))
const exifFields = [
  { value: 'camera', label: 'Camera' },
  { value: 'lens', label: 'Lens' },
  { value: 'focal', label: 'Focal length' },
  { value: 'aperture', label: 'Aperture' },
  { value: 'shutter', label: 'Shutter' },
  { value: 'iso', label: 'ISO' },
  { value: 'date', label: 'Date' },
]
const positions = [
  { value: 'topLeft', label: 'Top left' },
  { value: 'topCenter', label: 'Top center' },
  { value: 'topRight', label: 'Top right' },
  { value: 'midLeft', label: 'Center left' },
  { value: 'center', label: 'Center' },
  { value: 'midRight', label: 'Center right' },
  { value: 'bottomLeft', label: 'Bottom left' },
  { value: 'bottomCenter', label: 'Bottom center' },
  { value: 'bottomRight', label: 'Bottom right' },
]
async function dropLogo(event: DragEvent) {
  const paths = Array.from(event.dataTransfer?.files ?? [])
    .map(file => window.poliframe.droppedFilePath(file))
    .filter(Boolean)
  if (!paths.length || e.importing)
    return
  e.importing = true
  try {
    const result = await window.poliframe.importImages(paths)
    const photo = result.photos[0]
    if (photo) {
      e.photos[photo.id] = photo
      e.state.watermark.photoId = photo.id
    }
    if (result.photos.length > 1) {
      await window.poliframe.releaseImages(
        result.photos.slice(1).map(photo => photo.id),
      )
    }
    if (result.errors.length)
      e.error = result.errors.join('\n')
  }
  catch (error) {
    e.fail(error)
  }
  finally {
    e.importing = false
  }
}
</script>

<template>
  <div class="space-y-3">
    <CheckField
      v-model="e.state.caption.enabled"
      label="Caption"
    />
    <template v-if="e.state.caption.enabled">
      <ChoiceField
        v-model="e.state.caption.style"
        label="Preset"
        :options="captionStyles"
      />
      <label class="grid gap-1 text-xs">Title<Input
        v-model="e.state.caption.title"
        :maxlength="4096"
        placeholder="Untitled Frame"
      /></label>
      <label class="grid gap-1 text-xs">Copyright<Input
        v-model="e.state.caption.copyright"
        :maxlength="4096"
        placeholder="© Your name"
      /></label>
      <CheckField
        v-model="e.state.caption.showExif"
        label="Show EXIF"
      />
      <template v-if="e.state.caption.showExif">
        <CheckField
          v-model="e.state.caption.perPhoto"
          label="Under each photo"
          :disabled="e.state.layout === 'grid'"
        />
        <ChoiceField
          v-model="source"
          label="EXIF source"
          :options="sources"
          :disabled="e.state.caption.perPhoto && e.state.layout !== 'grid'"
        />
        <div class="space-y-1.5">
          <h3 class="text-xs">
            Fields
          </h3>
          <CheckField
            v-for="item in exifFields"
            :key="item.value"
            :model-value="e.state.caption.fields.includes(item.value)"
            :label="item.label"
            @update:model-value="field(item.value, $event)"
          />
        </div>
      </template>
      <NumberField
        v-model="e.state.caption.size"
        label="Caption size"
        :min="20"
        :max="200"
        suffix="%"
        @interaction-start="e.beginSpacing"
        @interaction-end="e.endSpacing"
      />
      <CheckField
        v-model="e.state.caption.separatePadding"
        label="Separate top / bottom"
        @update:model-value="separate"
      />
      <NumberField
        v-model="measure.captionTop"
        :label="
          e.state.caption.separatePadding ? 'Top padding' : 'Vertical padding'
        "
        :max="e.state.units === 'percent' ? 20 : 300"
        :suffix="e.state.units === 'percent' ? '%' : 'px'"
        @interaction-start="e.beginSpacing"
        @interaction-end="e.endSpacing"
        @update:model-value="
          !e.state.caption.separatePadding && (measure.captionBottom = $event)
        "
      />
      <NumberField
        v-if="e.state.caption.separatePadding"
        v-model="measure.captionBottom"
        label="Bottom padding"
        :max="e.state.units === 'percent' ? 20 : 300"
        :suffix="e.state.units === 'percent' ? '%' : 'px'"
        @interaction-start="e.beginSpacing"
        @interaction-end="e.endSpacing"
      />
      <NumberField
        v-model="measure.captionHorizontal"
        label="Horizontal padding"
        :max="e.state.units === 'percent' ? 20 : 300"
        :suffix="e.state.units === 'percent' ? '%' : 'px'"
        @interaction-start="e.beginSpacing"
        @interaction-end="e.endSpacing"
      />
    </template>
    <section class="space-y-3 border-t pt-3">
      <div class="flex items-center justify-between">
        <h2 class="text-xs">
          Watermark
        </h2>
        <Button
          v-if="e.state.watermark.photoId"
          variant="ghost"
          size="icon-xs"
          aria-label="Remove watermark"
          @click="e.state.watermark.photoId = null"
        >
          <X />
        </Button>
      </div>
      <template v-if="e.state.watermark.photoId">
        <button
          class="watermark-preview flex h-12 w-full items-center justify-center"
          aria-label="Replace watermark"
          title="Choose logo…"
          @click="e.logo"
          @dragover.prevent
          @drop.prevent="dropLogo"
        >
          <img
            :src="e.photos[e.state.watermark.photoId]?.thumbnail"
            class="max-h-12 max-w-full object-contain"
            alt="Watermark"
          >
        </button>
        <div
          class="grid w-fit grid-cols-3 gap-1"
          role="group"
          aria-label="Watermark position"
        >
          <Button
            v-for="position in positions"
            :key="position.value"
            :variant="
              e.state.watermark.position === position.value
                ? 'default'
                : 'secondary'
            "
            size="icon-xs"
            :aria-label="position.label"
            :title="position.label"
            :aria-pressed="e.state.watermark.position === position.value"
            @click="e.state.watermark.position = position.value"
          />
        </div>
        <NumberField
          v-model="e.state.watermark.opacity"
          label="Opacity"
          suffix="%"
          @interaction-start="e.beginSpacing"
          @interaction-end="e.endSpacing"
        />
        <NumberField
          v-model="e.state.watermark.size"
          label="Size"
          :min="5"
          :max="60"
          suffix="%"
          @interaction-start="e.beginSpacing"
          @interaction-end="e.endSpacing"
        />
      </template>
      <div
        v-else
        @dragover.prevent
        @drop.prevent="dropLogo"
      >
        <Button
          variant="secondary"
          size="sm"
          :disabled="e.importing"
          @click="e.logo"
        >
          <ImagePlus />Choose logo…
        </Button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.watermark-preview {
  background: repeating-conic-gradient(
      var(--muted) 0% 25%,
      var(--background) 0% 50%
    )
    0/16px 16px;
}
</style>
