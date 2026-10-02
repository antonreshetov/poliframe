const assert = require('node:assert/strict')
const { test } = require('node:test')
const { validateComposition } = require('../build/main/services/validation.js')
const { defaults, identityTransform } = require('../build/shared/defaults.js')

test('default composition is a valid IPC snapshot', () =>
  validateComposition(defaults()))
test('rejects invalid file references, cycles, duplicate cells and huge trees', () => {
  let state = defaults()
  state.caption.sourceId = '/etc/passwd'
  assert.throws(() => validateComposition(state), /source/)
  state = defaults()
  state.grid.children.push(state.grid)
  assert.throws(() => validateComposition(state))
  state = defaults()
  state.grid.children[1].id = state.grid.children[0].id
  assert.throws(() => validateComposition(state), /Duplicate/)
})
test('crop must remain inside normalized image bounds', () => {
  const state = defaults()
  state.panels = [{ photoId: 'photo', transform: identityTransform() }]
  validateComposition(state)
  state.panels[0].transform.crop.x = 0.1
  assert.throws(() => validateComposition(state), /outside/)
})
test('rejects NaN, excessive caption strings and unsupported export options', () => {
  const state = defaults()
  state.print.width = NaN
  assert.throws(() => validateComposition(state), /numeric/)
  state.print.width = 30
  state.caption.title = 'a'.repeat(4097)
  assert.throws(() => validateComposition(state), /text/)
  state.caption.title = ''
  state.output.format = 'pdf'
  assert.throws(() => validateComposition(state), /option/)
})
