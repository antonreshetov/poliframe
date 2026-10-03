import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { inject, it } from 'vitest'
import { annotationPreview } from '../src/main/imaging/annotations.ts'
import { captionFonts } from '../src/main/imaging/fonts.ts'

import { defaults } from '../src/shared/defaults.ts'

// Read the font's own Windows Unicode family/subfamily names as the oracle.
function names(file) {
  const data = readFileSync(file)
  let table
  for (let i = 0; i < data.readUInt16BE(4); i++) {
    const offset = 12 + i * 16
    if (data.toString('ascii', offset, offset + 4) === 'name')
      table = data.readUInt32BE(offset + 8)
  }
  assert.notEqual(table, undefined)
  const strings = table + data.readUInt16BE(table + 4)
  const result = {}
  for (let i = 0; i < data.readUInt16BE(table + 2); i++) {
    const offset = table + 6 + i * 12
    const id = data.readUInt16BE(offset + 6)
    if (data.readUInt16BE(offset) !== 3 || ![1, 2].includes(id))
      continue
    const start = strings + data.readUInt16BE(offset + 10)
    result[id] = Buffer.from(
      data.subarray(start, start + data.readUInt16BE(offset + 8)),
    )
      .swap16()
      .toString('utf16le')
  }
  return result
}

for (const [face, description] of Object.entries(captionFonts)) {
  it(`bundled caption face ${face} renders its own family instead of fallback`, async () => {
    const file = resolve('resources/fonts', `${face}.ttf`)
    const metadata = names(file)
    const content = 'Annotation Hamburg 123'
    const render = (font, text = content) =>
      sharp({ text: { text, font, fontfile: file, rgba: true, dpi: 72 } })
        .png()
        .toBuffer()
    const style = metadata[2].includes('Italic') ? 'italic' : 'normal'
    const weight = metadata[2].includes('Bold') ? 'bold' : 'normal'
    const expected = await render(
      'sans 40',
      `<span font_family="${metadata[1]}" style="${style}" weight="${weight}">${content}</span>`,
    )
    const actual = await render(`${description} 40`)
    assert.deepEqual(
      actual,
      expected,
      'font description must select the embedded family and style',
    )
    const fallback = await render(
      `NonexistentPoliframeFont ${style} ${weight} 40`,
    )
    assert.notDeepEqual(
      actual,
      fallback,
      'the bundled font must not silently fall back',
    )
  })
}

it('caption fonts survive the real render worker preview path', async (t) => {
  const { RenderJobs } = createRequire(import.meta.url)(
    resolve(inject('workerBuild'), 'main/services/render-jobs.js'),
  )
  const jobs = new RenderJobs()
  t.onTestFinished(() => jobs.close())
  const snapshot = defaults()
  snapshot.layout = 'grid'
  snapshot.caption.enabled = true
  snapshot.caption.style = 'editorial'
  snapshot.caption.title = 'Bundled italic title'
  const resources = resolve('resources')
  const expected = await annotationPreview(snapshot, [], resources, 800)
  const actual = await jobs.request('preview', {
    snapshot,
    assets: [],
    resources,
    maxSize: 800,
    annotationsOnly: true,
  })
  assert.ok(actual.annotationLayers.length)
  assert.deepEqual(actual.annotationLayers, expected.annotationLayers)
})
