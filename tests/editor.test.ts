// @vitest-environment happy-dom
import assert from 'node:assert/strict'
import { afterEach, it, vi } from 'vitest'
import * as vue from 'vue'
import PhotoList from '../src/renderer/components/editor/compose/PhotoList.vue'
import PrintSettings from '../src/renderer/components/editor/compose/PrintSettings.vue'
import ComposePanel from '../src/renderer/components/editor/ComposePanel.vue'
import PreviewCanvas from '../src/renderer/components/editor/PreviewCanvas.vue'
import { usePreviewViewport } from '../src/renderer/composables/preview/usePreviewViewport.ts'
import { leaves, useEditor } from '../src/renderer/composables/useEditor.ts'
import * as defaultsModule from '../src/shared/defaults.ts'
import * as geometry from '../src/shared/layout.ts'

const context = vi.hoisted(() => ({ editor: null, notifications: [] }))
vi.mock('../src/renderer/composables/useEditor.ts', async importOriginal => ({
  ...(await importOriginal()),
  useEditorContext: () => context.editor,
}))
vi.mock('vue-sonner', () => ({
  toast: Object.fromEntries(
    ['error', 'success', 'info'].map(type => [
      type,
      (message, options) =>
        context.notifications.push({ type, message, options }),
    ]),
  ),
}))
const cleanups = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.unstubAllGlobals()
})

// A real Vue component scope runs lifecycle hooks and disposes watchers/timers.
// The editor renders no DOM in these state/bridge regression tests.
const renderer = vue.createRenderer({
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  insert() {},
  remove() {},
  setText() {},
  setElementText() {},
  patchProp() {},
  parentNode: () => null,
  nextSibling: () => null,
})
async function flush() {
  await vue.nextTick()
  await Promise.resolve()
  await vue.nextTick()
}
function setup(_t) {
  const notifications = []
  const registry = new Set()
  let sequence = 0
  const api = {
    importImages: async () => {
      assert.ok(registry.size < 160, 'main-process image registry exhausted')
      const id = `photo-${++sequence}`
      registry.add(id)
      return {
        photos: [
          {
            id,
            name: id,
            width: 100,
            height: 100,
            thumbnail: 'data:,',
            exif: {},
          },
        ],
        errors: [],
      }
    },
    releaseImages: async ids => ids.forEach(id => registry.delete(id)),
    preview: async snapshot => ({
      revision: snapshot.revision,
      dataUrl: 'data:,',
      layout: {
        width: 100,
        height: 100,
        nativeWidth: 100,
        nativeHeight: 100,
        dpi: 72,
        cells: [],
        captions: [],
        warnings: [],
      },
    }),
    presets: { list: async () => [] },
  }
  const window = {
    poliframe: api,
    addEventListener() {},
    removeEventListener() {},
  }
  vi.stubGlobal('window', window)
  vi.stubGlobal('requestAnimationFrame', callback => setTimeout(callback, 0))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  context.notifications = notifications
  let editor
  const app = renderer.createApp({
    setup() {
      editor = useEditor()
      return () => null
    },
  })
  app.mount({})
  cleanups.push(() => app.unmount())
  return { editor, registry, leaves, api, window, notifications }
}

it('replacing more than the registry capacity reclaims originals and thumbnails', async (t) => {
  const { editor, registry, notifications } = setup(t)
  await editor.add()
  for (let i = 0; i < 170; i++) {
    const previous = editor.state.panels[0].photoId
    await editor.add(undefined, previous)
    await flush()
    assert.equal(registry.size, 1)
    assert.equal(registry.has(previous), false)
    assert.equal(Object.keys(editor.photos).length, 1)
    assert.equal(editor.photos[previous], undefined)
  }
  editor.remove(editor.state.panels[0].photoId)
  await flush()
  assert.equal(registry.size, 0)
  assert.equal(Object.keys(editor.photos).length, 0)
  assert.equal(notifications.length, 0)
})

