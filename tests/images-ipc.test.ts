import assert from 'node:assert/strict'
import { it, vi } from 'vitest'

import { defaults, identityTransform } from '../src/shared/defaults.ts'

const flush = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let complete
  const promise = new Promise((resolve) => {
    complete = resolve
  })
  return { promise, complete }
}
async function setup() {
  const handlers = new Map()
  const calls = []
  let window = {
    webContents: { send: (...args) => calls.push(['event', ...args]) },
  }
  const photo = { id: 'photo', name: 'Original.jpg', path: '/original.jpg' }
  const assets = {
    all: ids => ids.map(() => photo),
    import: async () => photo,
    release: ids => calls.push(['release', ids]),
    metadata: { copySafeTags: async () => calls.push(['metadata']) },
  }
  const jobs = {
    request: async (kind, request) => {
      calls.push([kind, request])
      return {}
    },
    cancelExport: async () => calls.push(['cancel']),
  }
  const dialog = {
    showOpenDialog: async (owner) => {
      calls.push(['open', owner])
      return { filePaths: ['/original.jpg'] }
    },
    showSaveDialog: async (owner) => {
      calls.push(['save', owner])
      return { filePath: '/result.jpg' }
    },
  }
  vi.resetModules()
  vi.doMock('electron', () => ({
    dialog,
    shell: { showItemInFolder: file => calls.push(['reveal', file]) },
  }))
  vi.doMock('node:fs/promises', () => ({
    access: async () => {},
    realpath: async file => file,
    mkdir: async () => calls.push(['mkdir']),
    rename: async () => calls.push(['rename']),
    rm: async () => calls.push(['rm']),
  }))
  const exports = await import('../src/main/ipc/images.ts')
  const lifecycle = exports.registerImageHandlers(
    (name, handler) => handlers.set(name, handler),
    { getWindow: () => window, assets, jobs, resources: '/resources' },
  )
  const snapshot = defaults()
  snapshot.panels = [{ photoId: 'photo', transform: identityTransform() }]
  return {
    handlers,
    calls,
    assets,
    jobs,
    dialog,
    snapshot,
    lifecycle,
    setWindow(value) {
      window = value
    },
  }
}

it('image handlers resolve the current window and retain preview validation', async () => {
  const { handlers, calls, setWindow, snapshot } = await setup()
  const window = {}
  setWindow(window)
  await handlers.get('images:import')()
  assert.equal(calls[0][1], window)
  assert.throws(
    () => handlers.get('images:preview')(snapshot, Infinity),
    /Invalid preview size/,
  )
  await handlers.get('images:preview')(snapshot, 9999, undefined, true)
  const request = calls.find(([kind]) => kind === 'preview')[1]
  assert.equal(request.maxSize, 3200)
  assert.equal(request.annotationsOnly, true)
  assert.equal(request.resources, '/resources')
})

it('cancel during the save dialog invalidates export before starting work', async () => {
  const { handlers, calls, dialog, snapshot } = await setup()
  const pending = deferred()
  dialog.showSaveDialog = () => pending.promise
  const exporting = handlers.get('images:export')(snapshot)
  await handlers.get('images:cancel')()
  pending.complete({ filePath: '/result.jpg' })
  assert.equal((await exporting).status, 'cancelled')
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['cancel'],
  )
})

it('cancel during native export prevents publish and cleans the temporary output', async () => {
  const { handlers, calls, jobs, snapshot } = await setup()
  const pending = deferred()
  jobs.request = () => pending.promise
  const exporting = handlers.get('images:export')(snapshot)
  await flush()
  await handlers.get('images:cancel')()
  pending.complete()
  assert.equal((await exporting).status, 'cancelled')
  assert.equal(
    calls.some(([kind]) => kind === 'rename'),
    false,
  )
  assert.equal(calls.at(-1)[0], 'rm')
})

it('shutdown invalidation during metadata copy prevents publish without cancelling jobs itself', async () => {
  const { handlers, calls, assets, snapshot, lifecycle } = await setup()
  snapshot.output.metadataId = 'photo'
  const pending = deferred()
  assets.metadata.copySafeTags = () => pending.promise
  const exporting = handlers.get('images:export')(snapshot)
  await flush()
  lifecycle.invalidateExports()
  pending.complete()
  assert.equal((await exporting).status, 'cancelled')
  assert.equal(
    calls.some(([kind]) => kind === 'rename' || kind === 'cancel'),
    false,
  )
  assert.equal(calls.at(-1)[0], 'rm')
})

it('preview validates acknowledgment keys and keeps regions independent', async () => {
  const { handlers, calls, snapshot } = await setup()
  const preview = handlers.get('images:preview')
  for (const key of [null, 42, '', 'x'.repeat(64), 'a'.repeat(65)]) {
    assert.throws(
      () => preview(snapshot, 1200, undefined, false, key),
      /Invalid gesture images key/,
    )
  }
  const key = 'a'.repeat(64)
  await preview(snapshot, 1200, undefined, false, key)
  assert.equal(calls.at(-1)[1].knownGestureImagesKey, key)
  await preview(
    snapshot,
    1200,
    { x: 0, y: 0, width: 10, height: 10 },
    false,
    key,
  )
  assert.equal(calls.at(-1)[1].knownGestureImagesKey, undefined)
})

it('validates bounded detail acknowledgments and forwards them only for regions', async () => {
  const { handlers, calls, snapshot } = await setup()
  const preview = handlers.get('images:preview')
  const region = { x: 0, y: 0, width: 10, height: 10 }
  for (const keys of [
    null,
    42,
    {},
    [''],
    [42],
    ['x'.repeat(513)],
    Array.from({ length: 513 }).fill('key'),
  ]) {
    assert.throws(
      () => preview(snapshot, 1200, region, false, undefined, keys),
      /Invalid detail tile keys/,
    )
  }
  await preview(snapshot, 1200, region, false, undefined, ['tile-key'])
  assert.deepEqual(calls.at(-1)[1].knownDetailKeys, ['tile-key'])
  await preview(snapshot, 1200, undefined, false, undefined, ['tile-key'])
  assert.equal(calls.at(-1)[1].knownDetailKeys, undefined)
})

it('announces export only after the save dialog is confirmed', async () => {
  const { handlers, calls, dialog, snapshot } = await setup()
  const pending = deferred()
  dialog.showSaveDialog = () => pending.promise
  const exporting = handlers.get('images:export')(snapshot)
  await flush()
  assert.equal(
    calls.some(([kind]) => kind === 'event'),
    false,
  )
  pending.complete({ filePath: '/result.jpg' })
  await exporting
  const start = calls.findIndex(([kind]) => kind === 'event')
  assert.deepEqual(calls[start], ['event', 'images:export-started'])
  assert.ok(start < calls.findIndex(([kind]) => kind === 'export'))
})

it('reveals an absolute exported file path through the system file manager', async () => {
  const { handlers, calls } = await setup()
  await handlers.get('images:reveal')('/result.jpg')
  assert.deepEqual(calls.at(-1), ['reveal', '/result.jpg'])
  await assert.rejects(
    handlers.get('images:reveal')('relative.jpg'),
    /Invalid file path/,
  )
})
