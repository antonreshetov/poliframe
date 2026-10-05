import type { PreviewResult } from '../../../shared/contracts'

type Tile = NonNullable<PreviewResult['detailTiles']>[number]
export type DecodedTile = Omit<Tile, 'data'> & { bitmap: ImageBitmap }
export type DetailPreview = Omit<PreviewResult, 'detailTiles'> & {
  detailTiles?: DecodedTile[]
}
interface Entry {
  cost: number
  bitmap: ImageBitmap
  ready: boolean
}

export function tileSurface(tiles: Tile[]) {
  const first = tiles[0]!
  const x = Math.min(...tiles.map(tile => tile.x))
  const y = Math.min(...tiles.map(tile => tile.y))
  const right = Math.max(...tiles.map(tile => tile.x + tile.width))
  const bottom = Math.max(...tiles.map(tile => tile.y + tile.height))
  const xScale = first.pixelWidth / first.width
  const yScale = first.pixelHeight / first.height
  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
    xScale,
    yScale,
    pixelWidth: Math.max(1, Math.round((right - x) * xScale)),
    pixelHeight: Math.max(1, Math.round((bottom - y) * yScale)),
  }
}

/** Owns decoded tile resources, including the visible set, within one byte budget. */
export class PreviewTileCache {
  private entries = new Map<string, Entry>()
  private bytes = 0
  private queue: Promise<unknown> = Promise.resolve()
  private generation = 0

  constructor(
    private readonly onEvict: (key: string) => void,
    private readonly budget = 64 * 1024 * 1024,
  ) {}

  keys(): string[] {
    return [...this.entries]
      .filter(([, entry]) => entry.ready)
      .map(([key]) => key)
  }

  private remove(key: string) {
    const entry = this.entries.get(key)
    if (!entry)
      return
    this.onEvict(key)
    this.entries.delete(key)
    this.bytes -= entry.cost
    entry.bitmap.close()
  }

  clear() {
    this.generation++
    for (const key of this.entries.keys()) this.remove(key)
  }

  load(tiles: Tile[], current: () => boolean): Promise<DecodedTile[] | null> {
    // Serialize batches; only fully published bitmaps are acknowledged.
    const generation = this.generation
    const active = () => generation === this.generation && current()
    const job = this.queue.then(() =>
      active() ? this.prepare(tiles, active) : null,
    )
    this.queue = job.catch(() => {})
    return job
  }

  private async prepare(
    tiles: Tile[],
    current: () => boolean,
  ): Promise<DecodedTile[] | null> {
    const unique = new Map(tiles.map(tile => [tile.key, tile]))
    const costs = new Map<string, number>()
    for (const [key, tile] of unique) {
      if (
        ![tile.pixelWidth, tile.pixelHeight].every(
          value => Number.isInteger(value) && value > 0,
        )
      ) {
        throw new Error('Invalid preview tile size')
      }
      const existing = this.entries.get(key)
      if (!existing && !tile.data)
        throw new Error('Preview tile is unavailable')
      const cost
        = existing?.cost
          ?? tile.pixelWidth * tile.pixelHeight * 8 + tile.data!.byteLength
      if (!Number.isFinite(cost) || cost < 1)
        throw new Error('Invalid preview tile size')
      costs.set(key, cost)
    }
    if (
      unique.size > 512
      || [...costs.values()].reduce((sum, cost) => sum + cost, 0) > this.budget
    ) {
      throw new Error('Preview region exceeds the memory budget')
    }
    const surfaces = new Map<string, Tile[]>()
    for (const tile of tiles) {
      const group = surfaces.get(tile.cellId) ?? []
      group.push(tile)
      surfaces.set(tile.cellId, group)
    }
    const surfaceBytes = [...surfaces.values()].reduce((sum, group) => {
      const { pixelWidth, pixelHeight } = tileSurface(group)
      return sum + pixelWidth * pixelHeight * 4
    }, 0)
    // Visible canvas surfaces have a separate 16 MiB CPU + 16 MiB GPU cap.
    if (!Number.isFinite(surfaceBytes) || surfaceBytes > 16 * 1024 * 1024)
      throw new Error('Preview surfaces exceed the memory budget')
    const added: string[] = []
    const extra = [...costs].reduce(
      (sum, [key, cost]) => sum + (this.entries.has(key) ? 0 : cost),
      0,
    )
    const newCount = [...unique.keys()].filter(
      key => !this.entries.has(key),
    ).length
    for (const key of this.entries.keys()) {
      if (
        this.bytes + extra <= this.budget
        && this.entries.size + newCount <= 512
      ) {
        break
      }
      if (!unique.has(key))
        this.remove(key)
    }
    try {
      for (const [key, tile] of unique) {
        if (this.entries.has(key))
          continue
        if (!current())
          return null
        const bitmap = await createImageBitmap(
          new Blob([new Uint8Array(tile.data!)], { type: 'image/jpeg' }),
        )
        if (!current()) {
          bitmap.close()
          return null
        }
        if (
          bitmap.width !== tile.pixelWidth
          || bitmap.height !== tile.pixelHeight
        ) {
          bitmap.close()
          throw new Error('Invalid preview tile dimensions')
        }
        this.entries.set(key, { cost: costs.get(key)!, bitmap, ready: false })
        this.bytes += costs.get(key)!
        added.push(key)
      }
      if (!current())
        return null
      for (const key of unique.keys()) {
        const entry = this.entries.get(key)!
        entry.ready = true
        this.entries.delete(key)
        this.entries.set(key, entry)
      }
      const result = tiles.map(({ data: _data, ...tile }) => ({
        ...tile,
        bitmap: this.entries.get(tile.key)!.bitmap,
      }))
      added.length = 0
      return result
    }
    finally {
      // Failed/stale batches cannot become acknowledgable resources.
      for (const key of added) this.remove(key)
    }
  }
}