it('clear retains pooled images; style presets preserve empty cells; grid presets populate', async (t) => {
  const { editor, registry, leaves, notifications } = setup(t)
  await editor.add()
  await editor.add()
  editor.state.layout = 'grid'
  editor.template('1x2')
  const emptyId = leaves(editor.state.grid)[0].id
  const clearedPhoto = leaves(editor.state.grid)[0].photoId
  editor.selected = [emptyId]
  editor.clearCells()
  await flush()
  assert.equal(registry.has(clearedPhoto), true)
  assert.ok(editor.photos[clearedPhoto])
  assert.equal(editor.state.panels.length, 2)

  for (const id of ['defaults', 'builtin']) {
    editor.applyPreset(id)
    assert.equal(
      leaves(editor.state.grid).find(leaf => leaf.id === emptyId).photoId,
      null,
    )
  }
  const {
    panels: _panels,
    revision: _revision,
    ...settings
  } = defaultsModule.defaults()
  editor.presets.push({ id: 'style', name: 'Style', createdAt: '', settings })
  editor.applyPreset('style')
  assert.equal(
    leaves(editor.state.grid).find(leaf => leaf.id === emptyId).photoId,
    null,
  )
  assert.equal(editor.state.layout, 'grid')

  editor.presets.push({
    id: 'grid',
    name: 'Grid',
    createdAt: '',
    settings: { ...settings, layout: 'grid' },
  })
  editor.applyPreset('grid')
  await flush()
  assert.equal(
    leaves(editor.state.grid).filter(leaf => leaf.photoId).length,
    2,
  )
  assert.equal(registry.size, 2)
  assert.equal(notifications.length, 0)
})

it('compose mode handlers ignore deselection and accept valid layout and units', () => {
  const editor = vue.reactive({ state: defaultsModule.defaults() })
  context.editor = editor
  const controls = ComposePanel.setup({}, { expose() {} })
  controls.setLayout('grid')
  controls.setUnits('pixels')
  for (const invalid of ['', undefined, [], 'unknown']) {
    controls.setLayout(invalid)
    controls.setUnits(invalid)
    assert.equal(editor.state.layout, 'grid')
    assert.equal(editor.state.units, 'pixels')
  }
  const photoControls = PhotoList.setup({}, { expose() {} })
  editor.state.panels = [{ photoId: 'a' }, { photoId: 'b' }]
  const rows = [
    { offsetTop: 0, offsetHeight: 48 },
    { offsetTop: 52, offsetHeight: 48 },
  ]
  const list = {
    querySelectorAll: () => rows,
    getBoundingClientRect: () => ({ top: 100 }),
  }
  photoControls.startPanelDrag({ currentTarget: { parentElement: list } }, 'a')
  photoControls.movePanelDrag({ currentTarget: list, clientY: 154 })
  assert.deepEqual(Array.from(photoControls.dragOrder.value), ['b', 'a'])
  rows[0].offsetTop = 52
  rows[1].offsetTop = 0
  for (const y of [154, 151, 149, 152, 154]) {
    photoControls.movePanelDrag({ currentTarget: list, clientY: y })
    assert.deepEqual(Array.from(photoControls.dragOrder.value), ['b', 'a'])
  }
  assert.deepEqual(
    editor.state.panels.map(panel => panel.photoId),
    ['a', 'b'],
  )
  photoControls.movePanelDrag({ currentTarget: list, clientY: 140 })
  assert.deepEqual(Array.from(photoControls.dragOrder.value), ['a', 'b'])
  photoControls.endPanelDrag()
  controls.setLayout('vertical')
  controls.setUnits('percent')
  assert.equal(editor.state.layout, 'vertical')
  assert.equal(editor.state.units, 'percent')
})

it('preset changes made during an asynchronous update remain marked unsaved', async (t) => {
  const { editor, api } = setup(t)
  await flush()
  let finishSave
  let stored
  api.presets.save = (preset) => {
    stored = JSON.parse(JSON.stringify(preset))
    return new Promise((resolve) => {
      finishSave = resolve
    })
  }
  api.presets.list = async () => [stored]
  editor.state.mat = '#F4EFE3'
  const saving = editor.savePreset('Async preset')
  editor.state.mat = '#000000'
  finishSave()
  await saving
  assert.equal(stored.settings.mat, '#F4EFE3')
  assert.equal(editor.presetModified, true)
  editor.state.mat = '#F4EFE3'
  assert.equal(editor.presetModified, false)
})

