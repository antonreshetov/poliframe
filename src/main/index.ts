import type { IpcMainInvokeEvent } from 'electron'
import type { Composition, PreviewResult } from '../shared/contracts'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
} from 'electron'
import { AssetRegistry } from './services/assets'
import { PresetStore } from './services/presets'
import { RenderJobs } from './services/render-jobs'
import { validateComposition } from './services/validation'
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
let exporting = false
let exportGeneration = 0
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
function snapshotAssets(snapshot: Composition) {
  return assets.all([
    ...snapshot.panels.map(p => p.photoId),
    ...(snapshot.watermark.photoId ? [snapshot.watermark.photoId] : []),
  ])
}
const filters = [
  {
    name: 'Images',
    extensions: ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'webp', 'avif'],
  },
]
async function chooseImages(paths?: unknown) {
  let files: string[]
  if (paths === undefined) {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters,
    })
    files = result.canceled ? [] : result.filePaths
  }
  else {
    if (
      !Array.isArray(paths)
      || paths.length > 128
      || paths.some(p => typeof p !== 'string')
    ) {
      throw new Error('Invalid dropped files')
    }
    files = paths
  }
  const results: {
    photo?: Awaited<ReturnType<AssetRegistry['import']>>
    error?: string
  }[] = []
  let next = 0
  const importNext = async () => {
    while (next < files.length) {
      const index = next++
      const file = files[index]!
      try {
        results[index] = { photo: await assets.import(file) }
      }
      catch (error) {
        results[index] = {
          error: `${path.basename(file)}: ${error instanceof Error ? error.message : 'Cannot load image'}`,
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(2, files.length) }, importNext),
  )
  const photos = results.flatMap(result =>
    result.photo ? [result.photo] : [],
  )
  const errors = results.flatMap(result =>
    result.error ? [result.error] : [],
  )
  return { photos, errors }
}

handle('images:import', chooseImages)
handle('images:logo', async () => {
  const result = await chooseImages()
  if (result.errors.length)
    throw new Error(result.errors.join('\n'))
  return result.photos[0] ?? null
})
handle('images:release', (ids: unknown) => {
  if (
    !Array.isArray(ids)
    || ids.length > 160
    || ids.some(id => typeof id !== 'string')
  ) {
    throw new Error('Invalid image IDs')
  }
  assets.release(ids)
})
handle(
  'images:preview',
  (
    snapshot: unknown,
    maxSize: unknown,
    region?: unknown,
    annotationsOnly?: unknown,
  ) => {
    if (annotationsOnly !== undefined && typeof annotationsOnly !== 'boolean')
      throw new Error('Invalid annotation preview mode')
    validateComposition(snapshot)
    if (
      region !== undefined
      && (!region
        || typeof region !== 'object'
        || !['x', 'y', 'width', 'height'].every((key) => {
          const n = (region as Record<string, unknown>)[key]
          return (
            typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 32768
          )
        })
        || (region as { width: number }).width < 1
        || (region as { height: number }).height < 1)
    ) {
      throw new Error('Invalid preview region')
    }
    if (typeof maxSize !== 'number' || !Number.isFinite(maxSize))
      throw new Error('Invalid preview size')
    return jobs.request<PreviewResult>('preview', {
      snapshot,
      assets: snapshotAssets(snapshot),
      resources,
      region,
      maxSize: Math.round(Math.max(400, Math.min(3200, maxSize))),
      annotationsOnly: annotationsOnly === true && !region,
    })
  },
)
handle('images:cancel', async () => {
  exportGeneration++
  await jobs.cancelExport()
})
handle('images:export', async (value: unknown) => {
  validateComposition(value)
  if (!value.panels.length)
    throw new Error('Add an image before exporting')
  if (exporting)
    throw new Error('An export is already running')
  const snapshot = structuredClone(value)
  const sourceAssets = snapshotAssets(snapshot)
  exporting = true
  const generation = ++exportGeneration
  let tempDirectory: string | undefined
  try {
    const ext
      = snapshot.output.format === 'jpeg'
        ? 'jpg'
        : snapshot.output.format === 'tiff'
          ? 'tiff'
          : 'png'
    const names = sourceAssets
      .filter(a => snapshot.panels.some(p => p.photoId === a.id))
      .map(a => path.parse(a.name).name)
      .join('-')
      .slice(0, 180)
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `${names || 'Poliframe'}.${ext}`,
      filters: [
        { name: snapshot.output.format.toUpperCase(), extensions: [ext] },
      ],
    })
    if (result.canceled || !result.filePath || generation !== exportGeneration)
      return { status: 'cancelled' }
    const destination = result.filePath
    const canonicalDestination = await realpath(destination).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT')
          throw error
        return path.resolve(destination)
      },
    )
    const canonicalSources = await Promise.all(
      sourceAssets.map(a => realpath(a.path)),
    )
    if (canonicalSources.includes(canonicalDestination)) {
      throw new Error(
        'Choose a different file name to preserve the original image',
      )
    }
    tempDirectory = path.join(
      path.dirname(destination),
      `.poliframe-${randomUUID()}`,
    )
    await mkdir(tempDirectory)
    const temporary = path.join(tempDirectory, `output.${ext}`)
    await jobs.request('export', {
      snapshot,
      assets: sourceAssets,
      resources,
      destination: temporary,
    })
    if (generation !== exportGeneration)
      return { status: 'cancelled' }
    if (snapshot.output.metadataId) {
      await assets.metadata.copySafeTags(
        sourceAssets.find(asset => asset.id === snapshot.output.metadataId)!
          .path,
        temporary,
      )
    }
    if (generation !== exportGeneration)
      return { status: 'cancelled' }
    await rename(temporary, destination)
    return { status: 'saved', path: destination }
  }
  catch (error) {
    if (generation !== exportGeneration)
      return { status: 'cancelled' }
    throw error
  }
  finally {
    exporting = false
    if (tempDirectory)
      await rm(tempDirectory, { recursive: true, force: true })
  }
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
        path.join(__dirname, '../../build/icons/icon.png'),
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
      { role: 'viewMenu' },
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
  exportGeneration++
  void Promise.allSettled([
    jobs.close(),
    assets.metadata.close(),
    presets.close(),
  ]).then(() => app.quit())
})
