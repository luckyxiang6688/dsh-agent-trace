/**
 * 左栏两区之间的横线。拖拽用 pointer capture（指针滑出去也继续跟手），
 * 位移按 rAF 合并——每像素都 setState 会让整个来源页跟着重渲染。
 */
import { createElement as h, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { MAX_RATIO, MIN_RATIO, clampRatio, ratioFromPointer } from './split.ts'
import { styles } from './styles.ts'

export function Splitter(props: {
  ratio: number
  /** 左栏整体的可视矩形；由 Rail 提供，别在这里再套一层 ref。 */
  measure: () => DOMRect | null
  onChange: (ratio: number) => void
  /** 松手/键盘调整后才写存储：拖拽中途不写，避免上百次 localStorage 写入。 */
  onCommit: (ratio: number) => void
}): ReturnType<typeof h> {
  const [dragging, setDragging] = useState(false)
  const latest = useRef(props.ratio)
  const frame = useRef(0)

  const cancelFrame = () => {
    if (!frame.current) return
    cancelAnimationFrame(frame.current)
    frame.current = 0
  }

  const ratioAt = (clientY: number): number => {
    const box = props.measure()
    if (!box) return props.ratio
    return ratioFromPointer(clientY, box.top, box.height)
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    // 合成事件（E2E）里的 pointerId 不是活动指针，capture 会抛 NotFoundError；
    // 抓不到也照常拖，只是指针滑出元素后可能丢事件。
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* 忽略 */ }
    latest.current = props.ratio
    setDragging(true)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    latest.current = ratioAt(event.clientY)
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      props.onChange(latest.current)
    })
  }

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setDragging(false)
    cancelFrame()
    try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch { /* 没抓到过就不必放 */ }
    props.onChange(latest.current)
    props.onCommit(latest.current)
  }

  // 键盘也要能调：拖拽对没法用指针的人等于不存在。
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const next = clampRatio(props.ratio + (event.key === 'ArrowDown' ? 0.02 : -0.02))
    props.onChange(next)
    props.onCommit(next)
  }

  return h('div', {
    'data-splitter': '1',
    role: 'separator',
    'aria-orientation': 'horizontal',
    'aria-valuenow': Math.round(props.ratio * 100),
    // 与夹取常量同源：常量改了，无障碍读数不能撒谎。
    'aria-valuemin': Math.round(MIN_RATIO * 100),
    'aria-valuemax': Math.round(MAX_RATIO * 100),
    'aria-label': '调整来源与工单两区高度',
    tabIndex: 0,
    title: '拖动调整两区高度（或用 ↑ ↓）',
    style: styles.railSplit,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onKeyDown,
  },
    h('span', { style: { ...styles.railSplitBar, ...(dragging ? styles.railSplitOn : {}) } }))
}