async function gridFixture(t, template = '1x2') {
  const { editor } = setup(t)
  await flush()
  editor.state.layout = 'grid'
  editor.state.grid = defaultsModule.gridTemplate(template)
  const base = await geometry.calculateLayout(editor.state, [])
  editor.preview = { revision: 0, dataUrl: 'data:,', layout: base }
  let controls
  const handlers = new Map()
  context.editor = editor
  Object.assign(window, {
    devicePixelRatio: 1,
    addEventListener: (name, handler) => handlers.set(name, handler),
    removeEventListener: name => handlers.delete(name),
  })
  const component = PreviewCanvas
  // Run setup inside a component scope, but leave browser-only mount hooks uncalled.
  const scope = vue.effectScope()
  cleanups.push(() => scope.stop())
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    controls = scope.run(() =>
      component.setup({ zoom: null }, { expose() {}, emit() {} }),
    )
  }
  finally {
    console.warn = originalWarn
  }
  const target = {
    parentElement: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    setPointerCapture() {},
    addEventListener: (name, handler) => handlers.set(name, handler),
    removeEventListener: name => handlers.delete(name),
  }
  return { editor, controls, handlers, target, base }
}

it('grid divider uses live geometry without mutating the render model until release', async (t) => {
  const { editor, controls, handlers, target, base } = await gridFixture(t)
  const original = JSON.stringify(editor.state.grid)
  const history = editor.history.length
  controls.resize(
    {
      preventDefault() {},
      stopPropagation() {},
      currentTarget: target,
      pointerId: 1,
      clientX: 100,
    },
    controls.dividers.value[0],
  )
  for (let i = 0; i < 100; i++)
    handlers.get('pointermove')({ clientX: 130 + i / 10, metaKey: true })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(
    JSON.stringify(editor.state.grid),
    original,
    'drag must not schedule native renders',
  )
  assert.equal(editor.history.length, history)
  assert.notEqual(
    controls.layout.value.cells[0].width,
    base.cells[0].width,
    'live cell must follow the pointer',
  )
  handlers.get('pointerup')({ type: 'pointerup' })
  assert.notEqual(JSON.stringify(editor.state.grid), original)
  assert.equal(
    editor.history.length,
    history + 1,
    'one gesture is one undo entry',
  )
  editor.undo()
  assert.equal(JSON.stringify(editor.state.grid), original)
})

