import type { InjectionKey } from 'vue'
import type {
  GridLeaf,
  GridNode,
  Photo,
  Preset,
  PreviewResult,
  Transform,
} from '../../shared/contracts'
import {
  computed,
  inject,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
} from 'vue'
import {
  defaults,
  gridTemplate,
  identityTransform,
} from '../../shared/defaults'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
export function leaves(node: GridNode): GridLeaf[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(leaves)
}
export function useEditor() {
  const state = ref(defaults())
  const photos = reactive<Record<string, Photo>>({})
  const preview = ref<PreviewResult | null>(null)
  const previewSize = ref(2200)
  const renderRevision = ref(0)
  const error = ref('')
  const status = ref('')
  const busy = ref(false)
  const importing = ref(false)
  const rendering = ref(false)
  const selected = ref<string[]>([])
  const cropId = ref<string | null>(null)
  const presets = ref<Preset[]>([])
  const activePreset = ref('')
  const presetBaseline = ref('')
  function presetSignature() {
    const {
      panels: _panels,
      revision: _revision,
      print: _print,
      ...value
    } = clone(state.value)
    value.caption.sourceId = null
    value.output.metadataId = null
    for (const leaf of leaves(value.grid)) leaf.photoId = null
    if (value.layout !== 'grid') {
      value.layout = 'horizontal'
      value.grid = null as unknown as GridNode
    }
    return JSON.stringify(value)
  }
  const presetModified = computed(
    () =>
      presets.value.some(p => p.id === activePreset.value)
      && presetBaseline.value !== presetSignature(),
  )
  interface GridHistory {
    grid: GridNode
    order: string[]
  }
  const history = ref<GridHistory[]>([])
  const future = ref<GridHistory[]>([])
  const capacity = computed(() =>
    state.value.layout === 'grid' ? leaves(state.value.grid).length : 4,
  )
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
    error.value = e instanceof Error ? e.message : String(e)
  }
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
  let generation = 0
  let timer: ReturnType<typeof setTimeout>
  watch(
    [state, previewSize],
    () => {
      const revision = ++generation
      renderRevision.value = revision
      clearTimeout(timer)
      if (!state.value.panels.length && state.value.layout !== 'grid') {
        preview.value = null
        rendering.value = false
        return
      }
      timer = setTimeout(async () => {
        rendering.value = true
        try {
          const snapshot = clone(state.value)
          snapshot.revision = revision
          const result = await window.poliframe.preview(
            snapshot,
            previewSize.value,
          )
          if (revision === generation)
            preview.value = result
        }
        catch (e) {
          if (revision === generation)
            fail(e)
        }
        finally {
          if (revision === generation)
            rendering.value = false
        }
      }, 120)
    },
    { deep: true, immediate: true },
  )
  function snapshotGrid(): GridHistory {
    return {
      grid: clone(state.value.grid),
      order: state.value.panels.map(p => p.photoId),
    }
  }
  function orderPanels(order: string[]) {
    state.value.panels.sort((a, b) => {
      const rank = (id: string) => {
        const index = order.indexOf(id)
        return index < 0 ? order.length : index
      }
      return rank(a.photoId) - rank(b.photoId)
    })
  }
  function syncPool() {
    orderPanels(
      leaves(state.value.grid).flatMap(l => (l.photoId ? [l.photoId] : [])),
    )
  }
  function checkpoint() {
    history.value.push(snapshotGrid())
    if (history.value.length > 80)
      history.value.shift()
    future.value = []
  }
  function undo() {
    const grid = history.value.pop()
    if (grid) {
      future.value.push(snapshotGrid())
      state.value.grid = grid.grid
      orderPanels(grid.order)
      selected.value = []
    }
  }
  function redo() {
    const grid = future.value.pop()
    if (grid) {
      history.value.push(snapshotGrid())
      state.value.grid = grid.grid
      orderPanels(grid.order)
      selected.value = []
    }
  }
  function fillGrid() {
    const used = new Set(leaves(state.value.grid).map(l => l.photoId))
    const available = state.value.panels.filter(p => !used.has(p.photoId))
    for (const leaf of leaves(state.value.grid)) {
      if (!leaf.photoId)
        leaf.photoId = available.shift()?.photoId ?? null
    }
  }
  async function add(paths?: string[], replaceId?: string, cellId?: string) {
    if (importing.value)
      return
    importing.value = true
    error.value = ''
    try {
      const wasEmpty = !state.value.panels.length
      const result = await window.poliframe.importImages(paths)
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
        error.value = result.errors.join('\n')
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
  function reorder(from: string, to: string) {
    const list = state.value.panels
    const a = list.findIndex(p => p.photoId === from)
    const b = list.findIndex(p => p.photoId === to)
    if (a < 0 || b < 0 || a === b)
      return
    checkpoint()
    list.splice(b, 0, list.splice(a, 1)[0]!)
    const ids = list.map(p => p.photoId)
    for (const l of leaves(state.value.grid)) {
      if (l.photoId)
        l.photoId = ids.shift() ?? null
    }
  }
  function template(name: string) {
    checkpoint()
    state.value.grid = gridTemplate(
      name,
      state.value.panels.map(p => p.photoId),
    )
    selected.value = []
  }
  function replaceNode(
    node: GridNode,
    id: string,
    replacement: GridNode | null,
  ): GridNode | null {
    if (node.id === id)
      return replacement
    if (node.type === 'leaf')
      return node
    node.children = node.children
      .map(n => replaceNode(n, id, replacement))
      .filter((n): n is GridNode => !!n)
    if (node.children.length === 1)
      return node.children[0]!
    if (!node.children.length)
      return null
    if (node.weights.length !== node.children.length)
      node.weights = node.children.map(() => 1 / node.children.length)
    return node
  }
  function split(axis: 'horizontal' | 'vertical', before = false) {
    const leaf = leaves(state.value.grid).find(
      l => l.id === selected.value[0],
    )
    if (!leaf)
      return
    checkpoint()
    const empty: GridLeaf = {
      id: crypto.randomUUID(),
      type: 'leaf',
      photoId: null,
    }
    state.value.grid = replaceNode(state.value.grid, leaf.id, {
      id: crypto.randomUUID(),
      type: 'split',
      axis,
      weights: [0.5, 0.5],
      children: before ? [empty, clone(leaf)] : [clone(leaf), empty],
    })!
  }
  function clearCells() {
    checkpoint()
    for (const l of leaves(state.value.grid)) {
      if (selected.value.includes(l.id))
        l.photoId = null
    }
    syncPool()
  }
  function deleteCells() {
    if (leaves(state.value.grid).length <= selected.value.length)
      return
    checkpoint()
    for (const id of selected.value) {
      state.value.grid = replaceNode(state.value.grid, id, null) ?? {
        id: crypto.randomUUID(),
        type: 'leaf',
        photoId: null,
      }
    }
    selected.value = []
    syncPool()
  }
  function swap(a: string, b: string) {
    const list = leaves(state.value.grid)
    const x = list.find(l => l.id === a)
    const y = list.find(l => l.id === b)
    if (!x || !y)
      return
    checkpoint();
    [x.photoId, y.photoId] = [y.photoId, x.photoId]
    syncPool()
  }
  const mergeParent = computed(() => {
    function find(node: GridNode): Extract<GridNode, { type: 'split' }> | null {
      if (node.type === 'leaf')
        return null
      const indices = node.children.flatMap((child, index) =>
        child.type === 'leaf' && selected.value.includes(child.id)
          ? [index]
          : [],
      )
      if (
        indices.length > 1
        && indices.length === selected.value.length
        && indices.at(-1)! - indices[0]! + 1 === indices.length
      ) {
        return node
      }
      return node.children.map(find).find(Boolean) ?? null
    }
    return find(state.value.grid)
  })
  function merge() {
    const parent = mergeParent.value
    if (!parent)
      return
    checkpoint()
    const firstIndex = parent.children.findIndex(child =>
      selected.value.includes(child.id),
    )
    const children = parent.children.slice(
      firstIndex,
      firstIndex + selected.value.length,
    )
    const first = children.flatMap(leaves).find(leaf => leaf.photoId)
    const merged: GridLeaf = {
      id: crypto.randomUUID(),
      type: 'leaf',
      photoId: first?.photoId ?? null,
    }
    const weight = parent.weights
      .slice(firstIndex, firstIndex + children.length)
      .reduce((a, b) => a + b, 0)
    parent.children.splice(firstIndex, children.length, merged)
    parent.weights.splice(firstIndex, children.length, weight)
    if (parent.children.length === 1)
      state.value.grid = replaceNode(state.value.grid, parent.id, merged)!
    selected.value = [merged.id]
    syncPool()
  }
  function addTrack(axis: 'horizontal' | 'vertical', before: boolean) {
    checkpoint()
    const leaf: GridLeaf = {
      id: crypto.randomUUID(),
      type: 'leaf',
      photoId: null,
    }
    state.value.grid = {
      id: crypto.randomUUID(),
      type: 'split',
      axis,
      children: before ? [leaf, state.value.grid] : [state.value.grid, leaf],
      weights: before ? [0.25, 0.75] : [0.75, 0.25],
    }
    selected.value = [leaf.id]
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
    error.value = ''
    try {
      const result = await window.poliframe.exportImage(clone(state.value))
      status.value
        = result.status === 'saved'
          ? `Saved to ${result.path}`
          : 'Export cancelled'
    }
    catch (e) {
      fail(e)
    }
    finally {
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
  function settings(): Preset['settings'] {
    const { panels: _p, revision: _r, ...rest } = clone(state.value)
    for (const l of leaves(rest.grid)) l.photoId = null
    return rest
  }
  async function savePreset(name: string, id?: string) {
    if (!name.trim())
      return
    try {
      const old = presets.value.find(p => p.id === id)
      const preset: Preset = {
        id: id ?? crypto.randomUUID(),
        name: name.trim(),
        createdAt: old?.createdAt ?? new Date().toISOString(),
        settings: settings(),
      }
      await window.poliframe.presets.save(preset)
      presets.value = await window.poliframe.presets.list()
      activePreset.value = preset.id
      presetBaseline.value = presetSignature()
    }
    catch (e) {
      fail(e)
    }
  }
  async function renamePreset(id: string, name: string) {
    const preset = presets.value.find(p => p.id === id)
    if (!preset || !name.trim())
      return
    try {
      await window.poliframe.presets.save({
        ...clone(preset),
        name: name.trim(),
      })
      presets.value = await window.poliframe.presets.list()
    }
    catch (e) {
      fail(e)
    }
  }
  async function deletePreset(id: string) {
    try {
      await window.poliframe.presets.remove(id)
      presets.value = presets.value.filter(p => p.id !== id)
      activePreset.value = ''
    }
    catch (e) {
      fail(e)
    }
  }
  function applyPreset(id: string) {
    const previous = state.value
    const base = defaults()
    const saved = presets.value.find(p => p.id === id)
    if (id === 'builtin') {
      base.percent.frame = 6
      base.caption.enabled = true
      base.caption.title = 'Untitled Frame'
      base.caption.copyright = '© John Doe'
      base.percent.captionBottom = 0
      base.caption.separatePadding = true
    }
    const next = saved ? { ...base, ...clone(saved.settings) } : base
    next.panels = previous.panels
    next.print = id === 'defaults' ? base.print : previous.print
    if (!saved || saved.settings.layout !== 'grid') {
      next.layout = previous.layout
      next.grid = previous.grid
    }
    next.caption.sourceId = previous.caption.sourceId
    next.output.metadataId = previous.output.metadataId
    if (next.watermark.photoId && saved?.logo) {
      photos[next.watermark.photoId] = {
        id: next.watermark.photoId,
        name: 'Preset watermark',
        width: 1,
        height: 1,
        thumbnail: saved.logo,
        exif: {},
      }
    }
    state.value = next
    if (saved?.settings.layout === 'grid')
      fillGrid()
    activePreset.value = id
    presetBaseline.value = presetSignature()
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
    clearTimeout(timer)
    window.removeEventListener('keydown', shortcut)
  })
  return reactive({
    state,
    photos,
    preview,
    previewSize,
    renderRevision,
    error,
    status,
    busy,
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
