import type { AppNotification } from '../../shared/contracts'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

const CHECK_INTERVAL = 3 * 60 * 60 * 1000
let initialized = false
let checking: Promise<void> | undefined
let downloading = false
let downloadedVersion: string | undefined
let prepareToQuit: () => void

let notify: (notification: AppNotification) => void

function offerInstallation() {
  notify({
    id: 'app-update',
    type: 'success',
    message: `Version ${downloadedVersion} is ready to install.`,
    description:
      'Restart now, or install the update when you quit the application.',
    action: 'install-update',
  })
}

export function installUpdate() {
  if (!downloadedVersion)
    return
  prepareToQuit()
  autoUpdater.quitAndInstall()
}

export async function checkForUpdates(manual = false): Promise<void> {
  if (!app.isPackaged) {
    if (manual) {
      notify({
        id: 'app-update',
        type: 'info',
        message: 'Updates are available in installed builds only.',
      })
    }
    return
  }
  if (downloadedVersion) {
    if (manual)
      await offerInstallation()
    return
  }
  if (checking) {
    await checking
    if (manual)
      return checkForUpdates(true)
    return
  }

  checking = (async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      if (manual) {
        notify({
          id: 'app-update',
          type: 'info',
          message: result?.isUpdateAvailable
            ? `Downloading version ${result.updateInfo.version}…`
            : 'You are using the latest version.',
        })
      }
    }
    catch (error) {
      console.error('Error checking for updates:', error)
      if (manual) {
        notify({
          id: 'app-update',
          type: 'error',
          message: 'Unable to check for updates.',
          description: 'Please check your connection and try again later.',
        })
      }
    }
  })()
  try {
    await checking
  }
  finally {
    checking = undefined
  }
}

export function initializeUpdates(
  beforeInstall: () => void,
  sendNotification: (notification: AppNotification) => void,
) {
  notify = sendNotification
  if (!app.isPackaged || initialized)
    return
  initialized = true
  prepareToQuit = beforeInstall
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = null

  autoUpdater.on('update-available', () => {
    if (downloading || downloadedVersion)
      return
    downloading = true
    void autoUpdater
      .downloadUpdate()
      .catch((error) => {
        console.error('Error downloading update:', error)
        notify({
          id: 'app-update',
          type: 'error',
          message: 'Unable to download the update.',
          description: 'Please check your connection and try again later.',
        })
      })
      .finally(() => {
        downloading = false
      })
  })
  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version
    offerInstallation()
  })
  autoUpdater.on('error', error =>
    console.error('Auto-update error:', error))

  void checkForUpdates()
  const timer = setInterval(() => void checkForUpdates(), CHECK_INTERVAL)
  timer.unref()
  app.once('will-quit', () => clearInterval(timer))
}
