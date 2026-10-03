import type { Ref } from 'vue'
import type {
  Composition,
  GridLeaf,
  GridNode,
} from '../../../shared/contracts'
import { computed, ref } from 'vue'
import { gridTemplate } from '../../../shared/defaults'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
export function leaves(node: GridNode): GridLeaf[] {
  return node.type === 'leaf' ? [node] : node.children.flatMap(leaves)
}

export function useEditorGrid(state: Ref<Composition>) {
  const selected = ref<string[]>([])
  interface GridHistory {
    grid: GridNode
    order: string[]
  }
  const history = ref<GridHistory[]>([])
  const future = ref<GridHistory[]>([])
  const capacity = computed(() =>
    state.value.layout === 'grid' ? leaves(state.value.grid).length : 4,
  )
  function snapshotGrid(): GridHistory {
    return {
      grid: clone(state.value.grid),
      order: state.value.panels.map(p => p.photoId),
    }
  }
  function orderPanels(order: string[]) {
    state.value.panels.sort((a, b) => {
      const rank = (id: string) => {
        const index = order.indexOf(id)
        return index < 0 ? order.length : index
      }
      return rank(a.photoId) - rank(b.photoId)
    })
  }
  function syncPool() {
    orderPanels(
      leaves(state.value.grid).flatMap(l => (l.photoId ? [l.photoId] : [])),
    )
  }
  function checkpoint() {
    history.value.push(snapshotGrid())
    if (history.value.length > 80)
      history.value.shift()
    future.value = []
  }
  function undo() {
    const grid = history.value.pop()
    if (grid) {
      future.value.push(snapshotGrid())
      state.value.grid = grid.grid
      orderPanels(grid.order)
      selected.value = []
    }
  }
  function redo() {
    const grid = future.value.pop()
    if (grid) {
      history.value.push(snapshotGrid())
      state.value.grid = grid.grid
      orderPanels(grid.order)
      selected.value = []
    }
  }
  function fillGrid() {
    const used = new Set(leaves(state.value.grid).map(l => l.photoId))
    const available = state.value.panels.filter(p => !used.has(p.photoId))
    for (const leaf of leaves(state.value.grid)) {
      if (!leaf.photoId)
        leaf.photoId = available.shift()?.photoId ?? null
    }
  }
  function reorder(from: string, to: string) {
    const list = state.value.panels
    const a = list.findIndex(p => p.photoId === from)
    const b = list.findIndex(p => p.photoId === to)
    if (a < 0 || b < 0 || a === b)
      return
    checkpoint()
    list.splice(b, 0, list.splice(a, 1)[0]!)
    const ids = list.map(p => p.photoId)
    for (const l of leaves(state.value.grid)) {
      if (l.photoId)
        l.photoId = ids.shift() ?? null
    }
  }
  function template(name: string) {
    checkpoint()
    state.value.grid = gridTemplate(
      name,
      state.value.panels.map(p => p.photoId),
    )
    selected.value = []
  }
  function replaceNode(
    node: GridNode,
    id: string,
    replacement: GridNode | null,
  ): GridNode | null {
    if (node.id === id)
      return replacement
    if (node.type === 'leaf')
      return node
    node.children = node.children
      .map(n => replaceNode(n, id, replacement))
      .filter((n): n is GridNode => !!n)
    if (node.children.length === 1)
      return node.children[0]!
    if (!node.children.length)
      return null
    if (node.weights.length !== node.children.length)
      node.weights = node.children.map(() => 1 / node.children.length)
    return node
  }
  function split(axis: 'horizontal' | 'vertical', before = false) {
    const leaf = leaves(state.value.grid).find(
      l => l.id === selected.value[0],
    )
    if (!leaf)
      return
    checkpoint()
    const empty: GridLeaf = {
      id: crypto.randomUUID(),
      type: 'leaf',
      photoId: null,
    }
    state.value.grid = replaceNode(state.value.grid, leaf.id, {
      id: crypto.randomUUID(),
      type: 'split',
      axis,
      weights: [0.5, 0.5],
      children: before ? [empty, clone(leaf)] : [clone(leaf), empty],
    })!
  }
  function clearCells() {
    checkpoint()
    for (const l of leaves(state.value.grid)) {
      if (selected.value.includes(l.id))
        l.photoId = null
    }
    syncPool()
  }
  function deleteCells() {
    if (leaves(state.value.grid).length <= selected.value.length)
      return
    checkpoint()
    for (const id of selected.value) {
      state.value.grid = replaceNode(state.value.grid, id, null) ?? {
        id: crypto.randomUUID(),
        type: 'leaf',
        photoId: null,
      }
    }
    selected.value = []
    syncPool()
  }
  function swap(a: string, b: string) {
    const list = leaves(state.value.grid)
    const x = list.find(l => l.id === a)
    const y = list.find(l => l.id === b)
    if (!x || !y)
      return
    checkpoint();
    [x.photoId, y.photoId] = [y.photoId, x.photoId]
    syncPool()
  }
  const mergeParent = computed(() => {
    function find(node: GridNode): Extract<GridNode, { type: 'split' }> | null {
      if (node.type === 'leaf')
        return null
      const indices = node.children.flatMap((child, index) =>
        child.type === 'leaf' && selected.value.includes(child.id)
          ? [index]
          : [],
      )
      if (
        indices.length > 1
        && indices.length === selected.value.length
        && indices.at(-1)! - indices[0]! + 1 === indices.length
      ) {
        return node
      }
      return node.children.map(find).find(Boolean) ?? null
    }
    return find(state.value.grid)
  })
  function merge() {
    const parent = mergeParent.value
    if (!parent)
      return
    checkpoint()
    const firstIndex = parent.children.findIndex(child =>
      selected.value.includes(child.id),
    )
    const children = parent.children.slice(
      firstIndex,
      firstIndex + selected.value.length,
    )
    const first = children.flatMap(leaves).find(leaf => leaf.photoId)
    const merged: GridLeaf = {
      id: crypto.randomUUID(),
      type: 'leaf',
      photoId: first?.photoId ?? null,
    }
    const weight = parent.weights
      .slice(firstIndex, firstIndex + children.length)
      .reduce((a, b) => a + b, 0)
    parent.children.splice(firstIndex, children.length, merged)
    parent.weights.splice(firstIndex, children.length, weight)
    if (parent.children.length === 1)
      state.value.grid = replaceNode(state.value.grid, parent.id, merged)!
    selected.value = [merged.id]
    syncPool()
  }
  function addTrack(axis: 'horizontal' | 'vertical', before: boolean) {
    checkpoint()
    const leaf: GridLeaf = {
      id: crypto.randomUUID(),
      type: 'leaf',
      photoId: null,
    }
    state.value.grid = {
      id: crypto.randomUUID(),
      type: 'split',
      axis,
      children: before ? [leaf, state.value.grid] : [state.value.grid, leaf],
      weights: before ? [0.25, 0.75] : [0.75, 0.25],
    }
    selected.value = [leaf.id]
  }
  return {
    selected,
    history,
    future,
    capacity,
    mergeParent,
    fillGrid,
    reorder,
    template,
    split,
    clearCells,
    addTrack,
    deleteCells,
    swap,
    merge,
    checkpoint,
    undo,
    redo,
  }
}
