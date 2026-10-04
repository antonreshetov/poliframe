import type { Ref } from 'vue'
import type {
  LayoutResult,
  PreviewResult,
  Rect,
} from '../../../shared/contracts'
import { computed, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue'
import { useEditorContext } from '../useEditor'

interface ViewportDependencies {
  layout: Readonly<Ref<LayoutResult | undefined>>
  resizing: Ref<boolean>
  zoom: () => number | null
  emit: {
    (event: 'zoom', value: number | null): void
    (event: 'scale', value: number): void
    (event: 'fit', value: number): void
  }
}

export function usePreviewViewport({
  layout,
  resizing,
  zoom,
  emit,
}: ViewportDependencies) {
  const e = useEditorContext()
  const viewport = ref<HTMLElement>()
  const size = ref({ width: 600, height: 600 })
  const pan = ref({ x: 0, y: 0 })
  const dpr = ref(window.devicePixelRatio || 1)
  function updateDpr() {
    dpr.value = window.devicePixelRatio || 1
  }
  let observer: ResizeObserver
  let regionGeneration = 0
  let stateKey = ''
  let currentKey = ''
  let completed: { key: string, result: PreviewResult } | undefined
  let pending:
    { key: string, request: number, promise: Promise<void> } | undefined
  let disposed = false
  let requestSequence = 0
  let regionTimer: ReturnType<typeof setTimeout>
  onMounted(() => {
    window.addEventListener('resize', updateDpr)
    observer = new ResizeObserver(([entry]) => {
      if (entry) {
        updateDpr()
        size.value = {
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        }
      }
    })
    if (viewport.value)
      observer.observe(viewport.value)
  })
  onUnmounted(() => {
    observer?.disconnect()
    window.removeEventListener('resize', updateDpr)
    clearTimeout(regionTimer)
    regionGeneration++
    disposed = true
    completed = undefined
    pending = undefined
  })
  const fitScale = computed(() =>
    !layout.value
      ? 1 / dpr.value
      : Math.min(
          (size.value.width - 64) / layout.value.width,
          (size.value.height - 64) / layout.value.height,
          1 / dpr.value,
        ),
  )
  const scale = computed(() => {
    const value = zoom()
    return value === null
      ? fitScale.value
      : Math.max(fitScale.value, Math.min(100, value) / 100 / dpr.value)
  })
  function clearSelection() {
    e.selected = []
    viewport.value?.focus({ preventScroll: true })
  }
  function clampPan() {
    if (!layout.value || scale.value <= fitScale.value) {
      pan.value = { x: 0, y: 0 }
      return
    }
    const maxX = Math.max(
      0,
      (layout.value.width * scale.value - size.value.width) / 2,
    )
    const maxY = Math.max(
      0,
      (layout.value.height * scale.value - size.value.height) / 2,
    )
    pan.value = {
      x: Math.max(-maxX, Math.min(maxX, pan.value.x)),
      y: Math.max(-maxY, Math.min(maxY, pan.value.y)),
    }
  }
  watch(
    [scale, fitScale, () => layout.value?.width, () => layout.value?.height],
    clampPan,
  )
  watch([fitScale, dpr], ([value, ratio]) => emit('fit', value * ratio * 100), {
    immediate: true,
  })
  watch(zoom, (value) => {
    if (value === null)
      pan.value = { x: 0, y: 0 }
  })
  function wheel(event: WheelEvent) {
    const bounds = viewport.value!.getBoundingClientRect()
    const point = {
      x: event.clientX - bounds.left - bounds.width / 2,
      y: event.clientY - bounds.top - bounds.height / 2,
    }
    const next = Math.max(
      fitScale.value,
      Math.min(1 / dpr.value, scale.value * (event.deltaY > 0 ? 1 / 1.1 : 1.1)),
    )
    const factor = next / scale.value
    pan.value = {
      x: point.x - (point.x - pan.value.x) * factor,
      y: point.y - (point.y - pan.value.y) * factor,
    }
    emit('zoom', next <= fitScale.value ? null : next * dpr.value * 100)
  }
  watch([scale, dpr], ([value, ratio]) => emit('scale', value * ratio * 100), {
    immediate: true,
  })
  watchEffect(() => {
    const ratio = dpr.value
    const rendered = layout.value
      ? Math.max(layout.value.width, layout.value.height) * fitScale.value
      : Math.max(size.value.width, size.value.height)
    e.previewSize = Math.max(
      800,
      Math.min(3200, Math.ceil((rendered * ratio) / 256) * 256),
    )
  })
  const regionRendering = ref(false)
  const regionPreview = ref<PreviewResult | null>(null)
  const visibleRegion = computed<Rect | null>(() => {
    const output = layout.value
    if (!output || zoom() === null || scale.value <= 0)
      return null
    const fit = Math.min(
      (size.value.width - 64) / output.width,
      (size.value.height - 64) / output.height,
      1 / dpr.value,
    )
    if (scale.value <= fit)
      return null
    const left
      = (size.value.width - output.width * scale.value) / 2 + pan.value.x
    const top
      = (size.value.height - output.height * scale.value) / 2 + pan.value.y
    const x = Math.max(0, Math.floor(-left / scale.value))
    const y = Math.max(0, Math.floor(-top / scale.value))
    const right = Math.min(
      output.width,
      Math.ceil((size.value.width - left) / scale.value),
    )
    const bottom = Math.min(
      output.height,
      Math.ceil((size.value.height - top) / scale.value),
    )
    return right > x && bottom > y
      ? { x, y, width: right - x, height: bottom - y }
      : null
  })
  const regionAllowed = computed(() => {
    const backing = e.preview
    const publishedAnnotations
      = backing?.annotationLayers !== undefined
        && e.interactivePreview === backing
    return (
      !resizing.value
      && !e.spacingEditing
      && (!e.interactivePreview || publishedAnnotations)
      && !e.rendering
      && !!backing
      && backing.revision === e.renderRevision
    )
  })
  watch(
    [
      () => e.state,
      () => e.renderRevision,
      () => e.preview,
      () => e.rendering,
      resizing,
      () => e.spacingEditing,
      () => e.interactivePreview,
      visibleRegion,
      scale,
    ],
    () => {
      const nextStateKey = JSON.stringify([e.state, e.renderRevision])
      if (nextStateKey !== stateKey) {
        stateKey = nextStateKey
        regionGeneration++
        completed = undefined
        pending = undefined
      }
      const generation = regionGeneration
      clearTimeout(regionTimer)
      regionPreview.value = null
      regionRendering.value = false
      currentKey = ''
      const region = visibleRegion.value
      const backing = e.preview
      if (!regionAllowed.value || !region || !backing)
        return
      const revision = backing.revision
      const snapshot = JSON.parse(JSON.stringify(e.state))
      snapshot.revision = revision
      // Reserve decoded CPU/GPU pixels and a conservative data-URL allowance.
      const budgetEdge = Math.floor(
        Math.max(region.width, region.height)
        * Math.min(
          1,
          Math.sqrt((64 * 1024 * 1024) / 24 / (region.width * region.height)),
        ),
      )
      const maxSize = Math.round(
        Math.max(
          1,
          Math.min(
            budgetEdge,
            Math.max(
              400,
              Math.min(
                3200,
                Math.max(region.width, region.height) * scale.value * dpr.value,
              ),
            ),
          ),
        ),
      )
      const key = JSON.stringify([stateKey, region, maxSize])
      currentKey = key
      if (completed?.key === key) {
        if (pending && pending.key !== key) {
          requestSequence++
          pending = undefined
        }
        regionPreview.value = completed.result
        return
      }
      regionRendering.value = true
      if (pending?.key === key)
        return
      regionTimer = setTimeout(() => {
        const request = ++requestSequence
        const promise = (async () => {
          try {
            const result = await window.poliframe.preview(
              snapshot,
              maxSize,
              region,
            )
            if (
              disposed
              || generation !== regionGeneration
              || request !== requestSequence
              || result.revision !== revision
            ) {
              return
            }
            const factor = Math.min(
              1,
              maxSize / Math.max(region.width, region.height),
            )
            const expectedPixels
              = Math.ceil(region.width * factor)
                * Math.ceil(region.height * factor)
            if (
              result.dataUrl.length * 2 + expectedPixels * 8
              > 64 * 1024 * 1024
            ) {
              throw new Error('Preview region exceeds the memory budget')
            }
            // The single ROI allowance covers both displayed and cached pixels.
            completed = undefined
            const image
              = typeof window.Image === 'function'
                ? new window.Image()
                : undefined
            if (image) {
              image.src = result.dataUrl
              await image.decode()
            }
            if (
              disposed
              || generation !== regionGeneration
              || request !== requestSequence
            ) {
              return
            }
            const pixels
              = image?.naturalWidth && image.naturalHeight
                ? image.naturalWidth * image.naturalHeight
                : Math.ceil(region.width * factor)
                  * Math.ceil(region.height * factor)
            const cost = result.dataUrl.length * 2 + pixels * 8
            if (cost <= 64 * 1024 * 1024)
              completed = { key, result }
            if (currentKey === key && regionAllowed.value)
              regionPreview.value = result
          }
          catch (error) {
            if (
              !disposed
              && generation === regionGeneration
              && currentKey === key
            ) {
              e.fail(error)
            }
          }
          finally {
            if (pending?.request === request)
              pending = undefined
            if (currentKey === key && request === requestSequence)
              regionRendering.value = false
          }
        })()
        pending = { key, request, promise }
      }, 180)
    },
    { deep: true, flush: 'sync' },
  )
  function panStart(event: PointerEvent) {
    if (event.button === 0 && event.target === event.currentTarget)
      clearSelection()
    if (
      (event.target as HTMLElement).closest('button')
      || scale.value <= fitScale.value
    ) {
      return
    }
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    const start = { x: event.clientX, y: event.clientY }
    const old = { ...pan.value }
    const move = (ev: PointerEvent) => {
      pan.value = {
        x: old.x + ev.clientX - start.x,
        y: old.y + ev.clientY - start.y,
      }
      clampPan()
    }
    const end = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', end)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
  }
  return {
    viewport,
    size,
    pan,
    scale,
    regionPreview,
    regionAllowed,
    regionRendering,
    wheel,
    panStart,
    clearSelection,
  }
}
