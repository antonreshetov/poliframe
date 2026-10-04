import type { PreviewResult } from '../../../shared/contracts'

type Tile = NonNullable<PreviewResult['detailTiles']>[number]
interface Entry {
  url: string
  cost: number
  image: HTMLImageElement
  ready: boolean
}

/** Owns decoded tile resources, including the visible set, within one byte budget. */
export class PreviewTileCache {
  private entries = new Map<string, Entry>()
  private bytes = 0
  private queue: Promise<unknown> = Promise.resolve()

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
    entry.image.src = ''
    URL.revokeObjectURL(entry.url)
  }

  clear() {
    for (const key of this.entries.keys()) this.remove(key)
  }

  load(tiles: Tile[], current: () => boolean): Promise<Tile[] | null> {
    // Preparing/evicting a batch is synchronous. In-flight acknowledgments
    // therefore never advertise entries a previous decode can later evict.
    const job = this.queue.then(() =>
      current() ? this.prepare(tiles, current) : null,
    )
    this.queue = job.catch(() => {})
    return job
  }

  private async prepare(
    tiles: Tile[],
    current: () => boolean,
  ): Promise<Tile[] | null> {
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
        const image = new window.Image()
        const url = URL.createObjectURL(
          new Blob([new Uint8Array(tile.data!)], { type: 'image/jpeg' }),
        )
        const entry = { url, cost: costs.get(key)!, image, ready: false }
        this.entries.set(key, entry)
        this.bytes += entry.cost
        added.push(key)
        image.src = url
      }
      for (const key of added) {
        if (!current())
          return null
        const entry = this.entries.get(key)!
        await entry.image.decode()
        const tile = unique.get(key)!
        if (
          entry.image.naturalWidth
          && (entry.image.naturalWidth !== tile.pixelWidth
            || entry.image.naturalHeight !== tile.pixelHeight)
        ) {
          throw new Error('Invalid preview tile dimensions')
        }
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
        dataUrl: this.entries.get(tile.key)!.url,
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
