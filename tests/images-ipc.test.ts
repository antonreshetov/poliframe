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
  let window
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
  vi.doMock('electron', () => ({ dialog }))
  vi.doMock('node:fs/promises', () => ({
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
