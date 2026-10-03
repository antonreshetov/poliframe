import type { Ref } from 'vue'
import type {
  GridNode,
  LayoutResult,
  PreviewResult,
} from '../../../shared/contracts'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { leaves, useEditorContext } from '../useEditor'

interface GridResizeContext {
  layout: Readonly<Ref<LayoutResult | undefined>>
  scale: Readonly<Ref<number>>
  draftGrid: Ref<GridNode | null>
  dragBacking: Ref<PreviewResult | null>
  resizing: Ref<boolean>
}

export function useGridResize({
  layout,
  scale,
  draftGrid,
  dragBacking,
  resizing,
}: GridResizeContext) {
  const e = useEditorContext()
  let finishResize: (() => void) | undefined
  onUnmounted(() => finishResize?.())
  const dividers = computed(() => {
    if (e.state.layout !== 'grid' || !layout.value)
      return []
    const result: {
      node: Extract<GridNode, { type: 'split' }>
      index: number
      x: number
      y: number
      width: number
      height: number
      span: number
      containerStart: number
      pairLength: number
    }[] = []
    function walk(node: GridNode) {
      if (node.type === 'leaf')
        return
      const group = leaves(node)
        .map(l => layout.value!.cells.find(c => c.id === l.id))
        .filter(c => !!c)
      if (!group.length)
        return
      const x = Math.min(...group.map(c => c.x))
      const y = Math.min(...group.map(c => c.y))
      const right = Math.max(...group.map(c => c.x + c.width))
      const bottom = Math.max(...group.map(c => c.y + c.height))
      for (let i = 0; i < node.children.length - 1; i++) {
        const before = leaves(node.children[i]!)
          .map(l => layout.value!.cells.find(c => c.id === l.id))
          .filter(c => !!c)
        const after = leaves(node.children[i + 1]!)
          .map(l => layout.value!.cells.find(c => c.id === l.id))
          .filter(c => !!c)
        if (!before.length || !after.length)
          continue
        const horizontal = node.axis === 'horizontal'
        const position = horizontal
          ? (Math.max(...before.map(c => c.x + c.width))
            + Math.min(...after.map(c => c.x)))
          / 2
          : (Math.max(...before.map(c => c.y + c.height))
            + Math.min(...after.map(c => c.y)))
          / 2
        result.push({
          node,
          index: i,
          x: horizontal ? position : x,
          y: horizontal ? y : position,
          width: horizontal ? 0 : right - x,
          height: horizontal ? bottom - y : 0,
          span: horizontal ? right - x : bottom - y,
          containerStart: horizontal ? x : y,
          pairLength: horizontal
            ? Math.max(...before.map(c => c.x + c.width))
            - Math.min(...before.map(c => c.x))
            + Math.max(...after.map(c => c.x + c.width))
            - Math.min(...after.map(c => c.x))
            : Math.max(...before.map(c => c.y + c.height))
              - Math.min(...before.map(c => c.y))
              + Math.max(...after.map(c => c.y + c.height))
              - Math.min(...after.map(c => c.y)),
        })
      }
      node.children.forEach(walk)
    }
    walk(draftGrid.value ?? e.state.grid)
    return result
  })
  type Divider = (typeof dividers.value)[number]
  const dividerFeedback = ref<{
    horizontal: boolean
    position: number
    lo: number
    hi: number
    percent?: number
    x?: number
    y?: number
    snapped?: boolean
  } | null>(null)
  function showDivider(items: Divider[], position: number) {
    const horizontal = items[0]!.node.axis === 'horizontal'
    dividerFeedback.value = {
      horizontal,
      position,
      lo: Math.min(...items.map(item => (horizontal ? item.y : item.x))),
      hi: Math.max(
        ...items.map(item =>
          horizontal ? item.y + item.height : item.x + item.width,
        ),
      ),
    }
  }
  let lastDividerHover: { event: PointerEvent, divider: Divider } | undefined
  function leaveDivider() {
    lastDividerHover = undefined
    if (!resizing.value)
      dividerFeedback.value = null
  }
  function modifierChanged(event: KeyboardEvent) {
    if (lastDividerHover) {
      hoverDivider(
        {
          clientX: lastDividerHover.event.clientX,
          clientY: lastDividerHover.event.clientY,
          currentTarget: lastDividerHover.event.currentTarget,
          altKey: event.altKey,
        } as PointerEvent,
        lastDividerHover.divider,
      )
    }
  }
  onMounted(() => {
    window.addEventListener('keydown', modifierChanged)
    window.addEventListener('keyup', modifierChanged)
  })
  onUnmounted(() => {
    window.removeEventListener('keydown', modifierChanged)
    window.removeEventListener('keyup', modifierChanged)
  })
  function hoverDivider(event: PointerEvent, divider: Divider) {
    if (resizing.value)
      return
    lastDividerHover = {
      event: {
        clientX: event.clientX,
        clientY: event.clientY,
        currentTarget: event.currentTarget,
      } as PointerEvent,
      divider,
    }
    const horizontal = divider.node.axis === 'horizontal'
    const position = horizontal ? divider.x : divider.y
    showDivider(
      event.altKey
        ? [divider]
        : dividers.value.filter(
            item =>
              item.node.axis === divider.node.axis
              && Math.abs((horizontal ? item.x : item.y) - position)
              < (horizontal ? layout.value!.width : layout.value!.height)
              * 0.002,
          ),
      position,
    )
    const rows = divider.node.children.slice(divider.index, divider.index + 2)
    const first = rows[0]
    const second = rows[1]
    if (
      event.altKey
      && first?.type === 'split'
      && second?.type === 'split'
      && first.axis !== divider.node.axis
      && first.axis === second.axis
      && first.weights.length === second.weights.length
      && first.weights.every(
        (weight, i) =>
          Math.abs(
            weight / first.weights.reduce((a, b) => a + b, 0)
            - second.weights[i]! / second.weights.reduce((a, b) => a + b, 0),
          ) <= 0.000001,
      )
    ) {
      const bounds = (
        event.currentTarget as HTMLElement
      ).parentElement!.getBoundingClientRect()
      const cross = horizontal
        ? (event.clientY - bounds.top) / scale.value
        : (event.clientX - bounds.left) / scale.value
      const start = horizontal ? divider.y : divider.x
      const span = horizontal ? divider.height : divider.width
      const total = first.weights.reduce((a, b) => a + b, 0)
      let lo = start
      for (const [index, weight] of first.weights.entries()) {
        const hi = lo + (span * weight) / total
        if (cross <= hi || index === first.weights.length - 1) {
          dividerFeedback.value = { horizontal, position, lo, hi }
          break
        }
        lo = hi
      }
    }
  }
  function resize(
    event: PointerEvent,
    divider: (typeof dividers.value)[number],
  ) {
    event.stopPropagation()
    event.preventDefault()
    if (!e.preview)
      return
    dragBacking.value = e.preview
    draftGrid.value = JSON.parse(JSON.stringify(e.state.grid))
    divider = dividers.value.find(
      item =>
        item.node.id === divider.node.id && item.index === divider.index,
    )!
    resizing.value = true
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    const horizontal = divider.node.axis === 'horizontal'
    let active = divider
    if (event.altKey) {
      const parent = divider.node
      const rows = parent.children.slice(divider.index, divider.index + 2)
      const first = rows[0]
      if (
        first?.type === 'split'
        && first.axis !== parent.axis
        && rows.every(
          row =>
            row.type === 'split'
            && row.axis === first.axis
            && row.children.length === first.children.length
            && row.weights.every(
              (w, i) =>
                Math.abs(
                  w / row.weights.reduce((a, b) => a + b, 0)
                  - first.weights[i]!
                  / first.weights.reduce((a, b) => a + b, 0),
                ) <= 0.000001,
            ),
        )
      ) {
        const oldAxis = parent.axis
        const oldWeights = parent.weights.slice(
          divider.index,
          divider.index + 2,
        )
        const columns = first.children.map((_, index): GridNode => ({
          id: crypto.randomUUID(),
          type: 'split',
          axis: oldAxis,
          weights: [...oldWeights],
          children: rows.map(row =>
            row.type === 'split' ? row.children[index]! : row,
          ),
        }))
        const bounds = target.parentElement!.getBoundingClientRect()
        const cross = horizontal
          ? (event.clientY - bounds.top) / scale.value
          : (event.clientX - bounds.left) / scale.value
        const start = horizontal ? divider.y : divider.x
        const span = horizontal ? divider.height : divider.width
        const total = first.weights.reduce((a, b) => a + b, 0)
        let accumulated = 0
        const column = first.weights.findIndex((weight) => {
          accumulated += weight / total
          return cross <= start + accumulated * span
        })
        if (parent.children.length === 2) {
          parent.axis = first.axis
          parent.children = columns
          parent.weights = [...first.weights]
        }
        else {
          parent.children.splice(divider.index, 2, {
            id: crypto.randomUUID(),
            type: 'split',
            axis: first.axis,
            children: columns,
            weights: [...first.weights],
          })
          parent.weights.splice(
            divider.index,
            2,
            oldWeights[0]! + oldWeights[1]!,
          )
        }
        active = dividers.value.find(
          item =>
            item.node.id === columns[Math.max(0, column)]!.id
            && item.index === 0,
        )!
      }
    }
    const candidates = event.altKey
      ? [active]
      : dividers.value.filter(
          item =>
            item.node.axis === divider.node.axis
            && Math.abs(
              (horizontal ? item.x : item.y)
              - (horizontal ? divider.x : divider.y),
            )
            < (horizontal ? layout.value!.width : layout.value!.height) * 0.002,
        )
    const position = horizontal ? active.x : active.y
    const existingLines = dividers.value
      .filter(item => item.node.axis === active.node.axis)
      .map(item => (horizontal ? item.x : item.y))
      .filter(
        line =>
          Math.abs(line - position)
          > (horizontal ? layout.value!.width : layout.value!.height) * 0.002,
      )
    const initial = candidates.map((item) => {
      const weights = [...item.node.weights]
      const pair = weights[item.index]! + weights[item.index + 1]!
      const origin
        = (horizontal ? item.x : item.y)
          - (item.pairLength * weights[item.index]!) / pair
      return { item, pair, origin }
    })
    const first = initial[0]!
    const targets = [
      ...[1 / 3, 0.5, 2 / 3].map(
        f => first.origin + first.item.pairLength * f,
      ),
      ...Array.from(
        {
          length:
            active.node.children.length > 2
              ? active.node.children.length - 1
              : 0,
        },
        (_, i) =>
          active.containerStart
          + (active.span * (i + 1)) / active.node.children.length,
      ),
      ...existingLines,
    ]
    let snapped: number | undefined
    const start = horizontal ? event.clientX : event.clientY
    showDivider(candidates, position)
    const bounds = target.parentElement?.getBoundingClientRect() ?? {
      left: 0,
      top: 0,
    }
    const applyMove = (ev: PointerEvent) => {
      let next
        = position
          + ((horizontal ? ev.clientX : ev.clientY) - start) / scale.value
      if (!ev.metaKey) {
        if (snapped !== undefined && Math.abs(snapped - next) * scale.value > 9)
          snapped = undefined
        if (snapped === undefined) {
          snapped = targets
            .slice()
            .sort((a, b) => Math.abs(a - next) - Math.abs(b - next))
            .find(value => Math.abs(value - next) * scale.value <= 6)
        }
        next
          = snapped
            ?? first.origin
            + (Math.round(((next - first.origin) / first.item.pairLength) * 100)
              / 100)
            * first.item.pairLength
      }
      else {
        snapped = undefined
      }
      const lo = Math.max(
        ...initial.map(({ item, origin }) => origin + item.pairLength * 0.1),
      )
      const hi = Math.min(
        ...initial.map(({ item, origin }) => origin + item.pairLength * 0.9),
      )
      const clamped = Math.max(lo, Math.min(hi, next))
      if (clamped !== next)
        snapped = undefined
      next = clamped
      for (const { item, pair, origin } of initial) {
        const fraction = (next - origin) / item.pairLength
        item.node.weights[item.index] = fraction * pair
        item.node.weights[item.index + 1] = (1 - fraction) * pair
      }
      dividerFeedback.value = {
        ...dividerFeedback.value!,
        position: next,
        snapped: snapped !== undefined,
        percent: Math.round(
          ((next - first.origin) / first.item.pairLength) * 100,
        ),
        x: ev.clientX - bounds.left + 14,
        y: ev.clientY - bounds.top + 16,
      }
    }
    let frame = 0
    let pending: PointerEvent | undefined
    let changed = false
    const move = (ev: PointerEvent) => {
      pending = ev
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0
          if (pending) {
            applyMove(pending)
            changed = true
            pending = undefined
          }
        })
      }
    }
    let ended = false
    const end = (ev?: PointerEvent) => {
      if (ended)
        return
      ended = true
      cancelAnimationFrame(frame)
      if (pending && ev?.type !== 'pointercancel') {
        applyMove(pending)
        changed = true
      }
      window.removeEventListener('pointermove', move, true)
      target.removeEventListener('pointerup', end)
      target.removeEventListener('pointercancel', end)
      window.removeEventListener('pointerup', end, true)
      window.removeEventListener('pointercancel', end, true)
      finishResize = undefined
      resizing.value = false
      dividerFeedback.value = null
      lastDividerHover = undefined
      if (ev?.type === 'pointerup' && changed && draftGrid.value) {
        e.checkpoint()
        e.state.grid = JSON.parse(JSON.stringify(draftGrid.value))
      }
      else {
        draftGrid.value = null
        dragBacking.value = null
      }
    }
    finishResize = end
    window.addEventListener('pointerup', end, true)
    window.addEventListener('pointercancel', end, true)
    window.addEventListener('pointermove', move, true)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
  }

  return { dividers, dividerFeedback, hoverDivider, leaveDivider, resize }
}
