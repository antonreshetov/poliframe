import type { Composition, Rect } from '../../shared/contracts'
import type { Asset } from '../services/assets'
import path from 'node:path'
import process from 'node:process'
import { parentPort } from 'node:worker_threads'
import { annotationPreview } from './annotations'
import { compose, gesturePreview } from './composition'
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
      const { pipeline, layout } = await compose(
        job.snapshot,
        job.assets,
        job.resources,
        job.type === 'preview' ? job.maxSize : undefined,
        job.type === 'preview' ? job.region : undefined,
      )
      const profile
        = job.snapshot.output.profile === 'adobe'
          ? {
              path:
                process.platform === 'darwin'
                  ? '/System/Library/ColorSync/Profiles/AdobeRGB1998.icc'
                  : path.join(job.resources, 'profiles/AdobeRGB1998.icc'),
            }
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
