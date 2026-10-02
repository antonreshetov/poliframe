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
  return { editor, registry, leaves }
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
