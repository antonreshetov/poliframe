// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import PreviewDetailLayer from '../src/renderer/components/editor/PreviewDetailLayer.vue'

afterEach(() => vi.restoreAllMocks())

it('assembles tiles without resampling, preserves the color space, and releases the surface', async () => {
  const drawImage = vi.fn()
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
  const bitmap = {
    width: 256,
    height: 256,
    close: vi.fn(),
  } as unknown as ImageBitmap
  const first = {
    key: 'a',
    cellId: 'cell',
    x: 1 / 3,
    y: 2 / 3,
    width: 256,
    height: 256,
    pixelWidth: 256,
    pixelHeight: 256,
    bitmap,
  }
  const tiles = shallowRef([first, { ...first, key: 'b', x: first.x + 256 }])
  const root = document.createElement('div')
  const app = createApp(() =>
    h(PreviewDetailLayer, {
      tiles: tiles.value,
      scale: 0.5,
      colorSpace: 'display-p3',
    }),
  )
  try {
    app.mount(root)
    await nextTick()
    const canvas = root.querySelector('canvas')!
    expect([canvas.width, canvas.height]).toEqual([512, 256])
    expect(getContext).toHaveBeenCalledWith('2d', {
      colorSpace: 'display-p3',
      willReadFrequently: true,
    })
    expect(drawImage.mock.calls).toEqual([
      [bitmap, 0, 0],
      [bitmap, 256, 0],
    ])
    tiles.value = [first]
    await nextTick()
    expect(canvas.width).toBe(256)
    app.unmount()
    expect([canvas.width, canvas.height]).toEqual([0, 0])
    expect(bitmap.close).not.toHaveBeenCalled() // The shared cache owns the bitmap.
  }
  finally {
    if (root.firstChild)
      app.unmount()
  }
})