it('option divider snaps with hysteresis, reports percentages and preserves the other segment', async (t) => {
  const { controls, handlers, target } = await gridFixture(t, '2x2')
  const divider = controls.dividers.value.find(
    item => item.node.axis === 'horizontal',
  )
  const other = controls.dividers.value.find(
    item =>
      item.node.axis === 'horizontal' && item.node.id !== divider.node.id,
  )
  const originalOther = JSON.stringify(other.node.weights)
  controls.hoverDivider({ altKey: false }, divider)
  assert.ok(
    controls.dividerFeedback.value.hi - controls.dividerFeedback.value.lo
    > divider.height,
  )
  controls.resize(
    {
      preventDefault() {},
      stopPropagation() {},
      currentTarget: target,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
      altKey: true,
    },
    divider,
  )
  async function move(delta, metaKey = false) {
    handlers.get('pointermove')({
      clientX: 100 + delta,
      clientY: 100,
      metaKey,
    })
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await move(4)
  assert.equal(controls.dividerFeedback.value.percent, 50)
  assert.equal(controls.dividerFeedback.value.snapped, true)
  assert.ok(
    Math.abs(controls.dividerFeedback.value.position - divider.x) < 1e-6,
  )
  await move(8)
  assert.equal(controls.dividerFeedback.value.snapped, true)
  await move(14)
  assert.equal(controls.dividerFeedback.value.snapped, false)
  await move(4, true)
  assert.equal(controls.dividerFeedback.value.snapped, false)
  assert.ok(
    Math.abs(
      controls.dividerFeedback.value.position
      - divider.x
      - 4 / controls.scale.value,
    ) < 1e-6,
  )
  assert.equal(JSON.stringify(other.node.weights), originalOther)
  handlers.get('pointerup')({ type: 'pointerup' })
  assert.equal(controls.dividerFeedback.value, null)
})

it('option on a through divider splits the hovered segment and cancellation restores the tree', async (t) => {
  const { editor, controls, handlers, target } = await gridFixture(t, '2x2')
  const original = JSON.stringify(editor.state.grid)
  const divider = controls.dividers.value.find(
    item => item.node.axis === 'vertical',
  )
  const event = {
    preventDefault() {},
    stopPropagation() {},
    currentTarget: target,
    pointerId: 1,
    clientX: (divider.x + divider.width / 4) * controls.scale.value,
    clientY: divider.y * controls.scale.value,
    altKey: true,
  }
  controls.hoverDivider(event, divider)
  assert.ok(
    controls.dividerFeedback.value.hi - controls.dividerFeedback.value.lo
    < divider.width,
  )
  controls.resize(event, divider)
  handlers.get('pointermove')({
    clientX: event.clientX,
    clientY: event.clientY + 40,
    metaKey: true,
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  const segments = controls.dividers.value.filter(
    item => item.node.axis === 'vertical',
  )
  assert.equal(segments.length, 2)
  assert.ok(
    Math.abs(segments[0].y - divider.y - 40 / controls.scale.value) < 1e-6,
  )
  assert.ok(Math.abs(segments[1].y - divider.y) < 1e-6)
  assert.equal(JSON.stringify(editor.state.grid), original)
  handlers.get('pointercancel')({ type: 'pointercancel' })
  assert.equal(JSON.stringify(editor.state.grid), original)
  assert.equal(controls.draftGrid.value, null)
})

it('spacing drag updates exact local geometry without native renders until release', async (t) => {
  const { editor, api } = setup(t)
  await editor.add()
  await new Promise(resolve => setTimeout(resolve, 20))
  editor.state.layout = 'grid'
  editor.state.grid = defaultsModule.gridTemplate(
    '2x2',
    editor.state.panels.map(p => p.photoId),
  )
  await new Promise(resolve => setTimeout(resolve, 20))
  const requests = []
  const render = api.preview
  api.preview = async (snapshot) => {
    requests.push(snapshot)
    return render(snapshot)
  }
  editor.beginSpacing()
  for (const value of [3, 6, 10]) {
    editor.state.percent.gap = value
    editor.state.percent.frame = value
    await new Promise(resolve => setTimeout(resolve, 20))
    const expected = await geometry.calculateLayout(
      editor.state,
      Object.values(editor.photos),
    )
    assert.deepEqual(
      JSON.parse(JSON.stringify(editor.interactivePreview.layout)),
      JSON.parse(JSON.stringify(expected)),
    )
  }
  assert.equal(
    requests.length,
    0,
    'slider motion must not enqueue heavy native work',
  )
  editor.endSpacing()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].percent.frame, 10)
  assert.equal(editor.interactivePreview, null)
})

it('imported thumbnails appear before native preview finishes', async (t) => {
  const { editor, api } = setup(t)
  let complete
  const render = api.preview
  api.preview = snapshot =>
    new Promise((resolve) => {
      complete = async () => resolve(await render(snapshot))
    })
  await editor.add()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(editor.preview, null)
  assert.ok(editor.interactivePreview.layout.cells.length)
  assert.equal(editor.interactivePreview.gestureImages[0].dataUrl, 'data:,')
  await complete()
  await flush()
  assert.ok(editor.preview)
  assert.equal(editor.interactivePreview, null)
})

it('caption spacing keeps updating during the gesture without starving the renderer', async (t) => {
  const { editor, api } = setup(t)
  await editor.add()
  await new Promise(resolve => setTimeout(resolve, 50))
  editor.state.caption.enabled = true
  let count = 0
  const render = api.preview
  api.preview = async (snapshot) => {
    count++
    await new Promise(resolve => setTimeout(resolve, 5))
    return render(snapshot)
  }
  editor.beginSpacing()
  const initialRevision = editor.preview.revision
  for (let i = 1; i <= 12; i++) {
    editor.state.percent.frame = i
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  assert.ok(
    count >= 2,
    'leading/trailing renders run while slider keeps moving',
  )
  assert.ok(editor.preview.revision > initialRevision)
  assert.equal(
    editor.interactivePreview,
    null,
    'native caption layout must not be approximated',
  )
  editor.endSpacing()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(editor.rendering, false)
})

it('an in-flight native render cannot replace newer local spacing geometry', async (t) => {
  const { editor, api } = setup(t)
  await editor.add()
  await new Promise(resolve => setTimeout(resolve, 50))
  let complete
  const render = api.preview
  api.preview = snapshot =>
    new Promise((resolve) => {
      complete = async () => resolve(await render(snapshot))
    })
  editor.state.mat = '#000000'
  await new Promise(resolve => setTimeout(resolve, 10))
  editor.beginSpacing()
  editor.state.percent.frame = 12
  await new Promise(resolve => setTimeout(resolve, 10))
  const geometry = JSON.stringify(editor.interactivePreview.layout)
  await complete()
  await flush()
  assert.equal(JSON.stringify(editor.interactivePreview.layout), geometry)
})

it('escape clears cell selection and returns focus to the canvas', async (t) => {
  const { editor, controls } = await gridFixture(t)
  editor.selected = [controls.layout.value.cells[0].id]
  let focused = false
  controls.viewport.value = {
    focus: () => {
      focused = true
    },
  }
  controls.key({ key: 'Escape', preventDefault() {} })
  assert.equal(editor.selected.length, 0)
  assert.equal(focused, true)
  controls.viewport.value = null
})

it('background press clears selection without intercepting cell controls', async (t) => {
  const { editor, controls } = await gridFixture(t)
  const id = controls.layout.value.cells[0].id
  let focused = 0
  controls.viewport.value = { focus: () => focused++ }
  const background = { closest: () => null }
  editor.selected = [id]
  controls.panStart({
    button: 0,
    target: background,
    currentTarget: background,
  })
  assert.equal(editor.selected.length, 0)
  assert.equal(focused, 1)
  editor.selected = [id]
  controls.panStart({
    button: 0,
    target: { closest: () => ({}) },
    currentTarget: background,
  })
  assert.equal(editor.selected[0], id)
  assert.equal(focused, 1)
  controls.viewport.value = null
})

it('drop highlight survives child transitions and clears on leave or drag end', async (t) => {
  const { controls } = await gridFixture(t)
  controls.dropTarget.value = 'target'
  controls.leaveCell({
    currentTarget: { contains: () => true },
    relatedTarget: {},
  })
  assert.equal(controls.dropTarget.value, 'target')
  controls.leaveCell({
    currentTarget: { contains: () => false },
    relatedTarget: null,
  })
  assert.equal(controls.dropTarget.value, '')
  controls.dragging.value = 'source'
  controls.dropTarget.value = 'target'
  controls.endCellDrag()
  assert.equal(controls.dragging.value, '')
  assert.equal(controls.dropTarget.value, '')
})

it('caption typing publishes layered previews during continuous input and finishes with latest text', async (t) => {
  const { editor, api } = setup(t)
  await editor.add()
  await new Promise(resolve => setTimeout(resolve, 30))
  const render = api.preview
  let active = 0
  let maxActive = 0
  const published = []
  const stop = vue.watch(
    () => editor.preview,
    (value) => {
      if (value?.annotationLayers)
        published.push(value.annotationLayers[0].dataUrl)
    },
  )
  t.onTestFinished(stop)
  api.preview = async (snapshot, size, region, annotationsOnly) => {
    assert.equal(annotationsOnly, true)
    maxActive = Math.max(maxActive, ++active)
    await new Promise(resolve => setTimeout(resolve, 25))
    active--
    return {
      ...(await render(snapshot)),
      dataUrl: '',
      annotationLayers: [
        { x: 0, y: 0, width: 1, height: 1, dataUrl: snapshot.caption.title },
      ],
    }
  }
  editor.state.caption.enabled = true
  for (let i = 1; i <= 15; i++) {
    editor.state.caption.title = `Text ${i}`
    await new Promise(resolve => setTimeout(resolve, 8))
  }
  assert.ok(
    published.length >= 2,
    'typing must not starve preview publication',
  )
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.equal(published.at(-1), 'Text 15')
  assert.equal(maxActive, 1, 'preview requests must not accumulate')
  assert.equal(
    editor.interactivePreview.annotationLayers[0].dataUrl,
    'Text 15',
  )
})

it('render indicator ignores short work and appears only after the delay', async (t) => {
  const { editor, controls } = await gridFixture(t)
  editor.rendering = true
  await flush()
  assert.equal(controls.showRendering.value, false)
  await new Promise(resolve => setTimeout(resolve, 30))
  editor.rendering = false
  await flush()
  assert.equal(controls.showRendering.value, false)
  editor.rendering = true
  await new Promise(resolve => setTimeout(resolve, 330))
  assert.equal(controls.showRendering.value, true)
  editor.rendering = false
  await flush()
  assert.equal(controls.showRendering.value, false)
})

it('editor grid history and presets remain isolated across instances', async (t) => {
  const first = setup(t)
  const second = setup(t)
  vi.stubGlobal('window', first.window)
  context.notifications = first.notifications
  await first.editor.add()
  first.editor.state.layout = 'grid'
  first.editor.template('1x2')
  let saved
  first.api.presets.save = async (preset) => {
    saved = preset
  }
  first.api.presets.list = async () => [saved]
  await first.editor.savePreset('First only')
  assert.equal(first.editor.presets.length, 1)
  assert.equal(second.editor.presets.length, 0)
  first.editor.undo()
  assert.equal(first.editor.future.length, 1)
  assert.equal(second.editor.history.length, 0)
  assert.equal(second.editor.future.length, 0)
  assert.equal(second.editor.state.panels.length, 0)
  assert.equal(second.editor.activePreset, '')
  assert.equal(second.notifications.length, 0)
})

it('preview completed before decode cannot replace newer geometry after decode', async (t) => {
  const { editor, api, window } = setup(t)
  await editor.add()
  await new Promise(resolve => setTimeout(resolve, 50))
  const previous = editor.preview
  let finishDecode
  window.Image = class {
    decode() {
      return new Promise((resolve) => {
        finishDecode = resolve
      })
    }
  }
  const render = api.preview
  api.preview = async snapshot => ({
    ...(await render(snapshot)),
    dataUrl: 'data:,new',
  })
  editor.state.mat = '#000000'
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(typeof finishDecode, 'function')
  editor.beginSpacing()
  editor.state.percent.frame = 12
  await new Promise(resolve => setTimeout(resolve, 10))
  const geometry = JSON.stringify(editor.interactivePreview.layout)
  finishDecode()
  await flush()
  assert.equal(editor.preview, previous)
  assert.equal(JSON.stringify(editor.interactivePreview.layout), geometry)
})

it('viewport reacts to zoom and rejects regions superseded by pan or revision', async () => {
  const output = {
    width: 2000,
    height: 1000,
    cells: [],
    captions: [],
    warnings: [],
    nativeWidth: 2000,
    nativeHeight: 1000,
    dpi: 72,
  }
  const editor = vue.reactive({
    state: defaultsModule.defaults(),
    preview: { revision: 1, layout: output, dataUrl: 'data:,base' },
    renderRevision: 1,
    rendering: false,
    spacingEditing: false,
    interactivePreview: null,
    selected: [],
    fail: (error) => {
      throw error
    },
  })
  const pending = []
  context.editor = editor
  vi.stubGlobal('window', {
    devicePixelRatio: 1,
    poliframe: {
      preview: (snapshot, maxSize, region) =>
        new Promise((complete) => {
          pending.push({ snapshot, region, complete })
        }),
    },
  })
  const zoom = vue.ref(null)
  const scope = vue.effectScope()
  cleanups.push(() => scope.stop())
  const originalWarn = console.warn
  console.warn = () => {}
  let controls
  try {
    controls = scope.run(() =>
      usePreviewViewport({
        layout: vue.computed(() => editor.preview.layout),
        resizing: vue.ref(false),
        zoom: () => zoom.value,
        emit() {},
      }),
    )
  }
  finally {
    console.warn = originalWarn
  }
  const fitScale = controls.scale.value
  zoom.value = 100
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.ok(controls.scale.value > fitScale)
  assert.equal(pending.length, 1)
  controls.pan.value = { x: 100, y: 0 }
  pending[0].complete({
    revision: 1,
    region: pending[0].region,
    dataUrl: 'stale-pan',
    layout: output,
  })
  await flush()
  assert.equal(controls.regionPreview.value, null)
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(pending.length, 2)
  editor.renderRevision = 2
  pending[1].complete({
    revision: 1,
    region: pending[1].region,
    dataUrl: 'stale-revision',
    layout: output,
  })
  await flush()
  assert.equal(controls.regionPreview.value, null)
  editor.preview = { revision: 2, layout: output, dataUrl: 'data:,latest' }
  await new Promise(resolve => setTimeout(resolve, 200))
  pending[2].complete({
    revision: 2,
    region: pending[2].region,
    dataUrl: 'current',
    layout: output,
  })
  await flush()
  assert.equal(controls.regionPreview.value.dataUrl, 'current')
  zoom.value = null
  await flush()
  assert.equal(controls.scale.value, fitScale)
  assert.equal(controls.regionPreview.value, null)
})

it('export cancellation is silent and successful exports use Sonner', async (t) => {
  const { editor, api, notifications } = setup(t)
  await editor.add()
  api.exportImage = async () => ({ status: 'cancelled' })
  await editor.exportImage()
  assert.equal(notifications.length, 0)
  assert.equal(editor.busy, false)
  api.exportImage = async () => ({ status: 'saved', path: '/tmp/photo.jpg' })
  await editor.exportImage()
  assert.equal(notifications.at(-1).type, 'success')
  assert.equal(notifications.at(-1).options.description, '/tmp/photo.jpg')
  editor.fail(new Error('Import failed'))
  editor.fail(new Error('Render failed'))
  assert.equal(
    notifications.at(-1).options.id,
    notifications.at(-2).options.id,
  )
})

it('print badge calculates paper DPI instead of exposing stale export metadata', () => {
  const editor = vue.reactive({
    state: defaultsModule.defaults(),
    preview: {
      layout: {
        width: 3000,
        height: 2000,
        nativeWidth: 3000,
        nativeHeight: 2000,
        dpi: 72,
      },
    },
    interactivePreview: null,
  })
  editor.state.panels = [{ photoId: 'photo' }]
  editor.state.print.width = 10
  editor.state.print.height = 15
  editor.state.print.units = 'in'
  editor.state.print.orientation = 'auto'
  context.editor = editor
  const { printInfo } = PrintSettings.setup({}, { expose() {} })
  assert.equal(printInfo.value, null)
  editor.state.print.enabled = true
  assert.equal(printInfo.value.dpi, 200)
  assert.equal(printInfo.value.width, 15)
  assert.equal(printInfo.value.height, 10)
  editor.preview.layout.dpi = 240
  assert.equal(printInfo.value.dpi, 200)
  editor.state.print.width = 5
  editor.state.print.height = 10
  assert.equal(printInfo.value.dpi, 300)
  editor.interactivePreview = {
    layout: { ...editor.preview.layout, width: 4000 },
  }
  assert.equal(printInfo.value.dpi, 400)
})
