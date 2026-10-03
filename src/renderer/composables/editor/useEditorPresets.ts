import type { Ref } from 'vue'
import type {
  Composition,
  GridNode,
  Photo,
  Preset,
} from '../../../shared/contracts'
import { computed, ref } from 'vue'
import { defaults } from '../../../shared/defaults'
import { leaves } from './useEditorGrid'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

interface PresetDependencies {
  state: Ref<Composition>
  photos: Record<string, Photo>
  fillGrid: () => void
  fail: (error: unknown) => void
}

export function useEditorPresets({
  state,
  photos,
  fillGrid,
  fail,
}: PresetDependencies) {
  const presets = ref<Preset[]>([])
  const activePreset = ref('')
  const presetBaseline = ref('')
  function presetSignature() {
    const {
      panels: _panels,
      revision: _revision,
      print: _print,
      ...value
    } = clone(state.value)
    value.caption.sourceId = null
    value.output.metadataId = null
    for (const leaf of leaves(value.grid)) leaf.photoId = null
    if (value.layout !== 'grid') {
      value.layout = 'horizontal'
      value.grid = null as unknown as GridNode
    }
    return JSON.stringify(value)
  }
  const presetModified = computed(
    () =>
      presets.value.some(p => p.id === activePreset.value)
      && presetBaseline.value !== presetSignature(),
  )
  function settings(): Preset['settings'] {
    const { panels: _p, revision: _r, ...rest } = clone(state.value)
    for (const l of leaves(rest.grid)) l.photoId = null
    return rest
  }
  async function savePreset(name: string, id?: string) {
    if (!name.trim())
      return
    try {
      const old = presets.value.find(p => p.id === id)
      const preset: Preset = {
        id: id ?? crypto.randomUUID(),
        name: name.trim(),
        createdAt: old?.createdAt ?? new Date().toISOString(),
        settings: settings(),
      }
      const savedSignature = presetSignature()
      await window.poliframe.presets.save(preset)
      presets.value = await window.poliframe.presets.list()
      activePreset.value = preset.id
      presetBaseline.value = savedSignature
    }
    catch (e) {
      fail(e)
    }
  }
  async function renamePreset(id: string, name: string) {
    const preset = presets.value.find(p => p.id === id)
    if (!preset || !name.trim())
      return
    try {
      await window.poliframe.presets.save({
        ...clone(preset),
        name: name.trim(),
      })
      presets.value = await window.poliframe.presets.list()
    }
    catch (e) {
      fail(e)
    }
  }
  async function deletePreset(id: string) {
    try {
      await window.poliframe.presets.remove(id)
      presets.value = presets.value.filter(p => p.id !== id)
      activePreset.value = ''
    }
    catch (e) {
      fail(e)
    }
  }
  function applyPreset(id: string) {
    const previous = state.value
    const base = defaults()
    const saved = presets.value.find(p => p.id === id)
    if (id === 'builtin') {
      base.percent.frame = 6
      base.caption.enabled = true
      base.caption.title = 'Untitled Frame'
      base.caption.copyright = '© John Doe'
      base.percent.captionBottom = 0
      base.caption.separatePadding = true
    }
    const next = saved ? { ...base, ...clone(saved.settings) } : base
    next.panels = previous.panels
    next.print = id === 'defaults' ? base.print : previous.print
    if (!saved || saved.settings.layout !== 'grid') {
      next.layout = previous.layout
      next.grid = previous.grid
    }
    next.caption.sourceId = previous.caption.sourceId
    next.output.metadataId = previous.output.metadataId
    if (next.watermark.photoId && saved?.logo) {
      photos[next.watermark.photoId] = {
        id: next.watermark.photoId,
        name: 'Preset watermark',
        width: 1,
        height: 1,
        thumbnail: saved.logo,
        exif: {},
      }
    }
    state.value = next
    if (saved?.settings.layout === 'grid')
      fillGrid()
    activePreset.value = id
    presetBaseline.value = presetSignature()
  }
  return {
    presets,
    activePreset,
    presetModified,
    savePreset,
    renamePreset,
    deletePreset,
    applyPreset,
  }
}
