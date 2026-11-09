# 第二来源夹具（静态）

`fixture.ts` 每次调用 `writeFixture(root)` 重建一套**真实形状**的上游数据：

- `<root>/state/superagent/orchestrator.sqlite`：`kv / trigger / disposition / thread / ticket / decision / outbox`，字段与线上一致，全部是 `value` 列里的 JSON。
- `<root>/sessions/ws/<sessionId>/session.v4.jsonl.zstd`：多帧 zstd（header 一帧、每条事件一帧），与线上一样的写法。

## 这个来源和 demo 的差别（全部在数据里，不在代码里）

| 维度 | demo | `fixture` |
|---|---|---|
| 回复通道 | 声明 `channel` | **没有**：`ticket.channels = []`，自动确认不发、回复无处可发 |
| 点名 | `addressed:'direct'` | `addressed:'mention'`（@ 提及，同样算点名） |
| 触发 | 单条 | batch 两条（`tr-b1`、`tr-b2` 合成一张工单） |
| 知会 | 无 | `tr-ctx`：`disposition.context`，只作上下文 |
| 丢弃 | 无 | `tr-filtered`：`filtered:{code:'no_mention'}` |
| 状态过程 | 无受阻 | blocked@30s → 人跟进@35s → `retried` → 新派工@40s → ready@80s → 结束@95s |
| 子代理 | 有 | 有（`child-fixture`，`origin:'subagent'`） |

## 断言了什么

`plugin/tests/generic-source.test.ts` 用这套夹具跑完整读取链路（adapter → reader → presenter），断言：

1. 来源名就是数据里的 id（`fixture`），没有中文硬编码表。
2. `canReply === false` 时不画确认/回复箭头。
3. 状态带按时刻切段：`queued → working → blocked → working → queued → working → review → ended`。
4. `context`（仅上下文）与 `direct`（订阅直通）是两类，不混算。
5. `mention` 也算点名，不能显示成「未点名」。
6. 元素数量由数据决定：2 支事件、2 条直通、2 次派工，子代理挂在执行器列。
7. 工具返回带 `error` 时挂回那次调用并标失败，错误原因不丢。
8. 离散事件（`event-retry-a2`）从领域表拿事实，不读会话日志。

## 覆盖边界（诚实说明）

静态夹具能表达**任意**组合，所以 batch / context-only / blocked→retry 都在这里覆盖。

真机 `fixture-source` 插件（`/fixture-source/index.js`）只能稳定复现来源侧能决定的部分：无回复通道、点名建单、订阅直通、未点名判 `no_mention`。
**batch 要不要合、context-only 要不要跟、blocked 之后会不会重试，都由主控模型的行为决定**，写不进确定性的端到端断言——那种用例留在本文件这套静态夹具里。
