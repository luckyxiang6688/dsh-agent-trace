/**
 * 工单 ↔ 执行器会话的命名约定。
 *
 * 上游（`vendor/dsh-superagent/src/executor/dsh.ts:24`）不存外键，只按名字约定关联：
 * 工单 `<ticketId>` 的执行器会话就叫 `worker-<ticketId>`。这里做成唯一实现，
 * 各视图都从这里 import，避免将来上游改名时各拼一份字符串而漂移。
 */
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
