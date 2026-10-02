import type { AppApi } from '../shared/contracts'
import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api: AppApi = {
  importImages: paths => ipcRenderer.invoke('images:import', paths),
  importLogo: () => ipcRenderer.invoke('images:logo'),
  releaseImages: ids => ipcRenderer.invoke('images:release', ids),
  preview: (snapshot, maxSize, region, annotationsOnly) =>
    ipcRenderer.invoke(
      'images:preview',
      snapshot,
      maxSize,
      region,
      annotationsOnly,
    ),
  exportImage: snapshot => ipcRenderer.invoke('images:export', snapshot),
  cancelExport: () => ipcRenderer.invoke('images:cancel'),
  presets: {
    list: () => ipcRenderer.invoke('presets:list'),
    save: preset => ipcRenderer.invoke('presets:save', preset),
    remove: id => ipcRenderer.invoke('presets:remove', id),
  },
  info: () => ipcRenderer.invoke('app:info'),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  droppedFilePath: file => webUtils.getPathForFile(file),
}
contextBridge.exposeInMainWorld('poliframe', api)
