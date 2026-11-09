/**
 * Esc 只有一个监听器、一个栈（D-36）。
 *
 * 为什么不能每个组件各自 `addEventListener('keydown')`：抽屉套覆盖层时
 * 一个 Esc 会把两层一起关掉，顺序取决于监听器的注册先后，是不可测的。
 * 栈保证「最后打开的先关」，且同一个 Esc 只消费一次。
 */
type Closer = () => void

const stack: Closer[] = []
let installed = false

/** 只弹栈顶。返回是否消费了这次 Esc（空栈 → false，交给别人处理）。 */
export function handleEscape(): boolean {
  const top = stack[stack.length - 1]
  if (!top) return false
  top()
  return true
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (!handleEscape()) return
  // capture 阶段就停住：别让宿主的同名快捷键（退出全屏/关面板）跟着一起响。
  event.stopPropagation()
}

function install(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('keydown', onKeyDown, true)
}

/**
 * 压一个「关掉我」的动作。返回取消函数：幂等，重复调用不会误删别人的条目。
 * 组件卸载时必须调用它——否则关掉的抽屉还挂在栈上，Esc 会被吃掉。
 */
export function pushEscape(close: Closer): () => void {
  install()
  stack.push(close)
  return () => {
    const index = stack.lastIndexOf(close)
    if (index >= 0) stack.splice(index, 1)
  }
}

/** 测试用：清空栈。监听器本身幂等，不重复安装。 */
export function resetEscapeStack(): void {
  stack.length = 0
}

export function escapeDepth(): number {
  return stack.length
}
