import type { IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  shell,
} from 'electron'
import { registerImageHandlers } from './ipc/images'
import { AssetRegistry } from './services/assets'
import { PresetStore } from './services/presets'
import { RenderJobs } from './services/render-jobs'
import { createStore } from './store'
import { checkForUpdates, initializeUpdates } from './updates'

const isDev = process.env.NODE_ENV === 'development'
app.setName('Poliframe')
// Keep the Electron edition separate from the native application's user data.
app.setPath(
  'userData',
  path.join(app.getPath('appData'), 'Poliframe Electron'),
)
let store: Awaited<ReturnType<typeof createStore>>
let mainWindow: BrowserWindow
let isQuitting = false
let cleaned = false
const assets = new AssetRegistry()
const jobs = new RenderJobs()
const presets = new PresetStore(
  path.join(app.getPath('userData'), 'Presets'),
  assets,
)
const resources = app.isPackaged
  ? path.join(process.resourcesPath, 'resources')
  : path.join(__dirname, '../../resources')
const rendererFile = path.join(__dirname, '../renderer/index.html')

function allowed(event: IpcMainInvokeEvent) {
  if (
    event.sender !== mainWindow?.webContents
    || event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('Untrusted application frame')
  }
  const url = event.senderFrame.url
  if (
    isDev
      ? new URL(url).origin !== 'http://127.0.0.1:5173'
      : !url.startsWith('file://') || fileURLToPath(url) !== rendererFile
  ) {
    throw new Error('Untrusted application origin')
  }
}
function handle(channel: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    allowed(event)
    return fn(...args)
  })
}
const { invalidateExports } = registerImageHandlers(handle, {
  getWindow: () => mainWindow,
  assets,
  jobs,
  resources,
})
handle('presets:list', () => presets.list())
handle('presets:save', preset => presets.save(preset))
handle('presets:remove', id => presets.remove(id))
handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
}))
handle('updates:check', () => checkForUpdates(true))

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 830,
    ...store.app.get('bounds'),
    minWidth: 860,
    minHeight: 560,
    title: 'Poliframe',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#171717',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  if (isDev) {
    mainWindow.webContents.on('devtools-opened', () =>
      store.app.set('devToolsOpen', true))
    mainWindow.webContents.on('devtools-closed', () => {
      if (!isQuitting)
        store.app.set('devToolsOpen', false)
    })
    void mainWindow.loadURL('http://127.0.0.1:5173')
    if (store.app.get('devToolsOpen'))
      mainWindow.webContents.openDevTools()
  }
  else {
    void mainWindow.loadFile(rendererFile)
  }
  mainWindow.on('close', (event) => {
    store.app.set('bounds', mainWindow.getBounds())
    if (!isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
}

app.whenReady().then(async () => {
  store = await createStore()
  app.setAboutPanelOptions({
    applicationName: 'Poliframe',
    applicationVersion: app.getVersion(),
    copyright: '© Anton Reshetov',
    iconPath: path.join(resources, 'icon.png'),
  })
  if (isDev && app.dock) {
    app.dock.setIcon(
      nativeImage.createFromPath(
        path.join(__dirname, '../../build/icons/icon-mac.png'),
      ),
    )
  }
  createWindow()
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Poliframe',
        submenu: [
          { role: 'about' },
          {
            label: 'Check for Updates…',
            click: () => {
              void checkForUpdates(true)
            },
          },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          {
            label: 'Poliframe Website',
            click: () => {
              void shell.openExternal('https://antonreshetov.com/poliframe')
            },
          },
        ],
      },
    ]),
  )
  initializeUpdates(() => {
    isQuitting = true
  })
})
app.on('activate', () => mainWindow?.show())
app.on('before-quit', (event) => {
  isQuitting = true
  if (cleaned)
    return
  event.preventDefault()
  cleaned = true
  invalidateExports()
  void Promise.allSettled([
    jobs.close(),
    assets.metadata.close(),
    presets.close(),
  ]).then(() => app.quit())
})
