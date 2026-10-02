import type { Composition, GridNode, Preset } from '../../shared/contracts'
import type { AssetRegistry } from './assets'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defaults } from '../../shared/defaults'
import { validateComposition } from './validation'

export class PresetStore {
  private logoDirectory = path.join(
    os.tmpdir(),
    `poliframe-logos-${randomUUID()}`,
  )

  private hydrated = new Map<string, { data: string, id: string }>()
  constructor(
    private directory: string,
    private assets: AssetRegistry,
  ) {}

  private file(id: string) {
    if (!/^[\da-f-]{36}$/i.test(id))
      throw new Error('Invalid preset ID')
    return path.join(this.directory, `${id}.json`)
  }

  async list(): Promise<Preset[]> {
    await mkdir(this.directory, { recursive: true })
    const presets: Preset[] = []
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith('.json'))
        continue
      try {
        const data = JSON.parse(
          await readFile(path.join(this.directory, file), 'utf8'),
        )
        if (data.version !== 1 || typeof data.name !== 'string')
          continue
        this.file(data.id)
        const base = defaults()
        const settings = { ...base, ...data.settings, panels: [], revision: 0 }
        settings.caption = {
          ...base.caption,
          ...settings.caption,
          sourceId: null,
        }
        settings.output = {
          ...base.output,
          ...settings.output,
          metadataId: null,
        }
        settings.watermark = {
          ...base.watermark,
          ...settings.watermark,
          photoId: null,
        }
        validateComposition(settings)
        const preset: Preset = {
          id: data.id,
          name: data.name,
          createdAt: data.createdAt,
          settings,
          logo: data.logo,
        }
        if (data.logo) {
          if (
            typeof data.logo !== 'string'
            || !data.logo.startsWith('data:image/png;base64,')
            || data.logo.length > 24_000_000
          ) {
            continue
          }
          await mkdir(this.logoDirectory, { recursive: true })
          const cached = this.hydrated.get(data.id)
          if (cached && cached.data === data.logo) {
            preset.settings.watermark.photoId = cached.id
          }
          else {
            const logoPath = path.join(
              this.logoDirectory,
              `${randomUUID()}.png`,
            )
            await writeFile(
              logoPath,
              Buffer.from(data.logo.split(',')[1], 'base64'),
            )
            const photo = await this.assets.import(logoPath)
            this.hydrated.set(data.id, { data: data.logo, id: photo.id })
            preset.settings.watermark.photoId = photo.id
          }
        }
        presets.push(preset)
      }
      catch {
        /* Ignore individual corrupt presets; valid user presets remain available. */
      }
    }
    return presets.sort((a, b) => a.name.localeCompare(b.name))
  }

  async save(preset: Preset) {
    if (
      !preset
      || typeof preset.name !== 'string'
      || !preset.name.trim()
      || preset.name.length > 120
    ) {
      throw new Error('Enter a preset name (up to 120 characters)')
    }
    const file = this.file(preset.id)
    const original = structuredClone(preset.settings)
    let logo = preset.logo
    if (original.watermark.photoId)
      logo = await this.assets.logoData(original.watermark.photoId)
    if (
      logo
      && (!logo.startsWith('data:image/png;base64,') || logo.length > 24_000_000)
    ) {
      throw new Error('Preset logo is too large')
    }
    function clear(node: GridNode): void {
      if (node.type === 'leaf')
        node.photoId = null
      else node.children.forEach(clear)
    }
    clear(original.grid)
    original.caption.sourceId = null
    original.output.metadataId = null
    original.watermark.photoId = null
    original.print = defaults().print
    const state = { ...original, panels: [], revision: 0 } as Composition
    validateComposition(state)
    await mkdir(this.directory, { recursive: true })
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(
        temp,
        JSON.stringify({
          version: 1,
          id: preset.id,
          name: preset.name.trim(),
          createdAt: preset.createdAt,
          settings: (({
            panels: _panels,
            revision: _revision,
            print: _print,
            ...settings
          }) => settings)(state),
          logo,
        }),
        { flag: 'wx' },
      )
      await rename(temp, file)
    }
    finally {
      await rm(temp, { force: true })
    }
  }

  async close() {
    await rm(this.logoDirectory, { recursive: true, force: true })
  }

  async remove(id: string) {
    await rm(this.file(id), { force: true })
  }
}
