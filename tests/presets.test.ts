import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { it } from 'vitest'

import { PresetStore } from '../src/main/services/presets.ts'
import { defaults, identityTransform } from '../src/shared/defaults.ts'

it('presets exclude photographs, source selection, revision and print settings', async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'poliframe-preset-test-'),
  )
  const store = new PresetStore(directory, {})
  const id = randomUUID()
  try {
    const state = defaults()
    state.panels = [
      { photoId: 'private-photo', transform: identityTransform() },
    ]
    state.caption.sourceId = 'private-photo'
    state.output.metadataId = 'private-photo'
    state.print.enabled = true
    await store.save({
      id,
      name: ' Test ',
      createdAt: '2026-10-02',
      settings: state,
    })
    const data = JSON.parse(
      await readFile(path.join(directory, `${id}.json`), 'utf8'),
    )
    assert.equal(data.name, 'Test')
    assert.equal('panels' in data.settings, false)
    assert.equal('revision' in data.settings, false)
    assert.equal('print' in data.settings, false)
    assert.equal(data.settings.caption.sourceId, null)
    assert.equal(data.settings.output.metadataId, null)
    const loaded = await store.list()
    assert.equal(loaded.length, 1)
  }
  finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('removing or updating a preset keeps applied logo assets alive', async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'poliframe-preset-test-'),
  )
  const paths = new Map()
  const registry = {
    import: async (file) => {
      const id = randomUUID()
      paths.set(id, file)
      return { id }
    },
  }
  const store = new PresetStore(directory, registry)
  const id = randomUUID()
  try {
    await store.save({
      id,
      name: 'Logo',
      createdAt: '2026-10-02',
      settings: defaults(),
      logo: 'data:image/png;base64,YQ==',
    })
    const first = (await store.list())[0]
    const firstPath = paths.get(first.settings.watermark.photoId)
    await store.save({
      id,
      name: 'Logo',
      createdAt: '2026-10-02',
      settings: defaults(),
      logo: 'data:image/png;base64,Yg==',
    })
    const second = (await store.list())[0]
    await store.remove(id)
    assert.equal((await readFile(firstPath)).toString(), 'a')
    assert.equal(
      (await readFile(paths.get(second.settings.watermark.photoId))).toString(),
      'b',
    )
    assert.deepEqual(await store.list(), [])
  }
  finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
