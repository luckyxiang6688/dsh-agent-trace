/**
 * 界面上的短标签。抽成纯函数是为了能被 `node --test` 直接 import：
 * 组件文件是 `.tsx`，Node 的类型剥离不认这个扩展名（ERR_UNKNOWN_FILE_EXTENSION），
 * 一行字符串拼接若留在组件里，就只能靠肉眼或整套 E2E 才能验。
 */

/** 关联工单按钮上的文案：`标题 · 短 id`，跨来源时补 ` · 来源 X`。 */
export function relatedTicketLabel(
  ticket: { readonly title?: string; readonly ticketId: string; readonly source?: string },
  currentSource: string,
): string {
  const base = `${ticket.title ?? '工单'} · ${ticket.ticketId.slice(0, 8)}`
  // 跨来源才标：左栏按来源过滤，不标会让人以为它在当前来源下。
  return ticket.source && ticket.source !== currentSource ? `${base} · 来源 ${ticket.source}` : base
}
