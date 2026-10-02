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
    '@/components/ui/toggle-group': {},
    '@/composables/useEditor': { useEditorContext: () => editor },
    '../../../shared/defaults': defaultsModule,
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

test('grid divider uses live geometry without mutating the render model until release', async (t) => {
  const { editor, leaves } = setup(t)
  await flush()
  editor.state.layout = 'grid'
  editor.state.grid = defaultsModule.gridTemplate('1x2')
  const geometry = evaluate(source('src/shared/layout.ts'))
  const base = await geometry.calculateLayout(editor.state, [])
  editor.preview = { revision: 0, dataUrl: 'data:,', layout: base }
  const { descriptor } = parse(
    source('src/renderer/components/editor/PreviewCanvas.vue'),
  )
  const compiled = compileScript(descriptor, { id: 'grid-drag-regression' })
  let controls
  const component = evaluate(
    compiled.content,
    {
      '@lucide/vue': {},
      '@/components/ui/button': {},
      '@/composables/useEditor': { useEditorContext: () => editor, leaves },
      '../../../shared/layout': geometry,
    },
    { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} },
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
  const handlers = new Map()
  const target = {
    setPointerCapture() {},
    addEventListener: (name, handler) => handlers.set(name, handler),
    removeEventListener: name => handlers.delete(name),
  }
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
