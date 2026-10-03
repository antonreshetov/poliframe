import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { it, vi } from 'vitest'

it('notification bridge delivers queued and live messages and releases its listener', async () => {
  const ipc = new EventEmitter()
  let ready
  ipc.invoke = () =>
    new Promise((resolve) => {
      ready = resolve
    })
  let api
  vi.resetModules()
  vi.doMock('electron', () => ({
    ipcRenderer: ipc,
    webUtils: {},
    contextBridge: {
      exposeInMainWorld: (_name, value) => {
        api = value
      },
    },
  }))
  await import('../src/main/preload.ts')
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
