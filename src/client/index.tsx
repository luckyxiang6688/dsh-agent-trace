/** 客户端入口：向 DSH 注册一个侧边栏条目 + 一个主页面。 */
import { apply as mount } from './mount.tsx'

export const name = 'dsh-superagent-trace'
export const inject = ['slots']
export function apply(ctx: Parameters<typeof mount>[0]): void {
  mount(ctx)
}
