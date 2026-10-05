import type { InjectionKey } from 'vue'
import type { Photo, Transform } from '../../shared/contracts'
import {
  computed,
  inject,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
} from 'vue'
import { toast } from 'vue-sonner'
import { defaults, identityTransform } from '../../shared/defaults'
import { leaves, useEditorGrid } from './editor/useEditorGrid'

import { useEditorPresets } from './editor/useEditorPresets'
import { useEditorRendering } from './editor/useEditorRendering'
import { useSupporter } from './useSupporter'

export { leaves } from './editor/useEditorGrid'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
export function useEditor() {
  const state = ref(defaults())
  const photos = reactive<Record<string, Photo>>({})
  const busy = ref(false)
  const exporting = ref(false)
  const importing = ref(false)
  const cropId = ref<string | null>(null)
  const {
    selected,
    history,
    future,
    capacity,
    mergeParent,
    fillGrid,
    reorder,
    template,
    split,
    clearCells,
    addTrack,
    deleteCells,
    swap,
    merge,
    checkpoint,
    undo,
    redo,
  } = useEditorGrid(state)
  const canExport = computed(
    () =>
      !busy.value
      && !importing.value
      && state.value.panels.some(
        p =>
          state.value.layout !== 'grid'
          || leaves(state.value.grid).some(l => l.photoId === p.photoId),
      ),
  )
  const fail = (e: unknown) => {
    const message = e instanceof Error ? e.message : String(e)
    toast.error(message, { id: 'editor-error', duration: 8000 })
  }
  const {
    presets,
    activePreset,
    presetModified,
    savePreset,
    renamePreset,
    deletePreset,
    applyPreset,
  } = useEditorPresets({ state, photos, fillGrid, fail })
  const referencedImages = computed(
    () =>
      new Set([
        ...state.value.panels.map(panel => panel.photoId),
        ...leaves(state.value.grid).flatMap(leaf =>
          leaf.photoId ? [leaf.photoId] : [],
        ),
        ...[
          state.value.watermark.photoId,
          state.value.caption.sourceId,
          state.value.output.metadataId,
          cropId.value,
        ].filter((id): id is string => !!id),
        ...presets.value.flatMap(preset =>
          preset.settings.watermark.photoId
            ? [preset.settings.watermark.photoId]
            : [],
        ),
        ...[...history.value, ...future.value].flatMap(entry => [
          ...entry.order,
          ...leaves(entry.grid).flatMap(leaf =>
            leaf.photoId ? [leaf.photoId] : [],
          ),
        ]),
      ]),
  )
  const releasing = new Set<string>()
  async function releaseUnusedImages() {
    if (importing.value || busy.value)
      return
    const ids = Object.keys(photos).filter(
      id => !referencedImages.value.has(id) && !releasing.has(id),
    )
    if (!ids.length)
      return
    ids.forEach(id => releasing.add(id))
    try {
      await window.poliframe.releaseImages(ids)
      for (const id of ids) {
        if (!referencedImages.value.has(id))
          delete photos[id]
      }
    }
    catch (error) {
      fail(error)
    }
    finally {
      ids.forEach(id => releasing.delete(id))
    }
  }
  watch(
    [referencedImages, importing, busy],
    () => {
      void releaseUnusedImages()
    },
    { flush: 'post' },
  )
  let restoreMetadata = true
  const {
    preview,
    previewSize,
    interactivePreview,
    spacingEditing,
    beginSpacing,
    endSpacing,
    renderRevision,
    rendering,
    markImportedPreview,
  } = useEditorRendering({ state, photos, fail })
  async function add(paths?: string[], replaceId?: string, cellId?: string) {
    if (importing.value)
      return
    importing.value = true
    try {
      const wasEmpty = !state.value.panels.length
      const result = await window.poliframe.importImages(paths)
      markImportedPreview()
      const accepted
        = replaceId || cellId
          ? result.photos.slice(0, 1)
          : result.photos.slice(
              0,
              Math.max(0, capacity.value - state.value.panels.length),
            )
      const unused = result.photos.filter(p => !accepted.includes(p))
      if (unused.length)
        await window.poliframe.releaseImages(unused.map(p => p.id))
      if (result.errors.length)
        fail(result.errors.join('\n'))
      for (const photo of accepted) {
        photos[photo.id] = photo
        const panel = { photoId: photo.id, transform: identityTransform() }
        if (replaceId) {
          history.value = []
          future.value = []
          const index = state.value.panels.findIndex(
            p => p.photoId === replaceId,
          )
          if (index >= 0)
            state.value.panels.splice(index, 1, panel)
          for (const leaf of leaves(state.value.grid)) {
            if (leaf.photoId === replaceId)
              leaf.photoId = photo.id
          }
          if (state.value.caption.sourceId === replaceId)
            state.value.caption.sourceId = photo.id
          if (state.value.output.metadataId === replaceId)
            state.value.output.metadataId = photo.id
        }
        else {
          state.value.panels.push(panel)
        }
        if (cellId) {
          const leaf = leaves(state.value.grid).find(l => l.id === cellId)
          if (leaf)
            leaf.photoId = photo.id
        }
        if (wasEmpty && state.value.panels.length === 1) {
          state.value.caption.sourceId = photo.id
          state.value.output.metadataId = restoreMetadata ? photo.id : null
        }
      }
      if (!cellId)
        fillGrid()
    }
    catch (e) {
      fail(e)
    }
    finally {
      importing.value = false
    }
  }
  function drop(event: DragEvent, replaceId?: string, cellId?: string) {
    const paths = Array.from(event.dataTransfer?.files ?? [])
      .map(f => window.poliframe.droppedFilePath(f))
      .filter(Boolean)
    if (paths.length)
      void add(paths, replaceId, cellId)
  }
  function remove(id: string) {
    const index = state.value.panels.findIndex(p => p.photoId === id)
    if (state.value.panels.length === 1)
      restoreMetadata = state.value.output.metadataId !== null
    state.value.panels = state.value.panels.filter(p => p.photoId !== id)
    for (const leaf of leaves(state.value.grid)) {
      if (leaf.photoId === id)
        leaf.photoId = null
    }
    const nearest
      = state.value.panels[Math.min(index, state.value.panels.length - 1)]
        ?.photoId ?? null
    if (state.value.caption.sourceId === id)
      state.value.caption.sourceId = nearest
    if (state.value.output.metadataId === id)
      state.value.output.metadataId = nearest
    history.value = []
    future.value = []
  }
  function applyCrop(transform: Transform) {
    const panel = state.value.panels.find(p => p.photoId === cropId.value)
    if (panel)
      panel.transform = transform
    cropId.value = null
  }
  async function exportImage() {
    if (!canExport.value)
      return
    busy.value = true
    try {
      const result = await window.poliframe.exportImage(
        clone(state.value),
        () => {
          exporting.value = true
        },
      )
      if (result.status === 'saved') {
        if (result.supportPrompt)
          useSupporter().prompt()
        const path = result.path
        toast.success('Image exported', {
          description: path,
          action: path
            ? {
                label: 'Show',
                onClick: () => {
                  void window.poliframe.revealFile(path).catch(fail)
                },
              }
            : undefined,
        })
      }
    }
    catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (/render budget|pixel budget|dimensions.*budget/i.test(message)) {
        fail(
          'This image is too large to export. Reduce its size in Export settings and try again.',
        )
      }
      else {
        fail(e)
      }
    }
    finally {
      exporting.value = false
      busy.value = false
    }
  }
  async function logo() {
    try {
      const photo = await window.poliframe.importLogo()
      if (photo) {
        photos[photo.id] = photo
        state.value.watermark.photoId = photo.id
      }
    }
    catch (e) {
      fail(e)
    }
  }
  function shortcut(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void exportImage()
    }
    if (
      (event.metaKey || event.ctrlKey)
      && event.key.toLowerCase() === 'z'
      && !(event.target instanceof HTMLInputElement)
    ) {
      event.preventDefault()
      event.shiftKey ? redo() : undo()
    }
  }
  onMounted(async () => {
    window.addEventListener('keydown', shortcut)
    try {
      presets.value = await window.poliframe.presets.list()
    }
    catch (e) {
      fail(e)
    }
  })
  onUnmounted(() => {
    window.removeEventListener('keydown', shortcut)
  })
  return reactive({
    state,
    photos,
    preview,
    interactivePreview,
    spacingEditing,
    beginSpacing,
    endSpacing,
    previewSize,
    renderRevision,
    busy,
    exporting,
    importing,
    rendering,
    selected,
    cropId,
    presets,
    activePreset,
    presetModified,
    history,
    future,
    capacity,
    canExport,
    mergeParent,
    add,
    drop,
    remove,
    reorder,
    template,
    split,
    clearCells,
    addTrack,
    deleteCells,
    swap,
    merge,
    checkpoint,
    undo,
    redo,
    applyCrop,
    exportImage,
    logo,
    savePreset,
    renamePreset,
    deletePreset,
    applyPreset,
    fail,
  })
}
export type Editor = ReturnType<typeof useEditor>

export const editorKey: InjectionKey<Editor> = Symbol('editor')
export function useEditorContext(): Editor {
  const editor = inject(editorKey)
  if (!editor)
    throw new Error('Editor context missing')
  return editor
}
