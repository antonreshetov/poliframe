import type { Composition, Rect } from '../../shared/contracts'
import type { Asset } from '../services/assets'
import { parentPort } from 'node:worker_threads'
import { annotationPreview } from './annotations'
import { outputProfile } from './color'
import { compose, gesturePreview } from './composition'
import { detailPreview } from './detail-preview'
import { exportImage } from './index'

parentPort!.on(
  'message',
  async (job: {
    id: number
    type: 'preview' | 'export'
    snapshot: Composition
    assets: Asset[]
    resources: string
    region?: Rect
    maxSize?: number
    annotationsOnly?: boolean
    knownGestureImagesKey?: string
    knownDetailKeys?: string[]
    destination?: string
  }) => {
    try {
      if (job.type === 'preview' && job.annotationsOnly) {
        const result = await annotationPreview(
          job.snapshot,
          job.assets,
          job.resources,
          job.maxSize ?? 2200,
          job.knownGestureImagesKey,
        )
        parentPort!.postMessage({ id: job.id, result })
        return
      }
      if (job.type === 'preview' && job.region) {
        const result = await detailPreview(
          job.snapshot,
          job.assets,
          job.resources,
          job.region,
          job.maxSize ?? 2200,
          job.knownDetailKeys,
        )
        if (result) {
          parentPort!.postMessage({ id: job.id, result })
          return
        }
      }
      const { pipeline, layout } = await compose(
        job.snapshot,
        job.assets,
        job.resources,
        job.type === 'preview' ? job.maxSize : undefined,
        job.type === 'preview' ? job.region : undefined,
      )
      const profilePath = outputProfile(
        job.snapshot.output.profile,
        job.resources,
      )
      const profile
        = job.snapshot.output.profile === 'adobe'
          ? { path: profilePath }
          : job.snapshot.output.profile
      if (job.type === 'preview') {
        const data = await pipeline
          .withIccProfile(typeof profile === 'string' ? profile : profile.path)
          .toColourspace('srgb')
          .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
          .toBuffer()
        parentPort!.postMessage({
          id: job.id,
          result: {
            revision: job.snapshot.revision,
            region: job.region,
            ...(job.region
              ? {}
              : await gesturePreview(
                  job.snapshot,
                  job.assets,
                  job.knownGestureImagesKey,
                  {
                    layout,
                    maxSize: job.maxSize ?? 2200,
                    resources: job.resources,
                  },
                )),
            dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`,
            layout,
          },
        })
      }
      else {
        await exportImage(pipeline, job.destination!, {
          format: job.snapshot.output.format,
          bitDepth: job.snapshot.output.depth,
          profile,
          quality: job.snapshot.output.quality,
          dpi: layout.dpi,
        })
        parentPort!.postMessage({ id: job.id, result: layout })
      }
    }
    catch (error) {
      parentPort!.postMessage({
        id: job.id,
        error: error instanceof Error ? error.message : 'Rendering failed',
      })
    }
  },
)
