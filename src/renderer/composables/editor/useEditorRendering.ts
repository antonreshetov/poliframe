import type { Ref } from 'vue'
import type {
  Composition,
  Photo,
  PreviewResult,
} from '../../../shared/contracts'
import { onUnmounted, ref, watch } from 'vue'
import { calculateLayout } from '../../../shared/layout'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

interface RenderDependencies {
  state: Ref<Composition>
  photos: Record<string, Photo>
  fail: (error: unknown) => void
}

export function useEditorRendering({
  state,
  photos,
  fail,
}: RenderDependencies) {
  const rendering = ref(false)
  const preview = ref<PreviewResult | null>(null)
  const previewSize = ref(2200)
  const interactivePreview = ref<PreviewResult | null>(null)
  const spacingEditing = ref(false)
  function beginSpacing() {
    spacingEditing.value = true
  }
  function endSpacing() {
    spacingEditing.value = false
  }
  let generation = 0
  let importedPreviewPending = false
  let geometryFrame = 0
  let lastRenderStart = 0
  let lastStartedRevision = 0
  const renderWake = ref(0)
  let decodedPreviewUrls = new Set<string>()
  let publishedTransforms = new Map<string, string>()
  let previousGeometry = ''
  let nativeRendering = false
  let renderAgain = false
  const canUseLocalGeometry = () =>
    !(state.value.caption.enabled || !!state.value.watermark.photoId)
  async function updateInteractive(revision: number) {
    const snapshot = clone(state.value)
    const layout = await calculateLayout(snapshot, Object.values(photos))
    if (revision !== generation || preview.value?.revision === revision)
      return
    const gestureImages: NonNullable<PreviewResult['gestureImages']> = []
    const visible = new Set(
      layout.cells.map(cell => cell.photoId).filter(Boolean),
    )
    for (const photoId of visible) {
      const panel = snapshot.panels.find(panel => panel.photoId === photoId)
      const photo = photos[photoId!]
      if (!panel || !photo) {
        interactivePreview.value = null
        return
      }
      const existing
        = publishedTransforms.get(panel.photoId)
          === JSON.stringify(panel.transform)
          ? preview.value?.gestureImages?.find(
              image => image.photoId === panel.photoId,
            )
          : undefined
      if (existing) {
        gestureImages.push(existing)
        continue
      }
      const { rotation, flipX, flipY, crop } = panel.transform
      if (
        rotation !== 0
        || flipX
        || flipY
        || crop.x !== 0
        || crop.y !== 0
        || crop.width !== 1
        || crop.height !== 1
        || !photo.thumbnail
      ) {
        interactivePreview.value = null
        return
      }
      const ratio = Math.min(1, 800 / Math.max(photo.width, photo.height))
      gestureImages.push({
        photoId: photo.id,
        dataUrl: photo.thumbnail,
        width: photo.width * ratio,
        height: photo.height * ratio,
      })
    }
    interactivePreview.value = { revision, layout, dataUrl: '', gestureImages }
  }
  const renderRevision = ref(0)
  let timer: ReturnType<typeof setTimeout>
  watch(
    [state, previewSize, spacingEditing, renderWake],
    () => {
      const geometry = JSON.stringify([
        state.value.layout,
        state.value.grid,
        state.value.gridAspect,
      ])
      const geometryChanged = geometry !== previousGeometry
      previousGeometry = geometry
      const revision = ++generation
      renderRevision.value = revision
      clearTimeout(timer)
      cancelAnimationFrame(geometryFrame)
      if (!state.value.panels.length && state.value.layout !== 'grid') {
        publishedTransforms.clear()
        preview.value = null
        interactivePreview.value = null
        rendering.value = false
        return
      }
      const importingPreview = importedPreviewPending
      importedPreviewPending = false
      if (
        canUseLocalGeometry()
        && (spacingEditing.value || importingPreview || geometryChanged)
      ) {
        geometryFrame = requestAnimationFrame(() => {
          void updateInteractive(revision).catch(fail)
        })
        if (spacingEditing.value) {
          rendering.value = false
          return
        }
      }
      timer = setTimeout(
        async () => {
          if (nativeRendering) {
            renderAgain = true
            return
          }
          nativeRendering = true
          renderAgain = false
          lastRenderStart = Date.now()
          lastStartedRevision = revision
          const annotationMode
            = state.value.caption.enabled || !!state.value.watermark.photoId
          const photoSignature = () =>
            JSON.stringify([
              state.value.panels,
              state.value.grid,
              state.value.layout,
              state.value.watermark.photoId,
            ])
          const startedPhotos = photoSignature()
          const canPublish = () =>
            revision === generation
            || (annotationMode
              && (state.value.caption.enabled
                || !!state.value.watermark.photoId)
              && startedPhotos === photoSignature())
            || (spacingEditing.value
              && !canUseLocalGeometry()
              && revision === lastStartedRevision)
          rendering.value = true
          try {
            const snapshot = clone(state.value)
            snapshot.revision = revision
            const publishedPreview = preview.value
            const result = await window.poliframe.preview(
              snapshot,
              previewSize.value,
              undefined,
              annotationMode,
              publishedPreview?.gestureImagesKey,
            )
            if (!canPublish())
              return
            if (result.gestureImages === undefined && result.gestureImagesKey) {
              if (
                result.gestureImagesKey
                !== publishedPreview?.gestureImagesKey
                || !publishedPreview.gestureImages
              ) {
                throw new Error('Gesture preview images are unavailable')
              }
              result.gestureImages = publishedPreview.gestureImages
            }
            // Decode before publishing: replacing the live layers must not expose
            // an undecoded image or make the first drag pay for photo decoding.
            if (typeof window.Image === 'function') {
              await Promise.all(
                [
                  ...(result.dataUrl ? [result.dataUrl] : []),
                  ...(result.annotationLayers ?? []).map(
                    layer => layer.dataUrl,
                  ),
                  ...(result.gestureImages ?? []).map(image => image.dataUrl),
                ]
                  .filter(url => !decodedPreviewUrls.has(url))
                  .map(async (url) => {
                    const image = new window.Image()
                    image.src = url
                    await image.decode()
                  }),
              )
            }
            if (canPublish()) {
              decodedPreviewUrls = new Set([
                ...(result.dataUrl ? [result.dataUrl] : []),
                ...(result.annotationLayers ?? []).map(
                  layer => layer.dataUrl,
                ),
                ...(result.gestureImages ?? []).map(image => image.dataUrl),
              ])
              publishedTransforms = new Map(
                snapshot.panels.map(panel => [
                  panel.photoId,
                  JSON.stringify(panel.transform),
                ]),
              )
              preview.value = result
              interactivePreview.value = result.annotationLayers
                ? result
                : null
            }
          }
          catch (e) {
            if (revision === generation)
              fail(e)
          }
          finally {
            nativeRendering = false
            if (revision === generation)
              rendering.value = false
            if (renderAgain) {
              renderAgain = false
              renderWake.value++
            }
          }
        },
        spacingEditing.value
          ? Math.max(0, 16 - (Date.now() - lastRenderStart))
          : importingPreview
            ? 32
            : 0,
      )
    },
    { deep: true, immediate: true },
  )
  function markImportedPreview() {
    importedPreviewPending = true
  }
  onUnmounted(() => {
    clearTimeout(timer)
    cancelAnimationFrame(geometryFrame)
  })
  return {
    preview,
    previewSize,
    interactivePreview,
    spacingEditing,
    beginSpacing,
    endSpacing,
    renderRevision,
    rendering,
    markImportedPreview,
  }
}
