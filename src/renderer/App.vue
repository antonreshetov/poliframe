<script setup lang="ts">
import { Download, X, ZoomIn, ZoomOut } from '@lucide/vue'
import { useEventListener } from '@vueuse/core'
import { computed, provide, ref, watch } from 'vue'
import AnnotatePanel from '@/components/editor/AnnotatePanel.vue'
import ComposePanel from '@/components/editor/ComposePanel.vue'
import CropEditor from '@/components/editor/CropEditor.vue'
import ExportSettings from '@/components/editor/ExportSettings.vue'
import PresetsMenu from '@/components/editor/PresetsMenu.vue'
import PreviewCanvas from '@/components/editor/PreviewCanvas.vue'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { editorKey, useEditor } from '@/composables/useEditor'

const api = window.poliframe
const e = useEditor()
provide(editorKey, e)
const outputLayout = computed(
  () => e.interactivePreview?.layout ?? e.preview?.layout,
)
const zoom = ref<number | null>(null)
const effectiveZoom = ref(100)
const fitZoom = ref(100)
function zoomIn() {
  if (e.preview && effectiveZoom.value < 99.9)
    zoom.value = Math.min(100, (zoom.value ?? effectiveZoom.value) * 1.5)
}
function zoomOut() {
  if (!e.preview || effectiveZoom.value <= fitZoom.value + 0.1)
    return
  const next = (zoom.value ?? effectiveZoom.value) / 1.5
  zoom.value = next <= fitZoom.value ? null : next
}
useEventListener(window, 'keydown', (event) => {
  if (
    event.defaultPrevented
    || !(event.metaKey || event.ctrlKey)
    || event.altKey
  ) {
    return
  }
  if (!['+', '=', '-', '0'].includes(event.key))
    return
  event.preventDefault()
  if (document.querySelector('[role="dialog"]'))
    return
  if (event.key === '0')
    zoom.value = null
  else if (event.key === '-')
    zoomOut()
  else zoomIn()
})
watch(
  () => e.state.panels.map(panel => panel.photoId).join(),
  () => {
    zoom.value = null
  },
)
</script>

<template>
  <main class="editor-shell">
    <header class="titlebar">
      <span>Poliframe</span>
    </header>
    <aside class="sidebar">
      <Tabs
        default-value="compose"
        class="sidebar-tabs"
      >
        <div class="sidebar-tabbar">
          <TabsList>
            <TabsTrigger value="compose">
              Compose
            </TabsTrigger><TabsTrigger value="annotate">
              Annotate
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent
          value="compose"
          class="sidebar-scroll"
        >
          <ComposePanel />
        </TabsContent><TabsContent
          value="annotate"
          class="sidebar-scroll"
        >
          <AnnotatePanel />
        </TabsContent>
      </Tabs>
    </aside>
    <section class="workspace">
      <div
        v-if="e.error"
        class="absolute inset-x-4 top-4 z-20 flex items-start gap-3 rounded-md border bg-background px-4 py-3 text-sm text-destructive shadow-md"
        role="alert"
      >
        <span class="flex-1 whitespace-pre-line">{{ e.error }}</span><Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss error"
          @click="e.error = ''"
        >
          <X />
        </Button>
      </div>
      <PreviewCanvas
        :zoom="zoom"
        @zoom="zoom = $event"
        @scale="effectiveZoom = $event"
        @fit="fitZoom = $event"
      />
      <p
        v-if="e.status"
        class="absolute inset-x-4 bottom-16 z-20 rounded-md border bg-background px-4 py-2 text-xs text-muted-foreground shadow-md"
        role="status"
      >
        {{ e.status }}
      </p>
      <footer class="toolbar">
        <div class="flex items-center gap-1">
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label="Zoom out"
            :disabled="effectiveZoom <= fitZoom + 0.1 || !e.preview"
            @click="zoomOut"
          >
            <ZoomOut />
          </Button><span class="w-12 text-center text-xs tabular-nums">{{
            `${Math.round(zoom ?? effectiveZoom)}%`
          }}</span><Button
            variant="secondary"
            size="icon-sm"
            aria-label="Zoom in"
            :disabled="effectiveZoom >= 99.9 || !e.preview"
            @click="zoomIn"
          >
            <ZoomIn />
          </Button><Button
            variant="secondary"
            size="sm"
            :class="{ 'text-primary': zoom === null }"
            @click="zoom = null"
          >
            Fit
          </Button><Button
            variant="secondary"
            size="sm"
            :class="{ 'text-primary': zoom === 100 }"
            @click="zoom = 100"
          >
            100%
          </Button>
        </div>
        <div class="flex-1" />
        <PresetsMenu />
        <span
          v-if="outputLayout"
          class="text-xs text-muted-foreground tabular-nums whitespace-nowrap"
        >
          {{ outputLayout.width }} × {{ outputLayout.height }} px
        </span>
        <ExportSettings /><Button
          v-if="e.busy"
          variant="outline"
          @click="api.cancelExport().catch(e.fail)"
        >
          Cancel export
        </Button><Button
          v-else
          :disabled="!e.canExport"
          @click="e.exportImage"
        >
          <Download />Export…
        </Button>
      </footer>
    </section>
    <CropEditor />
  </main>
</template>

<style scoped>
.editor-shell {
  height: 100vh;
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  grid-template-rows: 33px minmax(0, 1fr);
  overflow: hidden;
}
.titlebar {
  grid-column: 1/-1;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding-left: 84px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  font-weight: 500;
  -webkit-app-region: drag;
  user-select: none;
}
.sidebar {
  border-right: 1px solid var(--border);
  min-height: 0;
  overflow: hidden;
}
.sidebar-tabbar {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 52px;
  border-bottom: 1px solid var(--border);
}
.sidebar-tabs {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 0;
}
.sidebar-scroll {
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  flex: 1;
}
.workspace {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.workspace > :deep(.preview-viewport) {
  flex: 1;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  min-height: 44px;
}
</style>
