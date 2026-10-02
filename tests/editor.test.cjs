const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')
const ts = require('typescript')
const vue = require('vue')
const { parse, compileScript } = require('vue/compiler-sfc')

const source = file => readFileSync(resolve(__dirname, '..', file), 'utf8')
function evaluate(code, imports = {}, window = {}) {
  const exports = {}
  runInNewContext(
    ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    {
      exports,
      crypto,
      console,
      window,
      setTimeout,
      clearTimeout,
      requestAnimationFrame: callback => setTimeout(callback, 0),
      cancelAnimationFrame: clearTimeout,
      require: (name) => {
        if (name === 'vue')
          return vue
        if (Object.hasOwn(imports, name))
          return imports[name]
        throw new Error(`Unexpected test import: ${name}`)
      },
    },
  )
  return exports
}
const defaultsModule = evaluate(source('src/shared/defaults.ts'))

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
function setup(t) {
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
  const { useEditor, leaves } = evaluate(
    source('src/renderer/composables/useEditor.ts'),
    {
      '../../shared/defaults': defaultsModule,
      '../../shared/layout': evaluate(source('src/shared/layout.ts')),
    },
    window,
  )
  let editor
  const app = renderer.createApp({
    setup() {
      editor = useEditor()
      return () => null
    },
  })
  app.mount({})
  t.after(() => app.unmount())
  return { editor, registry, leaves, api }
}

test('replacing more than the registry capacity reclaims originals and thumbnails', async (t) => {
  const { editor, registry } = setup(t)
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
  assert.equal(editor.error, '')
})

test('clear retains pooled images; style presets preserve empty cells; grid presets populate', async (t) => {
  const { editor, registry, leaves } = setup(t)
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
  assert.equal(editor.error, '')
})

test('Compose mode handlers ignore deselection and accept valid layout and units', () => {
  const { descriptor } = parse(
    source('src/renderer/components/editor/ComposePanel.vue'),
  )
  const compiled = compileScript(descriptor, { id: 'compose-mode-regression' })
  const editor = vue.reactive({ state: defaultsModule.defaults() })
  const component = evaluate(compiled.content, {
    '@lucide/vue': {},
    '@/components/ui/button': {},
    '@/components/ui/input': {},
    '@/components/ui/segmented-control': {},
    '@/composables/useEditor': { useEditorContext: () => editor },
    '../../../shared/defaults': defaultsModule,
    '../../../shared/layout': evaluate(source('src/shared/layout.ts')),
    './CheckField.vue': {},
    './ChoiceField.vue': {},
    './NumberField.vue': {},
  }).default
  const controls = component.setup({}, { expose() {} })
  controls.setLayout('grid')
  controls.setUnits('pixels')
  for (const invalid of ['', undefined, [], 'unknown']) {
    controls.setLayout(invalid)
    controls.setUnits(invalid)
    assert.equal(editor.state.layout, 'grid')
    assert.equal(editor.state.units, 'pixels')
  }
  editor.state.panels = [{ photoId: 'a' }, { photoId: 'b' }]
  const rows = [{ offsetTop: 0, offsetHeight: 48 }, { offsetTop: 52, offsetHeight: 48 }]
  const list = { querySelectorAll: () => rows, getBoundingClientRect: () => ({ top: 100 }) }
  controls.startPanelDrag({ currentTarget: { parentElement: list } }, 'a')
  controls.movePanelDrag({ currentTarget: list, clientY: 154 })
  assert.deepEqual(Array.from(controls.dragOrder.value), ['b', 'a'])
  rows[0].offsetTop = 52
  rows[1].offsetTop = 0
  for (const y of [154, 151, 149, 152, 154]) {
    controls.movePanelDrag({ currentTarget: list, clientY: y })
    assert.deepEqual(Array.from(controls.dragOrder.value), ['b', 'a'])
  }
  assert.deepEqual(editor.state.panels.map(panel => panel.photoId), ['a', 'b'])
  controls.movePanelDrag({ currentTarget: list, clientY: 140 })
  assert.deepEqual(Array.from(controls.dragOrder.value), ['a', 'b'])
  controls.endPanelDrag()
  controls.setLayout('vertical')
  controls.setUnits('percent')
  assert.equal(editor.state.layout, 'vertical')
  assert.equal(editor.state.units, 'percent')
})

