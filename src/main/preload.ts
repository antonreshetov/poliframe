import type { AppApi, AppNotification } from '../shared/contracts'
import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api: AppApi = {
  supporter: {
    onShowLicense: (callback) => {
      const listener = () => callback()
      ipcRenderer.on('supporter:show-license', listener)
      return () =>
        ipcRenderer.removeListener('supporter:show-license', listener)
    },
    status: () => ipcRenderer.invoke('supporter:status'),
    activate: key => ipcRenderer.invoke('supporter:activate', key),
    open: destination => ipcRenderer.invoke('supporter:open', destination),
  },
  importImages: paths => ipcRenderer.invoke('images:import', paths),
  importLogo: () => ipcRenderer.invoke('images:logo'),
  releaseImages: ids => ipcRenderer.invoke('images:release', ids),
  preview: (
    snapshot,
    maxSize,
    region,
    annotationsOnly,
    knownGestureImagesKey,
    knownDetailKeys,
  ) =>
    ipcRenderer.invoke(
      'images:preview',
      snapshot,
      maxSize,
      region,
      annotationsOnly,
      knownGestureImagesKey,
      knownDetailKeys,
    ),
  exportImage: async (snapshot, onStarted) => {
    const started = () => onStarted?.()
    ipcRenderer.on('images:export-started', started)
    try {
      return await ipcRenderer.invoke('images:export', snapshot)
    }
    finally {
      ipcRenderer.removeListener('images:export-started', started)
    }
  },
  revealFile: path => ipcRenderer.invoke('images:reveal', path),
  cancelExport: () => ipcRenderer.invoke('images:cancel'),
  presets: {
    list: () => ipcRenderer.invoke('presets:list'),
    save: preset => ipcRenderer.invoke('presets:save', preset),
    remove: id => ipcRenderer.invoke('presets:remove', id),
  },
  info: () => ipcRenderer.invoke('app:info'),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onNotification: (callback) => {
    let active = true
    const listener = (
      _event: Electron.IpcRendererEvent,
      notification: AppNotification,
    ) => callback(notification)
    ipcRenderer.on('app:notification', listener)
    void ipcRenderer
      .invoke('notifications:ready')
      .then((pending: AppNotification[]) => {
        if (active)
          pending.forEach(callback)
      })
      .catch(console.error)
    return () => {
      active = false
      ipcRenderer.removeListener('app:notification', listener)
    }
  },
  droppedFilePath: file => webUtils.getPathForFile(file),
}
contextBridge.exposeInMainWorld('poliframe', api)
