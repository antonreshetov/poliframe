import type { BrowserWindow } from 'electron'
import type { Composition, PreviewResult } from '../../shared/contracts'
import type { AssetRegistry } from '../services/assets'
import type { RenderJobs } from '../services/render-jobs'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { dialog } from 'electron'
import { validateComposition } from '../services/validation'

interface ImageHandlerDependencies {
  getWindow: () => BrowserWindow
  assets: AssetRegistry
  jobs: RenderJobs
  resources: string
}

export function registerImageHandlers(
  handle: (channel: string, fn: (...args: any[]) => unknown) => void,
  { getWindow, assets, jobs, resources }: ImageHandlerDependencies,
) {
  let exporting = false
  let exportGeneration = 0
  function invalidateExports() {
    exportGeneration++
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
      const result = await dialog.showOpenDialog(getWindow(), {
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
      knownGestureImagesKey?: unknown,
      knownDetailKeys?: unknown,
    ) => {
      if (annotationsOnly !== undefined && typeof annotationsOnly !== 'boolean')
        throw new Error('Invalid annotation preview mode')
      if (
        knownGestureImagesKey !== undefined
        && (typeof knownGestureImagesKey !== 'string'
          || !/^[a-f0-9]{64}$/.test(knownGestureImagesKey))
      ) {
        throw new Error('Invalid gesture images key')
      }
      if (
        knownDetailKeys !== undefined
        && (!Array.isArray(knownDetailKeys)
          || knownDetailKeys.length > 512
          || knownDetailKeys.some(
            key =>
              typeof key !== 'string' || key.length < 1 || key.length > 512,
          ))
      ) {
        throw new Error('Invalid detail tile keys')
      }
      validateComposition(snapshot)
      if (
        region !== undefined
        && (!region
          || typeof region !== 'object'
          || !['x', 'y', 'width', 'height'].every((key) => {
            const n = (region as Record<string, unknown>)[key]
            return (
              typeof n === 'number'
              && Number.isFinite(n)
              && n >= 0
              && n <= 32768
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
        knownGestureImagesKey: region ? undefined : knownGestureImagesKey,
        knownDetailKeys: region ? knownDetailKeys : undefined,
      })
    },
  )
  handle('images:cancel', async () => {
    invalidateExports()
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
      const result = await dialog.showSaveDialog(getWindow(), {
        defaultPath: `${names || 'Poliframe'}.${ext}`,
        filters: [
          { name: snapshot.output.format.toUpperCase(), extensions: [ext] },
        ],
      })
      if (
        result.canceled
        || !result.filePath
        || generation !== exportGeneration
      ) {
        return { status: 'cancelled' }
      }
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

  return { invalidateExports }
}
