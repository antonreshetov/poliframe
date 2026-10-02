<script setup lang="ts">
import { Download, Minus, Plus, X } from '@lucide/vue'
import { provide, ref, watch } from 'vue'
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
const zoom = ref<number | null>(null)
const effectiveZoom = ref(100)
const fitZoom = ref(100)
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
        class="flex items-start gap-3 border-b bg-destructive/10 px-4 py-3 text-sm text-destructive"
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
      <div
        v-if="e.preview?.layout.warnings.length"
        class="border-t px-4 py-2 text-xs text-muted-foreground"
      >
        {{ e.preview.layout.warnings.join(" · ") }}
      </div>
      <p
        v-if="e.status"
        class="border-t px-4 py-2 text-xs text-muted-foreground"
        role="status"
      >
        {{ e.status }}
      </p>
      <footer class="toolbar">
        <div class="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom out"
            :disabled="effectiveZoom <= fitZoom + 0.1 || !e.preview"
            @click="
              zoom
                = (zoom ?? effectiveZoom) / 1.5 <= fitZoom
                  ? null
                  : (zoom ?? effectiveZoom) / 1.5
            "
          >
            <Minus />
          </Button><span class="w-12 text-center text-xs tabular-nums">{{
            `${Math.round(zoom ?? effectiveZoom)}%`
          }}</span><Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom in"
            :disabled="effectiveZoom >= 99.9 || !e.preview"
            @click="zoom = Math.min(100, (zoom ?? effectiveZoom) * 1.5)"
          >
            <Plus />
          </Button><Button
            variant="ghost"
            size="sm"
            @click="zoom = null"
          >
            Fit
          </Button><Button
            variant="ghost"
            size="sm"
            @click="zoom = 100"
          >
            100%
          </Button>
        </div>
        <div class="flex-1" />
        <PresetsMenu />
        <span
          v-if="e.preview && e.state.panels.length"
          class="text-xs text-muted-foreground tabular-nums whitespace-nowrap"
        >
          {{ e.preview.layout.width }} × {{ e.preview.layout.height }} px
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
  gap: 8px;
  padding: 6px 16px;
  border-top: 1px solid var(--border);
  min-height: 44px;
}
</style>
