/**
 * 渲染错误边界：一处组件抛错不能连带卸掉整块面板。
 *
 * 为什么放 `.ts` 而不是 `.tsx`：这里没有一处 JSX，纯 `createElement`；
 * 放在 `.ts` 里才能被 `node --test` 直接 import（Node 的类型剥离不认 `.tsx`），
 * 于是「抛错后兄弟节点还在、兜底文案出来了」可以有单测，而不是只能靠 E2E 猜。
 */
import { Component, createElement as h, type ErrorInfo, type ReactNode } from 'react'

interface BoundaryState {
  error?: Error
}

export class ErrorBoundary extends Component<
  { fallback: (error: Error) => ReactNode; children?: ReactNode },
  BoundaryState
> {
  state: BoundaryState = { error: undefined }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  // 保留钩子：将来要上报，从这一处接；现在不上报，也不往宿主控制台写上游内容。
  componentDidCatch(_error: Error, _info: ErrorInfo): void {}

  render(): ReactNode {
    const { error } = this.state
    return error ? this.props.fallback(error) : this.props.children
  }
}
