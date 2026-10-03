const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')

const build = process.env.POLIFRAME_TEST_BUILD || resolve('build')

test('notification bridge delivers queued and live messages and releases its listener', async () => {
  const ipc = new EventEmitter()
  let ready
  ipc.invoke = () => new Promise((resolve) => {
    ready = resolve
  })
  let api
  runInNewContext(readFileSync(resolve(build, 'main/preload.js'), 'utf8'), {
    exports: {},
    console,
    require: () => ({
      ipcRenderer: ipc,
      webUtils: {},
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value } },
    }),
  })
  const messages = []
  const stop = api.onNotification(message => messages.push(message))
  const queued = { id: 'app-update', type: 'info', message: 'Queued' }
  ready([queued])
  await Promise.resolve()
  assert.equal(messages[0], queued)
  const live = { ...queued, message: 'Live' }
  ipc.emit('app:notification', { sender: 'must not be exposed' }, live)
  assert.equal(messages[1], live)
  stop()
  assert.equal(ipc.listenerCount('app:notification'), 0)
  const stopEarly = api.onNotification(message => messages.push(message))
  stopEarly()
  ready([queued])
  await Promise.resolve()
  assert.equal(messages.length, 2)
})
