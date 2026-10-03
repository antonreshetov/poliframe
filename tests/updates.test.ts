import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { afterEach, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function setup(packaged = true) {
  const app = Object.assign(new EventEmitter(), { isPackaged: packaged })
  const updater = new EventEmitter()
  const messages = []
  const order = []
  let checks = 0
  let downloads = 0
  let timerCallback
  let interval
  let cleared = false
  updater.checkForUpdates = async () => {
    checks++
    return { isUpdateAvailable: false }
  }
  updater.downloadUpdate = async () => {
    downloads++
  }
  updater.quitAndInstall = () => order.push('install')
  vi.resetModules()
  vi.doMock('electron', () => ({ app }))
  vi.doMock('electron-updater', () => ({ autoUpdater: updater }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('setInterval', (fn, ms) => {
    timerCallback = fn
    interval = ms
    return { unref() {} }
  })
  vi.stubGlobal('clearInterval', () => {
    cleared = true
  })
  const exports = await import('../src/main/updates/index.ts')
  return {
    app,
    updater,
    messages,
    order,
    api: exports,
    initialize: () =>
      exports.initializeUpdates(
        () => order.push('prepare'),
        notification => messages.push(notification),
      ),
    tick: () => timerCallback(),
    get checks() {
      return checks
    },
    get downloads() {
      return downloads
    },
    get interval() {
      return interval
    },
    get cleared() {
      return cleared
    },
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

it('development never contacts the update service', async () => {
  const s = await setup(false)
  s.initialize()
  await s.api.checkForUpdates(true)
  assert.equal(s.checks, 0)
  assert.match(s.messages[0].message, /installed builds/)
})

it('checks at startup and every three hours, installs listeners once, cleans timer', async () => {
  const s = await setup()
  s.initialize()
  s.initialize()
  await flush()
  assert.equal(s.checks, 1)
  assert.equal(s.updater.listenerCount('update-available'), 1)
  assert.equal(s.interval, 3 * 60 * 60 * 1000)
  s.tick()
  await flush()
  assert.equal(s.checks, 2)
  s.app.emit('will-quit')
  assert.equal(s.cleared, true)
})

it('downloads once and prepares window lifecycle before installing', async () => {
  const s = await setup()
  s.initialize()
  await flush()
  s.updater.emit('update-available', { version: '2.3.8' })
  s.updater.emit('update-available', { version: '2.3.8' })
  assert.equal(s.downloads, 1)
  s.updater.emit('update-downloaded', { version: '2.3.8' })
  await flush()
  assert.deepEqual(s.order, [])
  assert.equal(s.messages.at(-1).action, 'install-update')
  s.api.installUpdate()
  assert.deepEqual(s.order, ['prepare', 'install'])
  assert.equal(s.updater.autoInstallOnAppQuit, true)
})

it('manual network failures show an error instead of claiming no updates', async () => {
  const s = await setup()
  s.initialize()
  await flush()
  s.updater.checkForUpdates = async () => {
    throw new Error('offline')
  }
  await s.api.checkForUpdates(true)
  assert.equal(s.messages.at(-1).type, 'error')
})

it('download failure permits a retry on the next check', async () => {
  const s = await setup()
  s.initialize()
  await flush()
  let attempts = 0
  s.updater.downloadUpdate = async () => {
    attempts++
    throw new Error('offline')
  }
  s.updater.emit('update-available')
  await flush()
  s.updater.emit('update-available')
  await flush()
  assert.equal(attempts, 2)
})

it('install action does nothing before an update is downloaded', async () => {
  const s = await setup()
  s.initialize()
  s.api.installUpdate()
  assert.deepEqual(s.order, [])
})