test('preset changes made during an asynchronous update remain marked unsaved', async (t) => {
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
  const { editor, leaves } = setup(t)
  await flush()
  editor.state.layout = 'grid'
  editor.state.grid = defaultsModule.gridTemplate(template)
  const geometry = evaluate(source('src/shared/layout.ts'))
  const base = await geometry.calculateLayout(editor.state, [])
  editor.preview = { revision: 0, dataUrl: 'data:,', layout: base }
  const { descriptor } = parse(
    source('src/renderer/components/editor/PreviewCanvas.vue'),
  )
  const compiled = compileScript(descriptor, { id: 'grid-drag-regression' })
  let controls
  const handlers = new Map()
  const component = evaluate(
    compiled.content,
    {
      '@lucide/vue': {},
      '@/components/ui/button': {},
      '@/composables/useEditor': { useEditorContext: () => editor, leaves },
      '../../../shared/layout': geometry,
    },
    { devicePixelRatio: 1, addEventListener: (name, handler) => handlers.set(name, handler), removeEventListener: name => handlers.delete(name) },
  ).default
  // Run setup inside a component scope, but leave browser-only mount hooks uncalled.
  const scope = vue.effectScope()
  t.after(() => scope.stop())
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

test('grid divider uses live geometry without mutating the render model until release', async (t) => {
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

test('Option divider snaps with hysteresis, reports percentages and preserves the other segment', async (t) => {
  const { controls, handlers, target } = await gridFixture(t, '2x2')
  const divider = controls.dividers.value.find(item => item.node.axis === 'horizontal')
  const other = controls.dividers.value.find(item => item.node.axis === 'horizontal' && item.node.id !== divider.node.id)
  const originalOther = JSON.stringify(other.node.weights)
  controls.hoverDivider({ altKey: false }, divider)
  assert.ok(controls.dividerFeedback.value.hi - controls.dividerFeedback.value.lo > divider.height)
  controls.resize({ preventDefault() {}, stopPropagation() {}, currentTarget: target, pointerId: 1, clientX: 100, clientY: 100, altKey: true }, divider)
  async function move(delta, metaKey = false) {
    handlers.get('pointermove')({ clientX: 100 + delta, clientY: 100, metaKey })
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await move(4)
  assert.equal(controls.dividerFeedback.value.percent, 50)
  assert.equal(controls.dividerFeedback.value.snapped, true)
  assert.ok(Math.abs(controls.dividerFeedback.value.position - divider.x) < 1e-6)
  await move(8)
  assert.equal(controls.dividerFeedback.value.snapped, true)
  await move(14)
  assert.equal(controls.dividerFeedback.value.snapped, false)
  await move(4, true)
  assert.equal(controls.dividerFeedback.value.snapped, false)
  assert.ok(Math.abs(controls.dividerFeedback.value.position - divider.x - 4 / controls.scale.value) < 1e-6)
  assert.equal(JSON.stringify(other.node.weights), originalOther)
  handlers.get('pointerup')({ type: 'pointerup' })
  assert.equal(controls.dividerFeedback.value, null)
})

test('Option on a through divider splits the hovered segment and cancellation restores the tree', async (t) => {
  const { editor, controls, handlers, target } = await gridFixture(t, '2x2')
  const original = JSON.stringify(editor.state.grid)
  const divider = controls.dividers.value.find(item => item.node.axis === 'vertical')
  const event = { preventDefault() {}, stopPropagation() {}, currentTarget: target, pointerId: 1, clientX: (divider.x + divider.width / 4) * controls.scale.value, clientY: divider.y * controls.scale.value, altKey: true }
  controls.hoverDivider(event, divider)
  assert.ok(controls.dividerFeedback.value.hi - controls.dividerFeedback.value.lo < divider.width)
  controls.resize(event, divider)
  handlers.get('pointermove')({ clientX: event.clientX, clientY: event.clientY + 40, metaKey: true })
  await new Promise(resolve => setTimeout(resolve, 10))
  const segments = controls.dividers.value.filter(item => item.node.axis === 'vertical')
  assert.equal(segments.length, 2)
  assert.ok(Math.abs(segments[0].y - divider.y - 40 / controls.scale.value) < 1e-6)
  assert.ok(Math.abs(segments[1].y - divider.y) < 1e-6)
  assert.equal(JSON.stringify(editor.state.grid), original)
  handlers.get('pointercancel')({ type: 'pointercancel' })
  assert.equal(JSON.stringify(editor.state.grid), original)
  assert.equal(controls.draftGrid.value, null)
})

test('spacing drag updates exact local geometry without native renders until release', async (t) => {
  const { editor, api } = setup(t)
  await editor.add()
  await new Promise(resolve => setTimeout(resolve, 20))
  editor.state.layout = 'grid'
  editor.state.grid = defaultsModule.gridTemplate('2x2', editor.state.panels.map(p => p.photoId))
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
    const expected = await evaluate(source('src/shared/layout.ts')).calculateLayout(editor.state, Object.values(editor.photos))
    assert.deepEqual(JSON.parse(JSON.stringify(editor.interactivePreview.layout)), JSON.parse(JSON.stringify(expected)))
  }
  assert.equal(requests.length, 0, 'slider motion must not enqueue heavy native work')
  editor.endSpacing()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].percent.frame, 10)
  assert.equal(editor.interactivePreview, null)
})

test('imported thumbnails appear before native preview finishes', async (t) => {
  const { editor, api } = setup(t)
  let complete
  const render = api.preview
  api.preview = snapshot => new Promise((resolve) => {
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

test('caption spacing keeps updating during the gesture without starving the renderer', async (t) => {
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
  assert.ok(count >= 2, 'leading/trailing renders run while slider keeps moving')
  assert.ok(editor.preview.revision > initialRevision)
  assert.equal(editor.interactivePreview, null, 'native caption layout must not be approximated')
  editor.endSpacing()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(editor.rendering, false)
})

test('an in-flight native render cannot replace newer local spacing geometry', async (t) => {
  const { editor, api } = setup(t)
  await editor.add()
  await new Promise(resolve => setTimeout(resolve, 50))
  let complete
  const render = api.preview
  api.preview = snapshot => new Promise((resolve) => {
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

test('Escape clears cell selection and returns focus to the canvas', async (t) => {
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

test('background press clears selection without intercepting cell controls', async (t) => {
  const { editor, controls } = await gridFixture(t)
  const id = controls.layout.value.cells[0].id
  let focused = 0
  controls.viewport.value = { focus: () => focused++ }
  const background = { closest: () => null }
  editor.selected = [id]
  controls.panStart({ button: 0, target: background, currentTarget: background })
  assert.equal(editor.selected.length, 0)
  assert.equal(focused, 1)
  editor.selected = [id]
  controls.panStart({ button: 0, target: { closest: () => ({}) }, currentTarget: background })
  assert.equal(editor.selected[0], id)
  assert.equal(focused, 1)
  controls.viewport.value = null
})

test('drop highlight survives child transitions and clears on leave or drag end', async (t) => {
  const { controls } = await gridFixture(t)
  controls.dropTarget.value = 'target'
  controls.leaveCell({ currentTarget: { contains: () => true }, relatedTarget: {} })
  assert.equal(controls.dropTarget.value, 'target')
  controls.leaveCell({ currentTarget: { contains: () => false }, relatedTarget: null })
  assert.equal(controls.dropTarget.value, '')
  controls.dragging.value = 'source'
  controls.dropTarget.value = 'target'
  controls.endCellDrag()
  assert.equal(controls.dragging.value, '')
  assert.equal(controls.dropTarget.value, '')
})

test('caption typing publishes layered previews during continuous input and finishes with latest text', async (t) => {
  const { editor, api } = setup(t)
  await editor.add()
  await new Promise(resolve => setTimeout(resolve, 30))
  const render = api.preview
  let active = 0
  let maxActive = 0
  const published = []
  const stop = vue.watch(() => editor.preview, (value) => {
    if (value?.annotationLayers)
      published.push(value.annotationLayers[0].dataUrl)
  })
  t.after(stop)
  api.preview = async (snapshot, size, region, annotationsOnly) => {
    assert.equal(annotationsOnly, true)
    maxActive = Math.max(maxActive, ++active)
    await new Promise(resolve => setTimeout(resolve, 25))
    active--
    return { ...await render(snapshot), dataUrl: '', annotationLayers: [{ x: 0, y: 0, width: 1, height: 1, dataUrl: snapshot.caption.title }] }
  }
  editor.state.caption.enabled = true
  for (let i = 1; i <= 15; i++) {
    editor.state.caption.title = `Text ${i}`
    await new Promise(resolve => setTimeout(resolve, 8))
  }
  assert.ok(published.length >= 2, 'typing must not starve preview publication')
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.equal(published.at(-1), 'Text 15')
  assert.equal(maxActive, 1, 'preview requests must not accumulate')
  assert.equal(editor.interactivePreview.annotationLayers[0].dataUrl, 'Text 15')
})

test('render indicator ignores short work and appears only after the delay', async (t) => {
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
