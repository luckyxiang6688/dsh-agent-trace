import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
//#region src/adapter/superagent/db.ts
/**
* superagent 的私有契约只出现在这个文件里（P2）。
* 任何表名、列名、字段路径的变化都只改这里；上层只见 domain 类型。
*/
/** 只读句柄。打开失败返回 undefined，由调用方降级。 */
function openStore(stateDir) {
	try {
		return new SqliteStore(stateDir);
	} catch {
		return;
	}
}
var SqliteStore = class {
	db;
	constructor(stateDir) {
		this.db = new DatabaseSync(`${stateDir}/orchestrator.sqlite`, { readOnly: true });
	}
	tickets(limit) {
		return this.rows("select value from ticket order by rowid desc limit ?", limit);
	}
	ticketsBySource(source, limit) {
		return this.rows("select t.value from ticket t join trigger g on json_valid(t.value) and json_valid(g.value) and g.id = json_extract(t.value, '$.origin.triggerId') where json_valid(t.value) and json_extract(g.value, '$.source') = ? order by t.rowid desc limit ?", source, limit);
	}
	ticket(id) {
		return this.rows("select value from ticket where id = ?", id)[0];
	}
	outbox(ticketId) {
		return this.rows("select value from outbox order by rowid").filter((item) => item.ticketId === ticketId);
	}
	triggers() {
		return this.rows("select value from trigger order by rowid");
	}
	decisions() {
		return this.rows("select value from decision order by rowid");
	}
	dispositions() {
		return this.rowsWithId("select id, value from disposition order by rowid");
	}
	threads() {
		return this.rows("select value from thread order by rowid");
	}
	trigger(id) {
		return this.rows("select value from trigger where id = ?", id)[0];
	}
	disposition(id) {
		return this.rowsWithId("select id, value from disposition where id = ?", id)[0];
	}
	thread(key) {
		return this.rows("select value from thread where key = ?", key)[0];
	}
	sourceAggregates() {
		const out = [];
		for (const row of this.db.prepare("select json_extract(value, '$.source') as source, count(*) as n, max(at) as lastAt from trigger where json_extract(value, '$.source') is not null group by source").all()) {
			if (typeof row.source !== "string") continue;
			out.push({
				source: row.source,
				received: typeof row.n === "number" ? row.n : Number(row.n ?? 0),
				...typeof row.lastAt === "string" ? { lastAt: row.lastAt } : {}
			});
		}
		return out;
	}
	dispositionSources() {
		const out = [];
		for (const row of this.db.prepare("select d.id as id, d.value as dv, t.value as tv from disposition d join trigger t on t.id = d.id").all()) {
			if (typeof row.id !== "string" || typeof row.dv !== "string" || typeof row.tv !== "string") continue;
			try {
				const source = JSON.parse(row.tv).source;
				if (typeof source !== "string") continue;
				out.push({
					source,
					disposition: {
						id: row.id,
						...JSON.parse(row.dv)
					}
				});
			} catch {}
		}
		return out;
	}
	ticketIndex() {
		const out = [];
		for (const row of this.db.prepare("select t.id as id, json_extract(t.value, '$.title') as title, json_extract(t.value, '$.origin.triggerId') as originTriggerId, json_extract(g.value, '$.source') as source from ticket t left join trigger g on g.id = json_extract(t.value, '$.origin.triggerId')").all()) {
			if (typeof row.id !== "string") continue;
			out.push({
				id: row.id,
				...typeof row.title === "string" ? { title: row.title } : {},
				...typeof row.originTriggerId === "string" ? { originTriggerId: row.originTriggerId } : {},
				...typeof row.source === "string" ? { source: row.source } : {}
			});
		}
		return out;
	}
	decisionsOfTrigger(triggerId) {
		return this.rows("select value from decision d where exists (select 1 from json_each(d.value, '$.triggerIds') j where j.value = ?)", triggerId);
	}
	sourceEventRows(source, limit, before) {
		if (before?.at) return this.rows("select value from trigger where json_extract(value, '$.source') = ? and (at < ? or (at = ? and id < ?)) order by at desc, id desc limit ?", source, before.at, before.at, before.id, limit);
		return this.rows("select value from trigger where json_extract(value, '$.source') = ? order by at desc, id desc limit ?", source, limit);
	}
	configuredSources() {
		const found = /* @__PURE__ */ new Map();
		const add = (source, enabled) => {
			if (typeof source !== "string" || !source) return;
			const state = typeof enabled === "boolean" ? enabled : void 0;
			found.set(source, found.get(source) ?? state);
		};
		for (const snapshot of this.settingsSnapshots()) {
			for (const [source, instance] of Object.entries(snapshot.settings?.sources ?? {})) add(source, instance?.enabled);
			for (const source of Object.keys(snapshot.settings?.policy?.sources ?? {})) add(source);
		}
		for (const row of this.db.prepare("select key from kv where key like 'settings-block-revision:source:%'").all()) {
			if (typeof row.key !== "string") continue;
			add(row.key.slice(31));
		}
		return [...found].map(([source, enabled]) => ({
			source,
			...enabled === void 0 ? {} : { enabled }
		})).sort((left, right) => left.source.localeCompare(right.source));
	}
	settingsSnapshots() {
		const out = [];
		for (const row of this.db.prepare("select key, value from kv where key like 'settings-version:%'").all()) {
			if (typeof row.key !== "string" || typeof row.value !== "string") continue;
			try {
				const snapshot = JSON.parse(row.value);
				const fromKey = Number(row.key.slice(17));
				const revision = typeof snapshot.revision === "number" ? snapshot.revision : Number.isFinite(fromKey) ? fromKey : 0;
				out.push({
					revision,
					snapshot
				});
			} catch {}
		}
		return out.sort((left, right) => right.revision - left.revision).map((item) => item.snapshot);
	}
	sourceLabels(source) {
		const value = this.kv(`source-labels:${source}`);
		if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
		const out = {};
		for (const [key, label] of Object.entries(value)) if (typeof label === "string" && label) out[key] = label;
		return Object.keys(out).length > 0 ? out : void 0;
	}
	kv(key) {
		for (const row of this.db.prepare("select value from kv where key = ?").all(key)) {
			if (typeof row.value !== "string") continue;
			try {
				return JSON.parse(row.value);
			} catch {
				return;
			}
		}
	}
	close() {
		try {
			this.db.close();
		} catch {}
	}
	/** 带主键的行：disposition 的 id 就是 trigger id，需要它来关联原文。 */
	rowsWithId(sql, ...args) {
		const out = [];
		for (const row of this.all(sql, args)) {
			if (typeof row?.value !== "string" || typeof row?.id !== "string") continue;
			try {
				out.push({
					id: row.id,
					...JSON.parse(row.value)
				});
			} catch {}
		}
		return out;
	}
	/** 行里存的是 JSON 文本；解析失败的行直接跳过，不让一行坏数据毁掉整次读取。 */
	rows(sql, ...args) {
		const out = [];
		for (const row of this.all(sql, args)) {
			if (typeof row?.value !== "string") continue;
			try {
				out.push(JSON.parse(row.value));
			} catch {}
		}
		return out;
	}
	/** 无参数时走全量查询，有参数时按位置绑定；调用方用空数组表示「不带参数」。 */
	all(sql, args) {
		const statement = this.db.prepare(sql);
		return args.length === 0 ? statement.all() : statement.all(...args);
	}
};
//#endregion
//#region src/service/health.ts
/**
* 存储探测：句柄能开、能读一个最廉价的键，就算可用。
*
* `close()` 必须在 `finally` 里：缺 kv 表、文件损坏、瞬时锁都会让 `kv()` 抛，
* 而 `/health` 恰恰是故障时被高频轮询的接口——漏一个句柄就会把 fd 攒满，
* 反过来影响宿主（违背 P4「任何失败都不得影响宿主」）。有单测钉住这条路径。
*/
function storeProbe(open) {
	return () => {
		const started = Date.now();
		let store;
		try {
			store = open();
			if (!store) return {
				ok: false,
				ms: Date.now() - started,
				error: "store unavailable"
			};
			store.kv("master-id");
			return {
				ok: true,
				ms: Date.now() - started
			};
		} catch (error) {
			return {
				ok: false,
				ms: Date.now() - started,
				error: String(error).slice(0, 120)
			};
		} finally {
			store?.close();
		}
	};
}
function createHealth(now = Date.now, probe) {
	const startedAt = now();
	const routes = /* @__PURE__ */ new Map();
	return {
		record(route, ms, ok) {
			const stat = routes.get(route) ?? {
				count: 0,
				errors: 0,
				lastMs: 0,
				maxMs: 0
			};
			stat.count += 1;
			stat.errors += ok ? 0 : 1;
			stat.lastMs = Math.round(ms);
			stat.maxMs = Math.max(stat.maxMs, Math.round(ms));
			routes.set(route, stat);
		},
		snapshot() {
			let store;
			if (probe) try {
				store = probe();
			} catch (error) {
				store = {
					ok: false,
					ms: 0,
					error: String(error).slice(0, 120)
				};
			}
			const entries = Object.fromEntries(routes);
			return {
				ok: store ? store.ok : true,
				uptimeMs: now() - startedAt,
				errors: Object.values(entries).reduce((sum, stat) => sum + stat.errors, 0),
				routes: entries,
				...store ? { store } : {}
			};
		}
	};
}
/**
* 把 URL 路径压成一个固定标签：`/sources/fixture/events/tr-1` → `/sources/:source/events/:id`。
* 计数按模板聚合，否则每个 id 一条，既读不出趋势，也会让快照随流量膨胀。
*/
function routeLabel(path) {
	if (path === "/chains" || path === "/sources" || path === "/health" || path === "/status") return path;
	if (path === "/translate") return path;
	if (path.startsWith("/sources/")) {
		const parts = path.split("/");
		if (parts[3] === "events" && parts.length === 4) return "/sources/:source/events";
		if (parts[3] === "events" && parts.length === 5) return "/sources/:source/events/:id";
		if (parts[3] === "events" && parts[5] === "text" && parts.length === 6) return "/sources/:source/events/:id/text";
		return "/sources/:source/*";
	}
	if (/^\/chains\/[^/]+$/.test(path)) return "/chains/:id";
	if (/^\/spans\/[^/]+\/[^/]+$/.test(path)) return "/spans/:ticket/:span";
	if (/^\/links\/[^/]+\/[^/]+$/.test(path)) return "/links/:ticket/:path";
	if (/^\/texts\/[^/]+\/.+$/.test(path)) return "/texts/:ticket/:id";
	if (/^\/debug\/[^/]+$/.test(path)) return "/debug/:session";
	return "/other";
}
//#endregion
//#region src/domain/model.ts
/**
* 事件结果码 → 中文。上游给的是码（accept / no_mention…），
* 界面上只能出现这一个译名表，服务端抽屉与客户端图例共用。
*/
const OUTCOME_LABEL = {
	accept: "接单",
	ignore: "拒绝",
	stop: "停止",
	unavailable: "不可用",
	observed: "已观察",
	delivered: "送达",
	explicitRouted: "直路由",
	admission_ignored: "准入忽略",
	no_mention: "未点名",
	not_human: "非人类",
	not_a_member: "不在名单",
	duplicate: "重复"
};
/**
* 授权强度：上游 `Strength`（`core/model.ts:96`）。
* 码是库里的事实，中文是译名；界面统一写成「中文（code）」。
*/
const STRENGTH_LABEL = {
	explicit: "明确",
	inferred: "推断"
};
/**
* 主控理由码：上游 `core/reasons.ts` 的 `REASONS`。**只翻译上游定义的码**；
* 来源可以自定义字面码，表里没有的原样显示，不编含义。
*/
const REASON_LABEL = {
	said: "原话",
	timeout: "评估超时",
	policyChanged: "评估期间策略变更",
	noAdmissible: "没有可准入的事件",
	startedTicket: "该线程已有工单",
	acceptedBefore: "该事件此前已接单",
	routed: "已路由到工单",
	explicitRouted: "明确点名直路由",
	humanStop: "人工要求停止",
	legacyImport: "从旧版任务记录导入",
	forwarded: "转给该线程已有工单的执行器",
	senderNotMember: "发送者不在名单内",
	retried: "人工重试",
	hostRestarted: "dsh-superagent 重启",
	stopUnknown: "停止目标未知或已结束",
	stopNotExplicit: "停止需要名单内发送者明确要求",
	directionUnsettled: "实现方向未定",
	noRuleMatched: "没有命中启用中的规则",
	ignoredFromCard: "从卡片上忽略，未经规则评估",
	observed: "观察模式：本应接单",
	no_mention: "未点名",
	not_a_member: "发送者不在名单内",
	admission_ignored: "准入设为忽略",
	not_human: "自动消息"
};
/**
* 内置规则的 id：上游 `policy.ts` 的 `DEFAULT_RULES`（copy / visual）。
* 规则 id 是设置里可自定义的，表里没有的原样显示。
*/
const RULE_LABEL = {
	copy: "文案修正",
	visual: "视觉修正"
};
/** 准入依据里的「哪条路」。 */
const VIA_LABEL = {
	addressed: "点名且名单内",
	followup: "该线程已有工单的后续消息",
	admission: "准入表放行",
	listed: "名单放行，旧记录",
	bot: "机器人消息（至多推断）"
};
/** 准入表命中格。 */
const CELL_LABEL = {
	listedUnaddressed: "名单内未点名",
	unlistedAddressed: "名单外已点名",
	unlistedUnaddressed: "名单外未点名"
};
/** 观察模式（AcceptMode）。 */
const ACCEPT_MODE_LABEL = {
	off: "关闭",
	observe: "观察",
	auto: "自动",
	would_accept: "观察模式，旧记录"
};
/** 点名方式：上游 `Trigger.addressed`。 */
const ADDRESSED_LABEL$1 = {
	direct: "直接点名",
	mention: "提及"
};
/** 工单结束去向：上游 `TicketOutcome`（`core/model.ts:273`）。 */
const TICKET_OUTCOME_LABEL = {
	completed: "完成",
	merged: "已合并",
	closed: "已关闭",
	dropped: "已丢弃",
	stopped: "已停止"
};
/** 工单由谁结束：上游 `TicketEndBy`（`core/model.ts:271`）。 */
const TICKET_END_BY_LABEL = {
	executor: "执行器",
	human: "人工"
};
/**
* 统一格式：`中文（code）`。表里没有的码原样返回——不认识就不编中文，
* 尤其原因码允许来源自定义。
*/
function codeLabel(table, code) {
	if (!code) return void 0;
	const label = table[code];
	return label ? `${label}（${code}）` : code;
}
//#endregion
//#region src/service/explain.ts
/** 源头 scope 判定的原因码。它们和主控准入层共用同一个码空间，别把两道闸混成一道。 */
const GATE_TEXT = {
	no_mention: "这道闸判这条消息没有点名。注意：同一个码也可能来自主控准入层，具体是哪道闸要看这条事件有没有裁定记录——源头丢弃不写裁定。",
	not_a_member: "主控准入：发送者不在该来源的名单里。",
	not_human: "主控准入：发送者被判定为机器人/非人类。",
	admission_ignored: "主控准入：命中准入表里的「忽略」格。",
	no_admissible: "主控准入：没有可用的准入路径。",
	listedUnaddressed: "主控准入：名单内但没点名。",
	unlistedAddressed: "主控准入：点了名但不在名单内。",
	unlistedUnaddressed: "主控准入：既不在名单内也没有点名。",
	source_disabled: "来源未启用。",
	source_not_installed: "来源未安装。"
};
/** 主控裁定的结果。 */
const DECISION_TEXT = {
	accept: "主控裁定接单：准入与研判都通过，据此创建或关联了一张工单。",
	ignore: "主控裁定不接：这条消息不转成工单。具体理由看「主控理由码」。",
	stop: "主控裁定停止：该线程上的工作到此为止。",
	unavailable: "主控判定当前不可用（不是失败，也不是拒绝）。",
	observed: "主控只做了观察（观察模式 observe），没有据此建单。"
};
/**
* 决策行里的理由码（上游 `core/reasons.ts` 的 `REASONS`）。
* 只翻译上游定义的码；来源自定义码落到 `NOT_IN_TABLE`，不推测。
*/
const REASON_TEXT = {
	said: "这条理由的原话记在「理由原文」里（上游用 `said` 表示：发送者就是这么说的）。",
	timeout: "评估超时。",
	policyChanged: "评估期间策略被改过，这次评估按当时的策略收尾。",
	noAdmissible: "没有可准入的事件（这批事件都被准入拦下了）。",
	startedTicket: "该线程已经建过工单，不再重复建单。",
	acceptedBefore: "这条事件此前已经被接单处理过。",
	routed: "已路由到工单。",
	explicitRouted: "明确点名 + 名单内，按直路由处理，不需要模型裁量。",
	humanStop: "人工要求停止。",
	legacyImport: "从旧版任务记录导入，不是本次评估产生的。",
	forwarded: "转给该线程已有工单的执行器。",
	senderNotMember: "发送者不在该来源的名单里。",
	retried: "人工重试。",
	hostRestarted: "dsh-superagent 重启导致这次收尾。",
	stopUnknown: "停止目标未知或已经结束。",
	stopNotExplicit: "停止需要名单内发送者明确要求，这条不算。",
	directionUnsettled: "研判认为实现方向还没定，不能接单。",
	noRuleMatched: "研判没有命中任何启用中的规则。",
	ignoredFromCard: "从卡片上被忽略，没有经过规则评估。",
	observed: "观察模式（observe）下记录为「本应接单」，实际没有建单。",
	no_mention: "没有点名智能体，且这个来源不接收其余消息。",
	not_a_member: "发送者不在这个来源的名单里。",
	admission_ignored: "准入表把这一格设为忽略。",
	not_human: "发送者被判为自动消息（机器人），或来源不接收这条。",
	stale: "评估期间事件已经被别的决定处理过。"
};
const NOT_IN_TABLE = "这个码不在本插件的解释表里，不做推测；上文的事实行是库里原样记录。";
/**
* 来源层丢弃的码。
*
* 上游把「来源不听这条」原样落成 `filtered: { code }`（`core/intake.ts:27`），而
* `SourceKind.scope` 的契约只返回码、不返回说明——来源插件可以自定义任意字面码。
* 所以表里没有的码就是**真的无法从库里知道含义**，只能指明它归谁定义。
*/
function interpretFilteredCode(code, source) {
	const known = GATE_TEXT[code];
	if (known) return {
		label: `原因码 ${code}`,
		text: known
	};
	const owner = source ? `来源 ${source} 的插件` : "产生它的来源插件";
	return {
		label: `原因码 ${code}`,
		text: `这是${owner}在「来源层」给出的判定码：上游契约允许来源自定义码，库里只存这个码、不存它的说明。本插件的解释表里没有它，不做推测。码的含义随来源插件的版本变化，要确认只能对照**当时安装的那一版**来源插件。`
	};
}
function interpretDecisionKind(kind) {
	return {
		label: `裁定 ${codeLabel(OUTCOME_LABEL, kind) ?? kind}`,
		text: DECISION_TEXT[kind] ?? NOT_IN_TABLE
	};
}
function interpretReasonCode(code) {
	return {
		label: `理由码 ${codeLabel(REASON_LABEL, code) ?? code}`,
		text: REASON_TEXT[code] ?? NOT_IN_TABLE
	};
}
//#endregion
//#region src/service/sources.ts
/**
* 一条事件的去向。**优先级写死在这里**，单测锁住：
* filtered > requeued > handback > routed > context > direct > undecided > unrecorded。
*/
function fateOf(disposition, decision) {
	if (!disposition) return { kind: "unrecorded" };
	if (disposition.filtered) return {
		kind: "filtered",
		code: disposition.filtered.code
	};
	if (disposition.requeued) return { kind: "requeued" };
	const handbacks = Array.isArray(disposition.handbacks) ? disposition.handbacks : [];
	if (handbacks.length > 0) return {
		kind: "handback",
		tickets: handbacks.flatMap((item) => item?.ticketId ? [item.ticketId] : [])
	};
	if (decision || disposition.decisionId) {
		const decisionId = disposition.decisionId ?? decision?.id;
		const evalId = disposition.evalId ?? decision?.evalId;
		const ticketId = decision?.ticketId;
		return {
			kind: "routed",
			...decisionId ? { decisionId } : {},
			...evalId ? { evalId } : {},
			...decision?.kind ? { decisionKind: decision.kind } : {},
			...ticketId ? { ticketId } : {}
		};
	}
	if ((disposition.context?.length ?? 0) > 0) return {
		kind: "context",
		tickets: disposition.context
	};
	if ((disposition.fanout?.length ?? 0) > 0) return {
		kind: "direct",
		tickets: disposition.fanout
	};
	return { kind: "undecided" };
}
const EMPTY_COUNTS = {
	routed: 0,
	direct: 0,
	context: 0,
	filtered: 0,
	requeued: 0,
	handback: 0,
	undecided: 0
};
function tally(counts, fate) {
	const next = { ...counts };
	if (fate.kind === "unrecorded") return next;
	next[fate.kind] += 1;
	return next;
}
/**
* 三源并集：库里的接收数、配置里出现过的来源、宿主注册表的已安装来源。
* 装了但没有事件的来源也要列出来（界面置灰），否则「这个来源没收到任何东西」不可见。
*/
function mergeSources(input) {
	const sources = /* @__PURE__ */ new Set();
	const received = /* @__PURE__ */ new Map();
	const lastAt = /* @__PURE__ */ new Map();
	for (const item of input.aggregates) {
		sources.add(item.source);
		received.set(item.source, item.received);
		if (item.lastAt) lastAt.set(item.source, item.lastAt);
	}
	const counts = /* @__PURE__ */ new Map();
	for (const { source, disposition } of input.dispositions) {
		sources.add(source);
		counts.set(source, tally(counts.get(source) ?? EMPTY_COUNTS, fateOf(disposition)));
	}
	const ticketCount = /* @__PURE__ */ new Map();
	for (const ticket of input.tickets) {
		if (!ticket.source) continue;
		ticketCount.set(ticket.source, (ticketCount.get(ticket.source) ?? 0) + 1);
	}
	const directory = new Map(input.directory.map((entry) => [entry.source, entry]));
	const configured = new Map(input.configured.map((entry) => [entry.source, entry]));
	for (const source of directory.keys()) sources.add(source);
	for (const source of configured.keys()) sources.add(source);
	const out = [];
	for (const source of sources) {
		const tallyOf = counts.get(source) ?? EMPTY_COUNTS;
		const classified = Object.values(tallyOf).reduce((sum, value) => sum + value, 0);
		const total = received.get(source) ?? 0;
		const entry = directory.get(source);
		const config = configured.get(source);
		const enabled = entry?.enabled ?? config?.enabled;
		out.push({
			source,
			...entry?.label ? { label: entry.label } : {},
			...entry?.installed === void 0 ? {} : { installed: entry.installed },
			...enabled === void 0 ? {} : { enabled },
			received: total,
			tickets: ticketCount.get(source) ?? 0,
			...lastAt.get(source) ? { lastAt: lastAt.get(source) } : {},
			counts: tallyOf,
			unrecorded: Math.max(total - classified, 0)
		});
	}
	return out.sort((left, right) => {
		if (left.lastAt && right.lastAt) return right.lastAt.localeCompare(left.lastAt) || left.source.localeCompare(right.source);
		if (left.lastAt) return -1;
		if (right.lastAt) return 1;
		return left.source.localeCompare(right.source);
	});
}
/**
* 游标：`{at,id}` 的 base64url。坏游标返回 undefined（调用方退回最新一页），不 500。
* 不带 `at` 的游标没有意义：事件表的时间列是 NOT NULL。
*/
function encodeCursor(event) {
	if (!event.at) return void 0;
	return Buffer.from(JSON.stringify({
		at: event.at,
		id: event.triggerId
	}), "utf8").toString("base64url");
}
function decodeCursor(cursor) {
	if (!cursor) return void 0;
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (typeof parsed.at !== "string" || typeof parsed.id !== "string") return void 0;
		return {
			at: parsed.at,
			id: parsed.id
		};
	} catch {
		return;
	}
}
/** 把 adapter 的行拼成事件列表。`decisions` 按 trigger id 建索引，一次请求只建一次。 */
function toSourceEvents(rows, dispositions, decisions) {
	return rows.map((row) => {
		const disposition = dispositions.get(row.id);
		const fate = fateOf(disposition, decisionFor(decisions.get(row.id) ?? [], disposition));
		return {
			triggerId: row.id,
			...row.at ? { at: row.at } : {},
			...row.text ? { text: previewOf(row.text) } : {},
			...typeof row.text === "string" ? { textLength: row.text.length } : {},
			...row.addressed === void 0 ? {} : { addressed: row.addressed },
			...row.human === void 0 ? {} : { human: row.human },
			...row.actor?.id ? { actor: String(row.actor.id) } : {},
			...row.threads?.length ? { threads: row.threads.map((thread) => thread.id || `${thread.source}:${thread.id}`) } : {},
			fate
		};
	});
}
/** 按 trigger id 收集候选决定：一个事件可能出现在多条决定的 `triggerIds` 里（重评估、退回后重排队）。 */
function decisionsByTrigger(decisions) {
	const out = /* @__PURE__ */ new Map();
	for (const decision of decisions) for (const id of decision.triggerIds ?? []) {
		const list = out.get(id);
		if (list) list.push(decision);
		else out.set(id, [decision]);
	}
	return out;
}
/**
* 选「这条去向对应的那条决定」。
*
* 上游 `Evals.record`（`core/evals.ts:329-335`）每次评估都把 `disposition.decisionId` 覆盖成最新那条，
* 旧决定行仍保留同一个 trigger。所以**按指针选**，不能按数组顺序取第一条——那是**最早**的一条，
* 会把重评估后的结果说反（accept 说成 ignore，或反过来）。
* 没有指针（旧数据）时退到 `at` 最新的一条；`at` 也缺失就取最后一次出现的那条。
*/
function decisionFor(decisions, disposition) {
	if (decisions.length === 0) return void 0;
	const pointed = disposition?.decisionId;
	if (pointed) {
		const hit = decisions.find((decision) => decision.id === pointed);
		if (hit) return hit;
	}
	return decisions.reduce((latest, decision) => String(decision.at ?? "") >= String(latest.at ?? "") ? decision : latest);
}
/** 事件分页：多取一行判断 `more`，游标取本页最后一条。 */
function pageOf(events, limit) {
	const items = events.slice(0, limit);
	const last = items[items.length - 1];
	const nextCursor = events.length > limit && last ? encodeCursor(last) : void 0;
	return {
		items,
		more: nextCursor !== void 0,
		...nextCursor ? { nextCursor } : {}
	};
}
/** 事件抽屉的组装。没有触发行也要给降级详情，不能 undefined。 */
function buildSourceEventDetail(input) {
	const { trigger, disposition } = input;
	if (!trigger && !disposition) return void 0;
	const decision = decisionFor(input.decisions, disposition);
	const fate = fateOf(disposition, decision);
	const facts = [];
	const push = (label, value, tone) => {
		if (value === void 0 || value === "") return;
		facts.push({
			label,
			value,
			...tone ? { tone } : {}
		});
	};
	push("时间", trigger?.at ? timeText(trigger.at) : void 0);
	push("来源", input.source);
	push("事件 id", input.triggerId);
	if (trigger) {
		push("发送者", trigger.actor?.id ? String(trigger.actor.id) : "未记录");
		push("人还是机器", trigger.human === true ? "人" : trigger.human === false ? "自动/机器人" : "未记录");
		push("点名方式", trigger.addressed === void 0 || trigger.addressed === null ? "没有点名标记（addressed 字段为空）" : codeLabel(ADDRESSED_LABEL$1, trigger.addressed) ?? trigger.addressed);
		push("线程", trigger.threads?.length ? trigger.threads.map((thread) => thread.id || `${thread.source}:${thread.id}`).join(" · ") : "未记录");
		push("元数据", Object.keys(trigger.meta ?? {}).length > 0 ? JSON.stringify(trigger.meta) : "空");
		push("原文长度", typeof trigger.text === "string" ? `${trigger.text.length} 字` : "未记录");
	} else push("原文", "没有触发行：这条事件只有去向记录，原文不可读", "warn");
	push("去向", FATE_LABEL[fate.kind]);
	if (fate.kind === "filtered") push("原因码", fate.code, "warn");
	if (fate.kind === "direct" || fate.kind === "context" || fate.kind === "handback") push("送达工单", fate.tickets.join(" · "), "muted");
	if (fate.kind === "undecided") push("去向细节", "有去向行，但没有裁定、没有扇出、也没有丢弃原因", "muted");
	if (fate.kind === "unrecorded") push("去向细节", "没有去向行", "warn");
	if (disposition) {
		push("扇出工单", disposition.fanout?.length ? disposition.fanout.join(" · ") : "没有");
		if (disposition.context?.length) push("仅上下文工单", disposition.context.join(" · "), "muted");
		const handbacks = Array.isArray(disposition.handbacks) ? disposition.handbacks : [];
		if (handbacks.length) push("退回工单", handbacks.flatMap((item) => item?.ticketId ? [item.ticketId] : []).join(" · "), "muted");
		if (disposition.requeued) push("重新入队记录", JSON.stringify(disposition.requeued), "muted");
	}
	if (decision) {
		push("裁定", decision.kind ? `${codeLabel(OUTCOME_LABEL, decision.kind)}` : "未记录", decision.kind === "ignore" || decision.kind === "stop" ? "warn" : "ok");
		push("决定 id", decision.id);
		push("评估 id", decision.evalId);
		const rawVersion = decision.policyVersion ?? decision.mandate?.policyVersion;
		const version = typeof rawVersion === "string" && rawVersion ? rawVersion : void 0;
		push("策略版本", rawVersion === void 0 ? void 0 : String(rawVersion));
		const snapshot = version ? input.policy?.at(version) : void 0;
		if (snapshot) {
			const savedAt = snapshot.savedAt ? timeText(snapshot.savedAt) : void 0;
			const revision = typeof snapshot.revision === "number" ? `修订 ${snapshot.revision}` : void 0;
			push("策略快照", [savedAt, revision ? `${revision}（该内容最早一次保存）` : void 0].filter(Boolean).join(" · ") || void 0, "muted");
			const allowed = snapshot.sendersOf(input.source);
			if (allowed === void 0) push("当时名单", "该版本的名单字段形状异常，读不出", "warn");
			else push("当时名单", allowed.length ? allowed.join(" · ") : "名单为空：没有发送者在准入名单内", allowed.length ? "muted" : "warn");
			const rules = snapshot.enabledRules();
			if (rules === void 0) push("当时启用规则", "该版本的规则字段形状异常，读不出", "warn");
			else {
				const named = rules.filter(Boolean).map((rule) => codeLabel(RULE_LABEL, rule) ?? rule);
				push("当时启用规则", named.length ? named.join(" · ") : "没有启用中的规则", "muted");
			}
			const sender = trigger?.actor?.id ? String(trigger.actor.id) : void 0;
			if (sender) {
				if (allowed === void 0) push("名单判定", "名单读不出，无法判断", "muted");
				else {
					const listed = snapshot.allows(input.source, sender);
					push("名单判定", listed ? "在名单内" : "不在名单内", listed ? "ok" : "warn");
				}
			}
		}
		push("授权强度", codeLabel(STRENGTH_LABEL, decision.mandate?.strength ?? decision.strength));
		push("授权范围", decision.mandate?.scope);
		push("授权依据", decision.mandate?.basis ? basisText(decision.mandate.basis) : void 0);
		push("主控理由码", (decision.reason ?? []).map((reason) => codeLabel(REASON_LABEL, reason.code)).join(" · "));
		for (const reason of decision.reason ?? []) {
			const text = reason.values?.["text"];
			if (text) push("理由原文", text, "muted");
		}
		const rules = decision.audit?.rule_assessments ?? [];
		if (rules.length > 0) push("规则评估", `${rules.length} 条，命中 ${rules.filter((rule) => rule.matched).length} 条`);
	} else if (fate.kind === "routed") push("裁定", "去向行记了有裁定，但对应决定行不存在", "warn");
	const interpretations = [];
	if (fate.kind === "filtered") interpretations.push(interpretFilteredCode(fate.code, input.source));
	if (decision?.kind) interpretations.push(interpretDecisionKind(decision.kind));
	for (const reason of decision?.reason ?? []) if (reason.code !== "said") interpretations.push(interpretReasonCode(reason.code));
	const notRecorded = [];
	if (fate.kind === "filtered") {
		notRecorded.push("丢弃发生在来源层（来源插件的 scope 判定），没有进入主控准入；这里只记了原因码，没有记录当时来源的配置或设置快照，判据的细节无法从库里复原。");
		notRecorded.push("源头丢弃的事件不写线程记录，线程的 lastAt 不因它更新。");
	}
	if (fate.kind === "unrecorded") notRecorded.push("没有去向记录（可能还在排队，或写入中断）。");
	if (fate.kind === "routed" && !decision) notRecorded.push("这条去向指向一条不存在的决定行，裁定内容无法复原。");
	if (decision) {
		const rawVersion = decision.policyVersion ?? decision.mandate?.policyVersion;
		const version = typeof rawVersion === "string" && rawVersion ? rawVersion : void 0;
		if (version === void 0) notRecorded.push("这条裁定没有记录可用的策略版本，无法回查当时生效的名单与规则。");
		else if (!input.policy?.at(version)) notRecorded.push(`取不到策略版本 ${version.slice(0, 8)} 的设置快照（可能已被清理，或本次读取失败），无法复原当时生效的名单与规则。`);
	}
	notRecorded.push("上游在入库前按事件 id 去重（`core/intake.ts:23`：命中已有行就直接返回 duplicate，不写任何行、不发 trigger.received）；重复收到的那几次不会留痕，条数是**去重后的事件数**。");
	const relatedTickets = relatedOf(input.triggerId, fate, input.tickets, disposition);
	return {
		source: input.source,
		triggerId: input.triggerId,
		title: `事件 ${input.triggerId}`,
		facts,
		interpretations,
		notRecorded,
		...trigger?.text ? { text: {
			text: previewOf(trigger.text),
			length: trigger.text.length,
			id: trigger.id
		} } : {},
		relatedTickets,
		threads: input.threads.map((item) => ({
			key: item.key,
			...item.label ? { label: item.label } : {},
			subscriptions: item.thread?.subscriptions ?? [],
			context: item.thread?.context ?? [],
			...item.thread?.lastAt ? { lastAt: item.thread.lastAt } : {},
			...item.thread?.meta ? { meta: item.thread.meta } : {}
		}))
	};
}
/** 去向的中文名。列表、抽屉、比例带共用一份，别各写各的。 */
const FATE_LABEL = {
	filtered: "源头丢弃",
	routed: "经主控裁定",
	direct: "订阅直通",
	context: "仅上下文送达",
	requeued: "重新入队",
	handback: "退回其他工单",
	undecided: "未决（没有裁定记录）",
	unrecorded: "没有去向记录"
};
/** 这条事件牵扯到的工单：裁定/扇出/退回的，加上以它为起点创建的。 */
function relatedOf(triggerId, fate, tickets, disposition) {
	const ids = /* @__PURE__ */ new Set();
	if (fate.kind === "routed" && fate.ticketId) ids.add(fate.ticketId);
	if (fate.kind === "direct" || fate.kind === "context" || fate.kind === "handback") for (const id of fate.tickets) ids.add(id);
	for (const id of disposition?.fanout ?? []) ids.add(id);
	for (const ticket of tickets) if (ticket.originTriggerId === triggerId) ids.add(ticket.id);
	const index = new Map(tickets.map((ticket) => [ticket.id, ticket]));
	return [...ids].map((ticketId) => ({
		ticketId,
		...index.get(ticketId)?.title ? { title: index.get(ticketId).title } : {},
		...index.get(ticketId)?.source ? { source: index.get(ticketId).source } : {}
	}));
}
function previewOf(text) {
	return text.length <= 200 ? text : text.slice(0, 200);
}
/** 时间戳 → 本地可读；缺失或解析失败给一句明确说明，不留空。 */
function timeText(value) {
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : value;
}
/**
* 准入依据（`MandateBasis`）→ 人话。原来整段 `JSON.stringify` 直接给人看，键名和码全是英文。
* 这里逐项译成「中文（code）」；`scope` 是来源记录的自由形状，认不得就原样附在最后，不丢事实。
*/
function basisText(basis) {
	const parts = [];
	const text = (value) => typeof value === "string" && value.trim() ? value.trim() : void 0;
	const via = text(basis["via"]);
	if (via) parts.push(codeLabel(VIA_LABEL, via) ?? via);
	const addressed = text(basis["addressed"]);
	if (addressed === "direct") parts.push("直接点名（direct）");
	else if (addressed === "mention") parts.push("提及（mention）");
	const cell = text(basis["cell"]);
	if (cell) parts.push(codeLabel(CELL_LABEL, cell) ?? cell);
	const sender = text(basis["sender"]);
	if (sender) parts.push(`发送者 ${sender}`);
	const namedRules = (Array.isArray(basis["rules"]) ? basis["rules"] : []).flatMap((rule) => typeof rule === "string" && rule ? [codeLabel(RULE_LABEL, rule) ?? rule] : []);
	if (namedRules.length) parts.push(`命中规则 ${namedRules.join(" · ")}`);
	const observation = basis["observation"];
	if (observation && typeof observation === "object") {
		const mode = text(observation["mode"]);
		if (mode) parts.push(codeLabel(ACCEPT_MODE_LABEL, mode) ?? mode);
	}
	const authority = text(basis["authority"]);
	if (authority) parts.push(`旧版授权记录 ${authority}`);
	const scope = basis["scope"];
	if (scope && typeof scope === "object" && Object.keys(scope).length > 0) parts.push(`来源范围 ${JSON.stringify(scope)}`);
	return parts.length ? parts.join(" · ") : JSON.stringify(basis);
}
//#endregion
//#region src/adapter/superagent/stage.ts
/** 阶段标签：`person/answer`、`working/queued` 这类稳定键，用于配色与抽屉。 */
function stageTag(stage) {
	if (stage.stage === "person") return `person/${stage.action}`;
	if (stage.stage === "working" && stage.action) return `working/${stage.action}`;
	return stage.stage;
}
const STAGE_LABEL = {
	"person/delivery": "等待投递后的人",
	"person/answer": "等待人回答",
	"person/review": "等待人验收",
	"person/blocked": "受阻",
	"person/failed": "失败",
	"working/queued": "排队",
	working: "执行中",
	idle: "空闲",
	ended: "已结束"
};
/** 阶段的中文名；未知阶段原样返回，不猜。 */
function stageLabel(stage) {
	return stageLabelOfTag(stageTag(stage));
}
/** 按稳定键取中文名；状态带直接用这个，不再造一套文案。 */
function stageLabelOfTag(tag) {
	return STAGE_LABEL[tag] ?? tag;
}
/**
* 按上游顺序分类工单阶段。判据与 `src/core/stage.ts:9-21` 一一对应：
* 结束 → 投递失败 → 待回答 → 待验收 → 受阻/失败且等人 → 排队 → 空闲 → 执行中。
*/
function ticketStage(ticket) {
	if (ticket.ended) return { stage: "ended" };
	if (ticket.delivery) return {
		stage: "person",
		action: "delivery"
	};
	if (ticket.attention) return {
		stage: "person",
		action: "answer"
	};
	const assignment = latestAssignment(ticket);
	const report = assignment?.report?.state;
	if (report === "ready") return {
		stage: "person",
		action: "review"
	};
	if ((report === "blocked" || report === "failed") && waitsForPerson(ticket)) return {
		stage: "person",
		action: report
	};
	if (!assignment || assignment.state === "pending") return {
		stage: "working",
		action: "queued"
	};
	if (report === "waiting" || assignment.state === "ended") return { stage: "idle" };
	return { stage: "working" };
}
/**
* 工单是否还在等人：最新报告是 blocked/failed，且此后没有人的消息到达
* （`src/core/model.ts:349-353`）。更晚的报告、人的消息或重试都会解除。
*/
function waitsForPerson(ticket) {
	const report = latestAssignment(ticket)?.report;
	if (report?.state !== "blocked" && report?.state !== "failed") return false;
	const reportAt = ms(report.at);
	return !(ticket.inputs ?? []).some((input) => {
		if (input.kind !== "trigger" || !input.human || input.context) return false;
		const at = ms(input.at);
		return at !== void 0 && reportAt !== void 0 && at > reportAt;
	});
}
/** 上游取最后一条派工（`src/core/model.ts:334`）。 */
function latestAssignment(ticket) {
	const list = ticket.assignments ?? [];
	return list[list.length - 1];
}
function ms(value) {
	if (!value) return void 0;
	const time = Date.parse(value);
	return Number.isFinite(time) ? time : void 0;
}
//#endregion
//#region src/domain/session.ts
/**
* 工单 ↔ 执行器会话的命名约定。
*
* 上游（`vendor/dsh-superagent/src/executor/dsh.ts:24`）不存外键，只按名字约定关联：
* 工单 `<ticketId>` 的执行器会话就叫 `worker-<ticketId>`。这里做成唯一实现，
* 各视图都从这里 import，避免将来上游改名时各拼一份字符串而漂移。
*/
const workerSessionId = (ticketId) => `worker-${ticketId}`;
//#endregion
//#region src/adapter/superagent/chain.ts
/**
* 把上游的工单 / 派工 / 决定翻译成 domain 的 Chain。
* 只做形状翻译与时间换算；配色、列、文案都属于 presenter。
*/
/** 工单是否结束，以及结束时的标签。 */
function stateOf(ticket) {
	if (ticket.ended) return `已结束${ticket.ended.outcome ? ` · ${codeLabel(TICKET_OUTCOME_LABEL, ticket.ended.outcome)}` : ""}`;
	return "进行中";
}
/**
* 阶段：严格按上游的派生顺序算（`stage.ts`），不再只看最近一次报告。
* 已结束的工单统一显示「已结束」+ 结束去向。
*/
function stageOf(ticket) {
	if (ticket.ended) return {
		stage: stateOf(ticket),
		stageTag: "ended"
	};
	const derived = ticketStage(ticket);
	return {
		stage: stageLabel(derived),
		stageTag: stageTag(derived)
	};
}
/** 徽章：裁定者由「有没有研判痕迹」决定，**不看 strength**（实测 inferred 也可能是规则拒绝）。 */
function badgeOf(decision) {
	if ((decision.audit?.rule_assessments?.length ?? 0) > 0) return "模型裁定";
	const code = decision.reason?.[0]?.code ?? "";
	if (code === "explicitRouted") return "准入放行";
	if (code === "no_mention" || code === "not_a_member" || code === "admission_ignored") return "规则拒绝";
	return "规则放行";
}
/** 一张工单 → 一条链路；工单不存在返回 undefined（不抛）。 */
function buildChain(store, ticketId, preloaded = {}) {
	const raw = preloaded.ticket ?? store.ticket(ticketId);
	if (!raw) return void 0;
	const base = Date.parse(raw.createdAt);
	const offset = (value) => {
		if (!value) return void 0;
		const ms = Date.parse(value);
		return Number.isFinite(ms) ? Math.max(ms - base, 0) : void 0;
	};
	const decisions = (preloaded.decisions ?? store.decisions()).filter((item) => item.ticketId === ticketId);
	const decision = decisions.find((item) => item.kind !== "stop" && item.kind !== "unavailable");
	const spans = [];
	if (decision) {
		const at = offset(decision.at) ?? 0;
		spans.push({
			id: `decision-${decision.id}`,
			role: "router",
			kind: "activity",
			label: "评估",
			badge: badgeOf(decision),
			startMs: at,
			endMs: at,
			startsApprox: true,
			source: { sessionId: "orchestrator" }
		});
	}
	for (const item of decisions) {
		if (item.kind !== "stop" && item.kind !== "unavailable") continue;
		const at = offset(item.at) ?? 0;
		spans.push({
			id: `event-decision-${item.id}`,
			role: "router",
			kind: "event",
			label: item.kind === "stop" ? "停止" : "不可用",
			startMs: at,
			endMs: at,
			source: { sessionId: "orchestrator" }
		});
	}
	const assignments = raw.assignments ?? [];
	for (const [index, assignment] of assignments.entries()) {
		const start = offset(assignment.startedAt) ?? offset(raw.createdAt) ?? 0;
		const end = offset(assignment.endedAt) ?? start;
		spans.push({
			id: `assignment-${assignment.id}`,
			role: "executor",
			kind: "activity",
			label: `派工 #${index + 1}`,
			...assignment.state === "ended" ? {} : { badge: "进行中" },
			...assignment.report?.state ? { reportState: assignment.report.state } : {},
			startMs: start,
			endMs: Math.max(end, start),
			source: { sessionId: workerSessionId(ticketId) }
		});
		if (index > 0 && assignments[index - 1]?.endedReason === "retried") {
			const at = offset(assignment.createdAt) ?? start;
			spans.push({
				id: `event-retry-${assignment.id}`,
				role: "executor",
				kind: "event",
				label: "重试",
				startMs: at,
				endMs: at,
				source: { sessionId: workerSessionId(ticketId) }
			});
		}
	}
	const deliveryAt = offset(raw.delivery?.at);
	if (deliveryAt !== void 0) spans.push({
		id: "event-delivery",
		role: "executor",
		kind: "event",
		label: "投递失败",
		startMs: deliveryAt,
		endMs: deliveryAt,
		source: { sessionId: workerSessionId(ticketId) }
	});
	const attention = attentionAt(raw, offset);
	if (attention !== void 0) spans.push({
		id: "event-attention",
		role: "executor",
		kind: "event",
		label: "提问",
		startMs: attention,
		endMs: attention,
		startsApprox: true,
		source: { sessionId: workerSessionId(ticketId) }
	});
	const endedAt = offset(raw.ended?.at);
	if (endedAt !== void 0) spans.push({
		id: "event-ended",
		role: "executor",
		kind: "event",
		label: "工单结束",
		startMs: endedAt,
		endMs: endedAt,
		source: { sessionId: workerSessionId(ticketId) }
	});
	const sorted = [...spans].sort((left, right) => left.startMs - right.startMs);
	const stateBands = stateBandsOf(raw, offset, sorted.reduce((max, span) => Math.max(max, span.endMs), Math.max(offset(raw.updatedAt) ?? 0, 0)));
	const stage = stageOf(raw);
	const inputs = (raw.inputs ?? []).map((input) => ({
		kind: input.kind ?? "unknown",
		...input.text !== void 0 ? { text: input.text } : {},
		...input.at !== void 0 ? { at: input.at } : {},
		...input.human ? { human: true } : {},
		...input.context ? { context: true } : {},
		...input.triggerId !== void 0 ? { triggerId: input.triggerId } : {}
	}));
	const answers = (raw.answers ?? []).map((answer) => typeof answer === "string" ? answer : answer.text).filter((text) => typeof text === "string" && text.length > 0);
	return {
		ticketId: raw.id,
		title: raw.title,
		stage: stage.stage,
		stageTag: stage.stageTag,
		createdAt: raw.createdAt,
		...Array.isArray(raw.channels) ? { canReply: raw.channels.length > 0 } : {},
		...raw.ended?.at ? { endedAt: raw.ended.at } : {},
		...inputs.length > 0 ? { inputs } : {},
		...raw.attention ? { attention: {
			...raw.attention.question !== void 0 ? { question: raw.attention.question } : {},
			...raw.attention.triggerId !== void 0 ? { triggerId: raw.attention.triggerId } : {}
		} } : {},
		...answers.length > 0 ? { answers } : {},
		...raw.delivery ? { delivery: {
			...raw.delivery.at !== void 0 ? { at: raw.delivery.at } : {},
			...raw.delivery.error !== void 0 ? { error: raw.delivery.error } : {}
		} } : {},
		...raw.follows && raw.follows.length > 0 ? { follows: raw.follows.map((follow) => ({
			thread: follow.thread,
			own: follow.own,
			...follow.closed ? { closed: {
				at: follow.closed.at,
				outcome: follow.closed.outcome
			} } : {}
		})) } : {},
		...stateBands.length > 0 ? { stateBands } : {},
		spans: sorted
	};
}
/**
* 提问时刻没有落库（`Attention` 没有 `at`）。能用的最近证据是提出问题的
* 那次报告（`assignments.ts:113-119`：report 带 question 且不是 ready 就设 attention），
* 退而求其次用触发问题的那条人的消息。都拿不到才记 0，并标为近似。
*/
function attentionAt(raw, offset) {
	if (!raw.attention) return void 0;
	const reports = (raw.assignments ?? []).map((assignment) => assignment.report).filter((report) => report?.at && report.state !== "ready" && report.state !== "dropped");
	const fromReport = offset(reports[reports.length - 1]?.at);
	if (fromReport !== void 0) return fromReport;
	const humans = (raw.inputs ?? []).filter((input) => input.kind === "trigger" && input.human && !input.context).map((input) => offset(input.at)).filter((value) => value !== void 0);
	return humans[humans.length - 1] ?? 0;
}
/**
* 执行器列的状态背景带：把工单生命期按「状态可能变化」的时刻切开，
* 每段用与 `ticketStage` 同一套判据（按当时的报告/派工/投递/结束）定态，
* 相邻同态合并。起点能从落库时刻得到的才算精确，否则标 `startsApprox`。
*/
function stateBandsOf(raw, offset, endMs) {
	const assignments = raw.assignments ?? [];
	const endedAt = offset(raw.ended?.at);
	const deliveryAt = offset(raw.delivery?.at);
	const attention = attentionAt(raw, offset);
	const points = /* @__PURE__ */ new Set([0, Math.max(endMs, 0)]);
	for (const value of [
		endedAt,
		deliveryAt,
		attention
	]) if (value !== void 0) points.add(Math.max(value, 0));
	for (const assignment of assignments) for (const value of [
		offset(assignment.createdAt),
		offset(assignment.startedAt),
		offset(assignment.endedAt),
		offset(assignment.report?.at)
	]) if (value !== void 0) points.add(Math.max(value, 0));
	for (const input of raw.inputs ?? []) {
		if (input.kind !== "trigger" || !input.human || input.context) continue;
		const at = offset(input.at);
		if (at !== void 0) points.add(Math.max(at, 0));
	}
	const stageAt = (at) => {
		if (endedAt !== void 0 && endedAt <= at) return "ended";
		if (deliveryAt !== void 0 && deliveryAt <= at) return "person/delivery";
		if (attention !== void 0 && attention <= at) return "person/answer";
		const current = [...assignments].reverse().find((assignment) => {
			return (offset(assignment.createdAt) ?? offset(assignment.startedAt) ?? 0) <= at;
		});
		if (!current) return "working/queued";
		const started = offset(current.startedAt);
		if (started === void 0 || started > at) return "working/queued";
		const reportAt = offset(current.report?.at);
		if (current.report && reportAt !== void 0 && reportAt <= at) {
			const state = current.report.state;
			if (state === "ready") return "person/review";
			if (state === "blocked" || state === "failed") return (raw.inputs ?? []).some((input) => {
				if (input.kind !== "trigger" || !input.human || input.context) return false;
				const humanAt = offset(input.at);
				return humanAt !== void 0 && humanAt > reportAt && humanAt <= at;
			}) ? "working" : `person/${state}`;
			if (state === "waiting") return "idle";
			if (state === "dropped") return current.state === "ended" ? "idle" : "working";
			return "working";
		}
		if (current.state === "pending") return "working/queued";
		const currentEndedAt = offset(current.endedAt);
		if (currentEndedAt !== void 0 && currentEndedAt <= at) return "idle";
		return "working";
	};
	const reasons = {
		"person/review": "最新报告为就绪，等待人验收",
		"person/answer": "有未回答的问题",
		"person/delivery": "输入没有送进执行器会话",
		"person/blocked": "报告受阻，且此后没有人跟进",
		"person/failed": "报告失败，且此后没有人跟进",
		"working/queued": "派工尚未开始",
		working: "执行器正在处理这张工单",
		idle: "执行器上一轮已结束、没有待处理项",
		ended: "工单已结束"
	};
	const ordered = [...points].sort((left, right) => left - right);
	const bands = [];
	for (let index = 0; index < ordered.length - 1; index += 1) {
		const start = ordered[index];
		const end = ordered[index + 1];
		if (end <= start) continue;
		const tag = stageAt(start);
		const previous = bands[bands.length - 1];
		if (previous && previous.tag === tag) {
			bands[bands.length - 1] = {
				...previous,
				endMs: end
			};
			continue;
		}
		bands.push({
			id: `state-band-${bands.length}`,
			tag,
			label: stageLabelOfTag(tag),
			startMs: start,
			endMs: end,
			...tag === "person/answer" ? { startsApprox: true } : {},
			...reasons[tag] ? { reason: reasons[tag] } : {}
		});
	}
	return bands;
}
//#endregion
//#region src/presenter/swimlane.ts
/**
* 把毫秒格式化成可读时长：秒 → 分秒 → 时 → 天。
* 长工单不可能再用 `714m6s` 这种读不出量级的写法。
*/
function formatDuration(ms) {
	const totalSeconds = Math.round((Number.isFinite(ms) && ms > 0 ? ms : 0) / 1e3);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m${seconds}s`;
	const totalHours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (totalHours < 24) return minutes === 0 ? `${totalHours}h` : `${totalHours}h${minutes}m`;
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return hours === 0 ? `${days}d` : `${days}d${hours}h`;
}
/**
* 链路摘要：把角色与耗时串成一句话。
* 超长时按段省略中段，保留头两段与末段（起点、第一次判断、终点）。
*/
function chainSummary(chain, maxSegments = 4) {
	const labels = [chain.source ?? "来源"];
	/** 每段累计耗时（毫秒）。合并同角色时要**累加**，否则只显示第一段的耗时。 */
	const spent = [0];
	const render = (label, ms) => ms >= 1e3 ? `${label} ·${formatDuration(ms)}` : label;
	for (const span of chain.spans) {
		const ms = Math.max(span.endMs - span.startMs, 0);
		const label = span.role === "router" ? "主控" : span.role === "executor" ? "执行器" : "子代理";
		if (labels[labels.length - 1] === label) spent[spent.length - 1] += ms;
		else {
			labels.push(label);
			spent.push(ms);
		}
	}
	labels.push(labels[0]);
	spent.push(0);
	const segments = labels.map((label, index) => render(label, spent[index]));
	if (segments.length <= maxSegments) return segments.join(" → ");
	return [
		...segments.slice(0, 2),
		"…",
		segments[segments.length - 1]
	].join(" → ");
}
//#endregion
//#region src/adapter/session/events.ts
/** 我们认为值得成为链路节点的会话事件。 */
const INTERESTING = /* @__PURE__ */ new Set([
	"tool/call",
	"tool/result",
	"step/start",
	"step/end"
]);
/** 读取一个会话里的事件，按时间排序。读取失败返回空数组。 */
async function readSessionEvents$1(query, sessionId) {
	const events = await load$1(query, sessionId);
	const out = [];
	for (const event of events) {
		const type = typeof event?.type === "string" ? event.type : "";
		if (!INTERESTING.has(type)) continue;
		const atMs = typeof event.time === "number" ? event.time : NaN;
		if (!Number.isFinite(atMs)) continue;
		const tool = event.data && typeof event.data["name"] === "string" ? String(event.data["name"]) : void 0;
		out.push({
			seq: typeof event.seq === "number" ? event.seq : 0,
			atMs,
			type,
			...tool ? { tool } : {}
		});
	}
	return out.sort((left, right) => left.atMs - right.atMs);
}
async function load$1(query, sessionId) {
	if (!query) return [];
	try {
		if (typeof query.listEvents === "function") return await query.listEvents(sessionId);
		if (typeof query.readSession === "function") return (await query.readSession(sessionId))?.events ?? [];
	} catch {}
	return [];
}
//#endregion
//#region src/presenter/window.ts
/** 两端各留 2 秒容差，避免因时钟精度把边界事件漏掉。 */
const PADDING_MS = 2e3;
function calculateWindow(startMs, endMs, baseMs) {
	return {
		fromMs: baseMs + Math.min(startMs, endMs) - PADDING_MS,
		toMs: baseMs + Math.max(startMs, endMs) + PADDING_MS
	};
}
//#endregion
//#region src/presenter/translate.ts
/** 参数字段 → 人话标签与呈现方式。按字段名写，与工具名无关。 */
const FIELD_RULES = [
	{
		key: "command",
		label: "命令",
		kind: "code"
	},
	{
		key: "description",
		label: "说明",
		kind: "text"
	},
	{
		key: "file_path",
		label: "文件",
		kind: "path"
	},
	{
		key: "path",
		label: "路径",
		kind: "path"
	},
	{
		key: "pattern",
		label: "匹配",
		kind: "code"
	},
	{
		key: "query",
		label: "查询",
		kind: "text"
	},
	{
		key: "content",
		label: "写入内容",
		kind: "code"
	},
	{
		key: "old_string",
		label: "替换前",
		kind: "code"
	},
	{
		key: "new_string",
		label: "替换后",
		kind: "code"
	},
	{
		key: "text",
		label: "内容",
		kind: "text"
	},
	{
		key: "summary",
		label: "摘要",
		kind: "text"
	},
	{
		key: "purpose",
		label: "用途",
		kind: "badge"
	},
	{
		key: "state",
		label: "状态",
		kind: "badge"
	},
	{
		key: "trigger_id",
		label: "事件",
		kind: "code"
	},
	{
		key: "ticket_id",
		label: "工单 Ticket",
		kind: "code"
	},
	{
		key: "resource",
		label: "资源",
		kind: "resource"
	},
	{
		key: "offset",
		label: "续读位置",
		kind: "offset"
	}
];
/** 资源路径的第一段 → 中文名。取自上游 orchestrator_read 的资源清单，只译名词，不猜内容。 */
const RESOURCE_WORDS = {
	tickets: "工单列表",
	ticket: "工单 Ticket",
	triggers: "事件列表",
	trigger: "事件",
	threads: "线程列表",
	thread: "线程",
	decisions: "决定列表",
	decision: "决定",
	settings: "设置",
	prompts: "提示词",
	"prompt-preview": "提示词预览",
	models: "模型",
	feishu: "飞书原文",
	github: "GitHub 原文"
};
/**
* 资源路径的第二段之后：`ticket/<id>/assignment` 这类子资源的中文名。
* 取自上游 `RESOURCES` 清单（`src/app/resources.ts`），只译已核对的词，认不得的原样保留。
*/
const RESOURCE_TAILS = {
	assignment: "派工任务",
	assignments: "派工列表",
	inputs: "收到的事件",
	result: "最新报告",
	report: "报告",
	transcript: "执行器会话记录",
	message: "消息",
	input: "事件"
};
/**
* `ticket/c5faef17fff20441f4b105b70f265c13/assignment` → `工单 Ticket <完整 id> / 派工任务`。
*
* 资源是**路径**不是定长 id：名词段 + 32 位 id（ticket/decision）+ 可选的子资源。
* 实测最长 50 字，远低于抽屉上限，所以 id 不用截断，整条路径照实显示；
* 仍保留一次长度上限——资源串可能很长（URL/文件路径），不能绕过「单串 ≤200 字」。
* 值是 URL / 文件路径时不猜，原样返回。
*/
function renderResource(text) {
	const [head = "", id, ...tail] = text.split("/").filter(Boolean);
	const noun = RESOURCE_WORDS[head];
	let out = text;
	if (noun) {
		const parts = [id ? `${noun} ${id}` : noun];
		for (let index = 0; index < tail.length; index += 1) {
			const segment = tail[index];
			const word = RESOURCE_TAILS[segment];
			const next = tail[index + 1];
			if (word && next !== void 0 && RESOURCE_TAILS[next] === void 0) {
				parts.push(`${word} ${next}`);
				index += 1;
				continue;
			}
			parts.push(word ?? segment);
		}
		out = parts.join(" / ");
	}
	return out.length > MAX_INLINE ? `${out.slice(0, MAX_INLINE)}…（共 ${out.length} 字）` : out;
}
/** 值的状态码 → 中文。查不到就原样返回。 */
const VALUE_WORDS = {
	answer: "答复",
	result: "结果",
	ready: "就绪",
	blocked: "受阻",
	progress: "进行中",
	failed: "失败",
	waiting: "等待"
};
const MAX_INLINE = 160;
/** 工具名去掉命名空间前缀，保留可读部分。 */
function toolLabel(name) {
	return (name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name).replace(/_/g, " ");
}
/**
* 已知工具的中文名。只收**行为已经核对过**的几个：
* read 是分页读上下文资源，route 是路由工单，ack/reply 是确认与回复，
* eval 系列是准入研判（think 侧与 detail 侧都在用）。
* 没收录的工具保持原名——宁可看见英文，也不猜它是干什么的。
*/
const TOOL_WORDS = {
	orchestrator_read: "读取资源",
	orchestrator_route: "路由工单",
	orchestrator_ack: "确认收到",
	orchestrator_reply: "回复来源",
	orchestrator_report: "上报结果",
	orchestrator_eval: "准入研判",
	orchestrator_eval_read: "读取评估材料",
	orchestrator_eval_decide: "作出准入决定"
};
/** 工具名的中文名；没收录返回 undefined（调用方保留原名）。 */
function toolChinese(name) {
	const short = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
	return TOOL_WORDS[short];
}
/** 参数 → 字段列表。未知字段追加在末尾，不丢弃。 */
function translateArgs(args) {
	if (!args || typeof args !== "object") return [];
	const record = args;
	const used = /* @__PURE__ */ new Set();
	const fields = [];
	for (const rule of FIELD_RULES) {
		const raw = record[rule.key];
		if (raw === void 0 || raw === null) continue;
		used.add(rule.key);
		fields.push({
			label: rule.label,
			value: renderValue(raw, rule.kind),
			kind: rule.kind
		});
	}
	for (const [key, raw] of Object.entries(record)) {
		if (used.has(key) || raw === void 0 || raw === null) continue;
		if (typeof raw === "object") continue;
		fields.push({
			label: key,
			value: renderValue(raw, "text"),
			kind: "text"
		});
	}
	return fields;
}
function renderValue(raw, kind) {
	if (kind === "badge" && typeof raw === "string") return VALUE_WORDS[raw] ?? raw;
	if (kind === "offset") {
		const offset = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
		if (Number.isFinite(offset)) return offset === 0 ? "从头" : String(offset);
	}
	if (typeof raw === "boolean") return raw ? "是" : "否";
	if (typeof raw === "number") return String(raw);
	if (Array.isArray(raw)) return `${raw.length} 项`;
	if (typeof raw === "object" && raw) return `{${Object.keys(raw).slice(0, 5).join("、")}}`;
	const text = String(raw);
	if (kind === "resource") return renderResource(text);
	if (kind === "path") return shortenPath(text);
	if (kind === "code" || kind === "text") return text.length > MAX_INLINE ? `${text.slice(0, MAX_INLINE)}…（共 ${text.length} 字）` : text;
	return text;
}
/** 路径只留尾部两段，前面用省略号——长路径会撑破抽屉。 */
function shortenPath(path) {
	const segments = path.split("/").filter(Boolean);
	return segments.length <= 2 ? path : `…/${segments.slice(-2).join("/")}`;
}
//#endregion
//#region src/service/prose.ts
/**
* 正文的统一形状：预览 + 总字数 + 取全文的 id。
*
* 抽屉只回预览，点「展开原文」再按 id 取全文——不把几十 KB 的推理流水
* 一次塞进响应。这里不做摘要，只做机械截断；摘要一律用模型自己写的字段。
*/
/** 包一段正文；超过预览上限的只回前 N 字，同时把全文记进 sink。 */
function proseOf(text, id, sink) {
	sink?.set(id, text);
	return {
		text: text.length <= 200 ? text : text.slice(0, 200),
		length: text.length,
		id
	};
}
/**
* 取首句，给「块首行」用。
* 按中英文句末标点切；`. ` 后面必须跟空白或结尾才算句末，
* 否则 `doc/weekly.md` 这种路径会被切断。没有标点就截到 `max` 字。
*/
function firstSentence(text, max = 140) {
	const compact = text.replace(/\s+/g, " ").trim();
	if (!compact) return "";
	const match = /[。！？]|[.!?](?=\s|$)/.exec(compact);
	if (match && match.index + 1 <= max) return compact.slice(0, match.index + 1);
	if (compact.length <= max) return compact;
	return `${compact.slice(0, max)}…`;
}
//#endregion
//#region src/service/detail.ts
/**
* 一段活动的详情。
*
* 数据一律走 `ctx.sessionQuery`——会话日志是多帧 zstd（实测 51 帧），
* 文件直读只能解出第一帧，等于什么都读不到。
*
* 结构对齐原型 actBlock：按「步」分组，每步有组头、想法、收到的、动作。
*/
const MAX_EVENTS = 400;
/** 组装一段活动的抽屉内容。任何一步失败都降级为空，不抛。 */
async function readSpanDetail(query, sessionId, chain, spanId, translator, factsProvider, collect) {
	const span = chain.spans.find((item) => item.id === spanId);
	if (!span) return void 0;
	const sink = collect ?? /* @__PURE__ */ new Map();
	if (span.kind === "event") {
		const event = factsProvider?.eventFacts?.(chain.ticketId, span.id, sink);
		return {
			spanId: span.id,
			title: event?.title ?? span.label,
			...span.badge ? { badge: span.badge } : {},
			received: [],
			thoughts: [],
			actions: [],
			...event?.facts?.length ? { facts: event.facts } : {},
			...event?.note ? { note: event.note } : {},
			...event?.outcome ? { outcome: proseOf(event.outcome, `span/${span.id}/outcome`, sink) } : {}
		};
	}
	const base = Date.parse(chain.createdAt);
	const window = calculateWindow(span.startMs, span.endMs, base);
	const identitySessionId = span.source?.sessionId ?? sessionId;
	const { events, readable } = await load(query, identitySessionId);
	const points = span.role === "router" ? [] : modelPoints(events);
	const agent = span.role === "router" ? void 0 : executorInfo(points, factsProvider?.presetOf?.(identitySessionId), window.toMs);
	const filtered = events.filter((event) => typeof event.time === "number" && event.time >= window.fromMs && event.time <= window.toMs);
	const inWindow = filtered.slice(0, MAX_EVENTS);
	const truncated = inWindow.length < filtered.length ? {
		shown: inWindow.length,
		total: filtered.length
	} : void 0;
	const steps = groupByStep(inWindow, span.id, sink, modelAtOf(points));
	let subagentReceived = [];
	let subagentOutcome;
	let subagentMeta = [];
	if (span.role === "subagent") {
		for (const event of inWindow) {
			const text = event.type === "user/message" ? extractText(event.data ?? {}) : "";
			if (text) {
				subagentReceived = [text];
				break;
			}
		}
		for (let index = inWindow.length - 1; index >= 0; index -= 1) {
			const event = inWindow[index];
			if (event.type !== "assistant/message") continue;
			const text = extractText(event.data ?? {});
			if (text) {
				subagentOutcome = text;
				break;
			}
		}
		const first = inWindow.find((event) => typeof event.time === "number");
		const last = [...inWindow].reverse().find((event) => typeof event.time === "number");
		if (first?.time && last?.time) subagentMeta = [{
			label: "耗时",
			value: formatElapsed(last.time - first.time)
		}];
	}
	const received = (span.role === "router" ? [...factsProvider?.routerReceived?.(chain.ticketId) ?? []] : span.role === "subagent" ? subagentReceived : (chain.inputs ?? []).filter((input) => input.kind === "trigger" && input.text).map((input) => input.context ? `（仅上下文，不授权）${input.text}` : input.text)).map((text, index) => proseOf(text, `span/${span.id}/received/${index}`, sink));
	const thoughtTexts = [];
	if (span.role === "router" && factsProvider?.routerThoughts) thoughtTexts.push(...await factsProvider.routerThoughts(chain.ticketId));
	const thoughts = thoughtTexts.map((text, index) => proseOf(text, `span/${span.id}/thoughts/${index}`, sink));
	const thoughtProses = [...thoughts, ...steps.flatMap((step) => step.thoughts)];
	const fullTexts = thoughtProses.map((prose) => sink.get(prose.id) ?? prose.text);
	const peeks = translator?.peek?.(fullTexts) ?? [];
	const translations = {};
	thoughtProses.forEach((prose, index) => {
		const hit = peeks[index];
		if (hit) translations[prose.id] = hit;
	});
	const facts = span.role === "router" ? factsProvider?.factsFor(chain.ticketId, sink) ?? [] : [];
	const ownerFacts = span.role === "executor" ? [{
		label: "所属",
		value: `工单 Ticket ${chain.ticketId}`,
		group: "meta"
	}] : span.role === "subagent" ? [{
		label: "所属",
		value: `工单 Ticket ${chain.ticketId} · 子代理`,
		group: "meta"
	}] : [];
	const identityFacts = span.role === "executor" || span.role === "subagent" ? agentFacts(agent, readable) : [];
	const allFacts = [
		...facts,
		...ownerFacts,
		...identityFacts,
		...subagentMeta.map((row) => ({
			...row,
			group: "meta"
		}))
	];
	const last = steps.length > 0 ? steps[steps.length - 1] : void 0;
	const providerLead = factsProvider?.leadFor?.(chain.ticketId, span.id);
	const described = steps.flatMap((step) => step.actions).flatMap((action) => action.fields).find((field) => field.label === "说明")?.value;
	const leadText = firstSentence(providerLead?.text || subagentOutcome || described || "");
	return {
		spanId: span.id,
		title: span.label,
		...span.badge ? { badge: span.badge } : {},
		...leadText ? {
			lead: leadText,
			leadSource: providerLead?.source ?? "model"
		} : {},
		received,
		thoughts,
		...Object.keys(translations).length > 0 ? { translations } : {},
		actions: steps.length > 0 ? [] : last?.actions ?? [],
		...steps.length > 0 ? { steps } : {},
		...allFacts.length > 0 ? { facts: allFacts } : {},
		...span.role === "router" && thoughts.length === 0 ? { note: factsProvider?.routerNote?.(chain.ticketId) ?? "这次没有留下模型思考。" } : {},
		...truncated ? { truncated } : {},
		...truncated ? {} : span.role === "subagent" ? subagentOutcome ? { outcome: proseOf(subagentOutcome, `span/${span.id}/outcome`, sink) } : {} : last?.thoughts.length ? { outcome: proseOf(sink.get(last.thoughts[last.thoughts.length - 1].id) ?? last.thoughts[last.thoughts.length - 1].text, `span/${span.id}/outcome`, sink) } : {}
	};
}
/** 运行方显示名：按会话 header 的 `agentPreset` 查表；未知 preset 原样显示。 */
const RUNTIME_NAMES = {
	"dsh-superagent-worker": "DSH 内置 Worker",
	standard: "DSH 内置 Agent"
};
/**
* 从会话事件里抽模型时间线。
*
* 只认实际发生过的事件（不读配置）——配置是「应该用什么」，事件才是「实际用了什么」。
* 三处冗余：`request/header`（每次请求）、`request/context`（路由变化时）、
* `assistant/message.message.source`（每条模型消息）；子代理另有 `subagent/descriptor`。
* `model/selection` 只是「选中」，不代表已经用过，故意不算进来。
*/
function modelPoints(events) {
	const points = [];
	for (const event of events) {
		if (typeof event.time !== "number") continue;
		const data = event.data ?? {};
		let provider;
		let model;
		let effort;
		let contextWindow;
		if (event.type === "request/header") {
			const config = nested(data, "header", "config");
			provider = field(config, "provider");
			model = field(config, "model");
			effort = field(config, "reasoningEffort");
		} else if (event.type === "request/context") {
			provider = field(data, "provider");
			model = field(data, "model");
			const window = data["contextWindow"];
			if (typeof window === "number" && Number.isFinite(window)) contextWindow = window;
		} else if (event.type === "assistant/message") {
			const source = nested(data, "message", "source");
			provider = field(source, "provider");
			model = field(source, "model");
		} else if (event.type === "subagent/descriptor") {
			provider = field(data, "agentProvider");
			model = field(data, "agentModel");
			effort = field(data, "agentReasoningEffort");
		}
		if (!model) continue;
		points.push({
			atMs: event.time,
			model,
			...provider ? { provider } : {},
			...effort ? { effort } : {},
			...contextWindow !== void 0 ? { contextWindow } : {}
		});
	}
	return points.sort((left, right) => left.atMs - right.atMs);
}
function nested(data, outer, inner) {
	const value = data[outer];
	if (!value || typeof value !== "object") return void 0;
	const child = value[inner];
	return child && typeof child === "object" ? child : void 0;
}
function field(source, key) {
	const value = source?.[key];
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
const modelKey = (point) => `${point.provider ?? ""}\u0000${point.model}`;
/**
* 汇总成「谁在跑」：运行方来自 header，模型取**这个活动块时间窗内**最后一个时点。
*
* 窗口之后（同会话更晚的轮次/派工）换的模型不能算到本块头上；provider / effort /
* 上下文窗口只在**同一个模型段**里回溯，不跨模型借值，否则会把 A 的路由安到 B 头上。
*/
function executorInfo(points, preset, toMs) {
	const runtime = preset ? RUNTIME_NAMES[preset] ?? preset : void 0;
	const scoped = typeof toMs === "number" ? points.filter((point) => point.atMs <= toMs) : [...points];
	if (scoped.length === 0 && points.length > 0) scoped.push(points[0]);
	const last = scoped[scoped.length - 1];
	if (!runtime && !last) return void 0;
	/** 只在这个模型段内回溯；缺失就如实不给，不借上一个模型的值。 */
	const inSegment = (pick) => {
		if (!last) return void 0;
		const key = modelKey(last);
		for (let index = scoped.length - 1; index >= 0; index -= 1) {
			const point = scoped[index];
			if (modelKey(point) !== key) break;
			const value = pick(point);
			if (value !== void 0) return value;
		}
	};
	const segments = scoped.filter((point, index) => index === 0 || modelKey(point) !== modelKey(scoped[index - 1]));
	const provider = inSegment((point) => point.provider);
	const effort = inSegment((point) => point.effort);
	const contextWindow = inSegment((point) => point.contextWindow);
	return {
		...runtime ? { runtime } : {},
		...preset && runtime !== preset ? { preset } : {},
		...provider ? { provider } : {},
		...last ? { model: last.model } : {},
		...effort ? { effort } : {},
		...contextWindow !== void 0 ? { contextWindow } : {},
		...segments.length > 1 ? { switches: segments.length } : {}
	};
}
/** 某时刻生效的模型；窗口开始前没有任何时点时，用会话的第一个模型。 */
function modelAtOf(points) {
	return (atMs) => {
		let hit;
		for (const point of points) {
			if (point.atMs > atMs) break;
			hit = point;
		}
		const chosen = hit ?? points[0];
		return chosen ? {
			model: chosen.model,
			...chosen.provider ? { provider: chosen.provider } : {}
		} : void 0;
	};
}
const groupDigits = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/**
* 抽屉「概要」段的三行。取不到也给一行明确说明：不显示空壳，也不把「没发起过请求」
* 和「会话读不到」混为一谈。
*/
function agentFacts(agent, readable) {
	const runtime = agent?.runtime ? `${agent.runtime}${agent.preset ? `（${agent.preset}）` : ""}` : "未记录";
	const route = agent?.model ? `${agent.provider ? `${agent.provider} · ` : ""}${agent.model}${agent.switches && agent.switches > 1 ? `（这段活动里换过 ${agent.switches - 1} 次）` : ""}` : readable ? "未记录（这个会话还没有发起过模型请求）" : "会话不可读（可能已归档）";
	const effort = [agent?.effort, agent?.contextWindow !== void 0 ? `上下文 ${groupDigits(agent.contextWindow)}` : void 0].filter((part) => Boolean(part)).join(" · ") || "未记录";
	return [
		{
			label: "运行方",
			value: runtime,
			group: "meta",
			tone: "muted"
		},
		{
			label: "模型路由",
			value: route,
			group: "meta",
			tone: "muted"
		},
		{
			label: "推理强度",
			value: effort,
			group: "meta",
			tone: "muted"
		}
	];
}
async function load(query, sessionId) {
	if (!query) return {
		events: [],
		readable: false
	};
	try {
		if (typeof query.readSession === "function") {
			const snapshot = await query.readSession(sessionId);
			if (snapshot?.events?.length) return {
				events: snapshot.events,
				readable: true
			};
			if (snapshot) {
				if (typeof query.listEvents === "function") try {
					const events = await query.listEvents(sessionId);
					if (events.length) return {
						events,
						readable: true
					};
				} catch {}
				return {
					events: [],
					readable: true
				};
			}
		}
		if (typeof query.listEvents === "function") return {
			events: await query.listEvents(sessionId),
			readable: true
		};
	} catch {}
	return {
		events: [],
		readable: false
	};
}
/**
* 按 step 分组：tool/call 的 data.step 是组号；
* 组内的想法取「该步之前最近的一条模型输出」；
* 工具返回（tool/result）挂回它对应那次调用，错误标红。
*
* 正文只回预览，全文写进 `sink`，id 形如
* `span/<spanId>/steps/<step>/thoughts/<i>`、`.../results/<actionIndex>`。
*/
function groupByStep(events, spanId, sink, modelAt) {
	const steps = /* @__PURE__ */ new Map();
	/** 换过模型的那一步：记下来，组头才能标「模型改为 X」。 */
	const stepModels = /* @__PURE__ */ new Map();
	let previousModel;
	/** 调用 id → 动作：并行调用时按 id 配对，不靠先后顺序猜。 */
	const byKey = /* @__PURE__ */ new Map();
	/** 还没等到返回的调用，按出现顺序排队；老日志没有 id，只能先进先出地配。 */
	const pending = [];
	let pendingThought = "";
	let stepIndex = 0;
	let last;
	for (const event of events) {
		const data = unwrap(event.data);
		if (event.type === "assistant/message") {
			const text = extractText(data);
			if (text) pendingThought = text;
			continue;
		}
		if (event.type === "tool/result") {
			const action = matchAction(byKey, pending, last, data);
			if (!action) continue;
			const text = extractText(data);
			const info = errorInfo(data);
			if (info.failed) action.failed = true;
			action.results += 1;
			action.chars += text.length;
			for (const reason of info.reasons) if (!action.reason.includes(reason)) action.reason.push(reason);
			if (info.failed && text) action.errorBody = action.errorBody ? `${action.errorBody}\n${text}` : text;
			if (typeof event.time === "number") action.lastResultTime = event.time;
			continue;
		}
		if (event.type !== "tool/call") continue;
		const step = typeof data["step"] === "number" ? Number(data["step"]) : stepIndex;
		stepIndex = step;
		const turn = typeof data["turn"] === "number" ? Number(data["turn"]) : void 0;
		const stepKey = turn === void 0 ? String(step) : `${turn}.${step}`;
		const name = typeof data["name"] === "string" ? String(data["name"]) : "tool";
		let entry = steps.get(stepKey);
		if (!entry) {
			entry = {
				step,
				...turn !== void 0 ? { turn } : {},
				thoughts: [],
				actions: []
			};
			const model = typeof event.time === "number" ? modelAt?.(event.time) : void 0;
			if (model) {
				const key = modelKey(model);
				if (previousModel !== void 0 && key !== previousModel) stepModels.set(stepKey, model);
				previousModel = key;
			}
		}
		if (pendingThought && entry.thoughts.length === 0) {
			entry.thoughts.push(proseOf(pendingThought, `span/${spanId}/steps/${stepKey}/thoughts/${entry.thoughts.length}`, sink));
			pendingThought = "";
		}
		const keys = idKeys(data);
		const note = toolChinese(name);
		const action = {
			tool: toolLabel(name),
			...note ? { note } : {},
			...name !== toolLabel(name) ? { raw: name } : {},
			fields: [...translateArgs(parseArgs$1(data["arguments"] ?? data["args"]))],
			results: 0,
			chars: 0,
			reason: [],
			errorBody: "",
			...typeof event.time === "number" ? { callTime: event.time } : {}
		};
		for (const key of keys) byKey.set(key, action);
		entry.actions.push(action);
		pending.push(action);
		last = action;
		steps.set(stepKey, entry);
	}
	return [...steps.entries()].sort((left, right) => (left[1].turn ?? 0) - (right[1].turn ?? 0) || left[1].step - right[1].step).map(([stepKey, entry]) => ({
		step: entry.step,
		...entry.turn !== void 0 ? { turn: entry.turn } : {},
		tools: [...new Set(entry.actions.map((action) => action.note ?? action.tool))],
		thoughts: entry.thoughts,
		received: [],
		actions: entry.actions.map((action, index) => finalizeAction(action, spanId, stepKey, index, sink)),
		...stepModels.has(stepKey) ? { model: stepModels.get(stepKey) } : {}
	}));
}
/** 调用与返回共用的 id：`callId` / `toolCallId`，返回侧还可能挂在 message 上。 */
function idKeys(data) {
	const keys = [data["callId"], data["toolCallId"]];
	const message = data["message"];
	if (message && typeof message === "object") keys.push(message["toolCallId"], message["callId"]);
	return keys.filter((key) => typeof key === "string" && key.length > 0);
}
/**
* 先按 id 配对；老日志没有 id 时按调用顺序配最早的未配对调用，都配完了才挂回最近一次。
*
* 带了 id 却对不上，说明它属于时间窗外的另一次调用——宁可丢，也不能挂到别人头上。
*/
function matchAction(byKey, pending, last, data) {
	const keys = idKeys(data);
	if (keys.length > 0) {
		for (const key of keys) {
			const hit = byKey.get(key);
			if (!hit) continue;
			const index = pending.indexOf(hit);
			if (index >= 0) pending.splice(index, 1);
			return hit;
		}
		return;
	}
	return pending.shift() ?? last;
}
/** 把累积的结果收成一行摘要；成功正文不落缓存，失败正文按 id 可展开。 */
function finalizeAction(action, spanId, stepKey, index, sink) {
	const failed = action.failed === true;
	if (action.results === 0) return {
		tool: action.tool,
		...action.note ? { toolNote: action.note } : {},
		...action.raw ? { toolRaw: action.raw } : {},
		fields: action.fields,
		...failed ? { failed: true } : {}
	};
	const elapsed = action.callTime !== void 0 && action.lastResultTime !== void 0 ? formatElapsed(action.lastResultTime - action.callTime) : "";
	const reasonFull = action.reason.join(" · ") || firstLine(action.errorBody);
	const parts = [failed ? "失败" : "成功"];
	if (elapsed) parts.push(elapsed);
	if (action.results > 1) parts.push(`${action.results} 条`);
	if (failed) {
		const reason = clipText(reasonFull, 80);
		parts.push(reason || "未记录原因");
		if (!reason && action.chars > 0) parts.push(`${action.chars} 字`);
	} else if (action.chars === 0) parts.push("无返回");
	else if (action.chars >= 200) parts.push(`${action.chars} 字`);
	const body = !failed ? "" : action.errorBody ? reasonFull && firstLine(action.errorBody) !== reasonFull ? `${reasonFull}\n\n${action.errorBody}` : action.errorBody : reasonFull;
	const id = `span/${spanId}/steps/${stepKey}/results/${index}`;
	const expandable = body.length > 200;
	if (expandable) sink.set(id, body);
	return {
		tool: action.tool,
		...action.note ? { toolNote: action.note } : {},
		...action.raw ? { toolRaw: action.raw } : {},
		fields: action.fields,
		...failed ? { failed: true } : {},
		result: {
			status: failed ? "error" : "ok",
			summary: parts.join(" · "),
			...expandable ? { detail: {
				length: body.length,
				id
			} } : {}
		}
	};
}
/** 这次返回是不是错误，以及可读的原因（真实 schema 的 error 是对象）。 */
function errorInfo(data) {
	const reasons = [];
	let failed = false;
	if (data["isError"] === true) failed = true;
	const error = data["error"];
	if (typeof error === "string") {
		const text = error.trim();
		if (text) {
			failed = true;
			reasons.push(text);
		}
	} else if (error && typeof error === "object") {
		const obj = error;
		failed = true;
		for (const key of [
			"reason",
			"message",
			"code"
		]) {
			const value = obj[key];
			if (typeof value === "string" && value.trim()) reasons.push(value.trim());
		}
		if (reasons.length === 0 && typeof obj["name"] === "string" && obj["name"].trim()) reasons.push(obj["name"].trim());
	}
	const message = data["message"];
	const messageObj = message && typeof message === "object" ? message : void 0;
	if (messageObj?.["isError"] === true) failed = true;
	const content = messageObj?.["content"] ?? data["content"];
	if (Array.isArray(content) && content.some((part) => part && typeof part === "object" && part.isError === true)) failed = true;
	return {
		failed,
		reasons
	};
}
/** 单行化并截断：摘要里不出现换行和成片的空白。 */
function clipText(text, max) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
function firstLine(text) {
	return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}
/** 2026-11-08 起统一耗时口径：<100ms 标 <0.1s，<60s 一位小数，再长走分钟/小时。 */
function formatElapsed(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "";
	if (ms < 100) return "<0.1s";
	if (ms < 6e4) return `${(ms / 1e3).toFixed(1)}s`;
	return formatDuration(ms);
}
function unwrap(data) {
	if (!data) return {};
	return data;
}
function parseArgs$1(raw) {
	if (typeof raw !== "string") return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}
function extractText(data) {
	const direct = data["text"];
	if (typeof direct === "string") return direct;
	const message = data["message"];
	if (message && typeof message === "object") return extractText(message);
	const content = data["content"];
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => part && typeof part === "object" && typeof part.text === "string" ? String(part.text) : "").join("");
	return "";
}
//#endregion
//#region src/service/link.ts
/**
* 连线元素（箭头 / 知会点）的详情。
*
* 每个元素的段落与原型一致，**不套同一个模板**：
*   事件 → 消息 / 确认与回复 → 发出去的话 / 派工 → 发生了什么 / 报告 → 报告内容
*
* 数据来源：trigger（消息）、outbox（发出去的话，无时间）、
*          assignment.report（报告摘要）、disposition（去向）。
*/
/** 报告状态码 → 中文徽章。 */
const REPORT_LABEL = {
	ready: "就绪",
	blocked: "受阻",
	progress: "进行中",
	failed: "失败",
	waiting: "等待",
	dropped: "无需处理"
};
const OUTBOX_STATUS = {
	sent: {
		text: "已发送",
		tone: "ok"
	},
	pending: {
		text: "排队中",
		tone: "muted"
	},
	dropped: {
		text: "未送达",
		tone: "warn"
	}
};
const ADDRESSED_LABEL = {
	direct: "直接点名智能体",
	mention: "@提及智能体（算点名）"
};
/** 时间戳 → 本地可读；解析失败原样返回。 */
function localTime$2(value) {
	if (!value) return void 0;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : value;
}
/** 发出去的话的公共段落：正文 + 状态（+ 丢弃原因）。正文只回预览。 */
function outboxSections(message, title, linkId, sink) {
	const status = OUTBOX_STATUS[message.status ?? ""] ?? (message.status ? {
		text: message.status,
		tone: "muted"
	} : void 0);
	return [{
		title,
		kind: "quote",
		body: proseOf(message.text, `link/${linkId}/sections/0`, sink),
		say: true
	}, ...status ? [{
		title: "投递状态",
		kind: "badges",
		items: [
			{
				text: status.text,
				tone: status.tone
			},
			...message.droppedReason ? [{
				text: message.droppedReason,
				tone: "warn"
			}] : [],
			...message.kind ? [{
				text: message.kind,
				tone: "muted"
			}] : []
		]
	}] : []];
}
/** 按 id 前缀分发；未知 id 返回 undefined，不抛。 */
function buildLink(context, linkId, collect) {
	const sink = collect ?? /* @__PURE__ */ new Map();
	const trigger = /^arrow-trigger(?:-(\d+))?$/.exec(linkId);
	if (trigger) {
		const index = Number(trigger[1] ?? 0);
		const origins = context.chain.origins ?? [];
		const originId = context.originTriggerId ?? origins[0]?.triggerId;
		const targetId = origins[index]?.triggerId;
		const event = (targetId !== void 0 ? context.originEvents?.find((item) => item.triggerId === targetId) : index === 0 && originId !== void 0 ? context.originEvents?.find((item) => item.triggerId === originId) : void 0) ?? (targetId !== void 0 ? context.dispositions.find((item) => item.triggerId === targetId) : index === 0 ? originId !== void 0 ? context.dispositions.find((item) => item.triggerId === originId) : context.dispositions[index] : void 0);
		const addressed = event?.addressed;
		const position = targetId !== void 0 ? targetId === originId ? "本工单的起点事件：主控就是从这条消息决定接单的。" : "与本工单的起点事件同批进入评估的事件。" : index === 0 ? originId !== void 0 ? "本工单的起点事件：主控就是从这条消息决定接单的。" : "起点事件没有记录；这里显示的是第一条可读事件。" : "这条消息的归属没有记录：现有数据里找不到它对应哪条起点事件。";
		return {
			id: linkId,
			title: index === 0 ? "事件 ① · 来源" : `事件 #${index + 1} · 来源`,
			sections: [
				{
					title: "消息",
					kind: "quote",
					...event?.text ? { body: proseOf(event.text, `link/${linkId}/sections/0`, sink) } : { text: "（这次运行没有记录原文）" }
				},
				{
					title: "它在工单里的位置",
					kind: "note",
					text: position
				},
				...event ? [
					{
						title: "发送者",
						kind: "badges",
						items: [...event.actor ? [{
							text: event.actor,
							tone: "muted"
						}] : [], {
							text: event.human === false ? "机器人" : "人",
							tone: "muted"
						}]
					},
					{
						title: "线程",
						kind: "note",
						text: event.threads?.length ? event.threads.join(" · ") : "没有记录线程"
					},
					{
						title: "点名方式",
						kind: "note",
						text: addressed ? ADDRESSED_LABEL[addressed] ?? addressed : "未点名（走准入表）"
					},
					...localTime$2(event.at) ? [{
						title: "时间",
						kind: "note",
						text: localTime$2(event.at)
					}] : []
				] : []
			]
		};
	}
	if (linkId === "arrow-ack") {
		const message = context.outbox.find((item) => item.kind === "acknowledgement");
		if (!message) return {
			id: linkId,
			title: "确认收到 · 回复来源",
			sections: [{
				title: "发出去的话",
				kind: "note",
				text: "日志里有确认动作，但没有可读的回复记录（可能已被清理）。"
			}]
		};
		return {
			id: linkId,
			title: "确认收到 · 回复来源",
			sections: outboxSections(message, "发出去的话", linkId, sink)
		};
	}
	const dispatch = /^arrow-dispatch-(.+)$/.exec(linkId);
	if (dispatch?.[1]) {
		const assignment = context.assignments.find((item) => `assignment-${item.id}` === dispatch[1]);
		return {
			id: linkId,
			title: `${assignment?.label ?? "派工"} · 投递`,
			sections: [{
				title: "发生了什么",
				kind: "quote",
				text: `工单 Ticket ${context.chain.ticketId} 已创建，派给一个执行器会话。`,
				items: [{
					text: assignment?.state === "ended" ? "已结束" : "进行中",
					tone: "muted"
				}, {
					text: `执行器会话 ${workerSessionId(context.chain.ticketId)}`,
					tone: "muted"
				}]
			}]
		};
	}
	const report = /^arrow-report-(.+)$/.exec(linkId);
	if (report?.[1]) {
		const assignment = context.assignments.find((item) => `assignment-${item.id}` === report[1]);
		if (!assignment) return void 0;
		return {
			id: linkId,
			title: "报告 · 执行器 → 主控",
			sections: [{
				title: "报告内容",
				kind: "quote",
				...assignment.reportSummary ? { body: proseOf(assignment.reportSummary, `link/${linkId}/sections/0`, sink) } : {},
				items: [{
					text: REPORT_LABEL[assignment.reportState ?? ""] ?? assignment.reportState ?? "未记录",
					tone: assignment.reportState === "ready" ? "ok" : assignment.reportState === "blocked" || assignment.reportState === "failed" ? "warn" : "muted"
				}, ...localTime$2(assignment.reportAt) ? [{
					text: localTime$2(assignment.reportAt),
					tone: "muted"
				}] : []]
			}]
		};
	}
	const fast = /^arrow-fast-(\d+)$/.exec(linkId);
	if (fast?.[1]) {
		const event = context.dispositions[Number(fast[1])];
		const isContext = event?.path === "context";
		return {
			id: linkId,
			title: isContext ? "事件 · 仅上下文" : "事件 · 订阅直通",
			sections: [{
				title: "消息",
				kind: "quote",
				...event?.text ? { body: proseOf(event.text, `link/${linkId}/sections/0`, sink) } : { text: "（这次运行没有记录原文）" }
			}, {
				title: isContext ? "为什么只是上下文" : "为什么绕过主控",
				kind: "note",
				text: isContext ? "这条消息只作为上下文送到执行器：执行器可以读它，但它不授权、不唤醒模型，也不会单独触发一轮工作。" : "线程已被工单订阅，程序直送执行器，不经过评估。主控只收到一份知会。"
			}]
		};
	}
	const notice = /^notice-(\d+)$/.exec(linkId);
	if (notice?.[1]) {
		const event = context.dispositions.filter((item) => item.path === "direct")[Number(notice[1])];
		return {
			id: linkId,
			title: "知会 · 主控收到副本",
			sections: [{
				title: "它收到的",
				kind: "quote",
				...event?.text ? { body: proseOf(event.text, `link/${linkId}/sections/0`, sink) } : { text: "（没有记录）" }
			}, {
				title: "说明",
				kind: "note",
				text: "这条消息走直通去了执行器；主控只被抄送，不参与决策，也不会因此唤醒模型。"
			}]
		};
	}
	const reply = /^arrow-reply-(\d+)$/.exec(linkId);
	if (reply?.[1]) {
		const message = context.outbox.filter((item) => item.kind === "reply")[Number(reply[1])];
		if (!message) return {
			id: linkId,
			title: "回复 · 主控 → 来源",
			sections: [{
				title: "发出去的话",
				kind: "note",
				text: "日志里有回复动作，但没有可读的回复记录（可能已被清理）。"
			}]
		};
		return {
			id: linkId,
			title: "回复 · 主控 → 来源",
			sections: outboxSections(message, "发出去的话", linkId, sink)
		};
	}
	const stateBand = /^state-band-(\d+)$/.exec(linkId);
	if (stateBand?.[1]) {
		const band = (context.chain.stateBands ?? [])[Number(stateBand[1])];
		if (!band) return void 0;
		return {
			id: linkId,
			title: `状态 · ${band.label}`,
			...band.startsApprox ? { subtitle: "起点为近似值：提问时刻没有落库，按提出问题的报告反推" } : {},
			sections: [
				{
					title: "这段时间",
					kind: "badges",
					items: [
						{
							text: `从 ${bandTime(band.startMs)} 起`,
							tone: "muted"
						},
						{
							text: `持续 ${bandTime(band.endMs - band.startMs)}`,
							tone: "muted"
						},
						{
							text: band.tag,
							tone: "muted"
						}
					]
				},
				{
					title: "为什么是这个状态",
					kind: "note",
					text: band.reason ?? "这一段没有留下可判定的记录，状态按派工与报告的先后推导。"
				},
				{
					title: "接下来",
					kind: "note",
					text: bandNext(band.tag)
				}
			]
		};
	}
	const pathLink = /^path-(routed|direct|context|filtered)$/.exec(linkId);
	if (pathLink?.[1]) {
		const path = pathLink[1];
		const meta = PATH_META[path];
		const events = context.dispositions.filter((item) => item.path === path);
		if (events.length === 0) return {
			id: linkId,
			title: meta.title,
			subtitle: meta.subtitle,
			sections: [{
				title: "说明",
				kind: "note",
				text: "这条路径的事件已不在当前记录里（可能被上游清理或轮转），刷新后可再看一次。"
			}]
		};
		const base = Date.parse(context.chain.createdAt);
		const offset = (value) => {
			const ms = value ? Date.parse(value) : NaN;
			return Number.isFinite(ms - base) ? Math.max(ms - base, 0) : Number.MAX_SAFE_INTEGER;
		};
		const sorted = [...events].sort((left, right) => offset(left.at) - offset(right.at));
		const groups = path === "filtered" ? [...sorted.reduce((byOutcome, event) => {
			const key = `${event.outcome}\u0000${event.human === false ? "bot" : "human"}\u0000${event.addressed ?? ""}`;
			const hit = byOutcome.get(key);
			if (hit) hit.n += 1;
			else byOutcome.set(key, {
				example: event,
				n: 1
			});
			return byOutcome;
		}, /* @__PURE__ */ new Map()).values()] : sorted.map((example) => ({
			example,
			n: 1
		}));
		return {
			id: linkId,
			title: meta.title,
			subtitle: meta.subtitle,
			sections: [...groups.map(({ example, n }, index) => {
				const atMs = example.at ? Date.parse(example.at) : NaN;
				const relative = Number.isFinite(atMs - base) ? bandTime(atMs - base) : void 0;
				const outcome = OUTCOME_LABEL[example.outcome] ?? example.outcome;
				const addressed = example.addressed ? ADDRESSED_LABEL[example.addressed] ?? example.addressed : "未点名";
				return {
					title: `${relative ?? "（没有记录时间）"} · ${example.actor ?? "未记录发送者"}`,
					kind: "quote",
					...example.text ? { body: proseOf(example.text, `link/${linkId}/sections/${index}`, sink) } : { text: "（这次运行没有记录原文）" },
					items: [
						{
							text: outcome,
							tone: outcomeTone(example.outcome)
						},
						{
							text: example.human === false ? "机器人" : "人",
							tone: "muted"
						},
						...addressed === outcome ? [] : [{
							text: addressed,
							tone: "muted"
						}],
						...n > 1 ? [{
							text: `同类 ${n} 条`,
							tone: "muted"
						}] : []
					]
				};
			}), ...path === "filtered" ? [{
				title: "说明",
				kind: "note",
				text: "这些事件在进入主控前就被规则挡下，不会出现在时序图上。"
			}] : []]
		};
	}
}
/** 三条路径各一句话，讲清「为什么走这条、对人意味着什么」。 */
const PATH_META = {
	routed: {
		title: "经主控 · 慢路径",
		subtitle: "这些事件先送到主控评估：核对发送者、点名与规则，再决定接单、拒绝还是停止。"
	},
	direct: {
		title: "订阅直通 · 快路径",
		subtitle: "线程已被工单订阅，程序把消息直接送进执行器，不经过评估；主控只收到一份知会。"
	},
	context: {
		title: "仅上下文",
		subtitle: "消息只作为上下文送到执行器：能被读到，但不授权、不唤醒模型。"
	},
	filtered: {
		title: "源头丢弃",
		subtitle: "这些事件在准入之前就被挡下，按原因分组，每组给一个例子。"
	}
};
/** 结果码的正负：接单/送达是完成，拒绝/停止/不可用是没做成，其余只是记录。 */
function outcomeTone(code) {
	if (code === "accept" || code === "delivered" || code === "observed" || code === "explicitRouted") return "ok";
	if (code === "ignore" || code === "stop" || code === "unavailable") return "warn";
	return "muted";
}
/** 相对工单创建的时长：秒级给两位小数，分钟级给「m分s秒」。 */
function bandTime(ms) {
	const value = Math.max(ms, 0);
	if (value < 6e4) return `${(value / 1e3).toFixed(2)}s`;
	return `${Math.floor(value / 6e4)}m${Math.round(value % 6e4 / 1e3)}s`;
}
/** 各状态的下一步：写「等什么」，不写空话。 */
function bandNext(tag) {
	switch (tag) {
		case "person/review": return "等人验收。验收后由主控收尾，或退回继续。";
		case "person/answer": return "等人回答问题；回答会作为输入重新送回执行器。";
		case "person/delivery": return "输入没有送进执行器会话，需要重新投递或重试。";
		case "person/blocked": return "执行器报受阻且此后没有人跟进，等人的指示或重试。";
		case "person/failed": return "执行器报失败且此后没有人跟进，等人的指示或重试。";
		case "working/queued": return "任务已派给执行器但还没开始，等它启动。";
		case "idle": return "执行器上一轮已结束、没有待处理项，等新输入或主控收尾。";
		case "ended": return "工单已结束，这条链路到此为止。";
		default: return "执行器正在处理，等它报告。";
	}
}
//#endregion
//#region src/service/policy.ts
function readPolicy(store) {
	try {
		const views = store.settingsSnapshots().filter((item) => item.settings?.policy).map((item) => ({
			raw: item,
			view: viewOf(item)
		})).sort((left, right) => (right.raw.revision ?? 0) - (left.raw.revision ?? 0));
		if (views.length === 0) return void 0;
		const latestView = views[0].view;
		return {
			...latestView,
			latest: () => latestView,
			at: (version) => {
				if (typeof version !== "string" || !version) return void 0;
				let found;
				for (const item of views) if (item.raw.policyVersion === version) found = item.view;
				return found;
			}
		};
	} catch {
		return;
	}
}
/**
* 形状守卫：快照行是历史数据，迁移代码会把解析失败的行原样保留，
* 所以 `allowed` 可能不是数组、`rules` 可能含 null。读的时候一律只认形状，
* 不抛——抛出去就成了路由 500（失败隔离是硬约束）。
*/
function sendersOfView(policy, source) {
	const allowed = policy.sources?.[source]?.allowed;
	if (allowed === void 0 || allowed === null) return [];
	if (!Array.isArray(allowed)) return void 0;
	return allowed.flatMap((item) => {
		const id = item?.id;
		return typeof id === "string" && id ? [id] : [];
	});
}
function enabledRulesOfView(policy) {
	const rules = policy.rules;
	if (rules === void 0 || rules === null) return [];
	if (!Array.isArray(rules)) return void 0;
	return rules.flatMap((rule) => {
		const item = rule;
		if (!item || item.enabled !== true || item.id === void 0 || item.id === null) return [];
		return [String(item.id)];
	});
}
function viewOf(raw) {
	const policy = raw.settings?.policy;
	return {
		sendersOf: (source) => sendersOfView(policy, source),
		allows: (source, id) => (sendersOfView(policy, source) ?? []).some((allowed) => allowed.toLowerCase() === id.toLowerCase()),
		enabledRules: () => enabledRulesOfView(policy),
		...raw.savedAt ? { savedAt: raw.savedAt } : {},
		...raw.policyVersion ? { version: raw.policyVersion } : {},
		...typeof raw.revision === "number" ? { revision: raw.revision } : {}
	};
}
//#endregion
//#region src/service/facts.ts
/**
* 评估块的事实行。
*
* 准入依据优先读 `decision.mandate.basis`（上游 accept 时持久化），
* 并按 `decision.policyVersion` 回查当时的策略快照——不再用「当前策略」猜历史。
* ignore 决策没有 mandate，只显示 strength + reason + 规则的逐条研判。
*/
/** 长的自由文本：`value` 只放预览，全文写进 sink 由 `readText` 按 id 回取。 */
function freeFact(text, id, sink) {
	if (text.length <= 200) return { value: text };
	sink?.set(id, text);
	return {
		value: text.slice(0, 200),
		prose: {
			length: text.length,
			id
		}
	};
}
/** 评估块的事实行 id：`span/decision-<id>/facts/<key>`，与块的 spanId 对齐。 */
const factId = (decision, key) => `span/decision-${decision.id}/facts/${key}`;
const KIND_LABEL = {
	accept: "接受，转交派工",
	ignore: "不接",
	stop: "停止工单",
	unavailable: "暂不可用",
	observed: "只观察，未接单"
};
function gateFacts(decision, trigger, policy, ticketId, sink, routerId) {
	const rows = [];
	const subject = decision.triggerIds ?? [];
	rows.push({
		group: "meta",
		label: "评估会话",
		value: routerId ? `主控会话 ${routerId}` : "主控会话（未记录）",
		tone: "muted"
	}, {
		group: "meta",
		label: "评估对象",
		tone: "muted",
		value: subject.length === 0 ? "事件 Trigger（未记录）" : subject.length === 1 ? `事件 Trigger ${subject[0]}` : `事件 Trigger ${subject[0]} 等 ${subject.length} 条`
	}, {
		group: "meta",
		label: "产出",
		tone: "muted",
		value: decision.kind === "accept" && decision.ticketId ? `工单 Ticket ${decision.ticketId}` : `没有工单：${codeLabel(KIND_LABEL, decision.kind) ?? decision.kind}`
	});
	const basis = decision.mandate?.basis;
	const version = decision.mandate?.policyVersion ?? decision.policyVersion;
	const snapshot = policy?.at(version);
	if (basis) {
		const via = typeof basis["via"] === "string" ? basis["via"] : "";
		const cell = typeof basis["cell"] === "string" ? basis["cell"] : void 0;
		const scope = typeof basis["scope"] === "string" ? basis["scope"] : void 0;
		const sender = typeof basis["sender"] === "string" ? basis["sender"] : typeof basis["actor"] === "string" ? basis["actor"] : trigger?.actor?.id;
		const addressed = typeof basis["addressed"] === "string" ? basis["addressed"] : trigger?.addressed ?? null;
		rows.push({
			group: "gate",
			label: "准入依据",
			value: `${codeLabel(VIA_LABEL, via) ?? (via || "已落库的授权")}${cell ? ` · ${codeLabel(CELL_LABEL, cell) ?? cell}` : ""}`,
			tone: "ok"
		});
		if (sender) {
			const policySource = trigger?.source ?? (typeof basis["source"] === "string" ? basis["source"] : "");
			const memberId = trigger?.actor?.id ? String(trigger.actor.id) : sender;
			const listed = snapshot?.sendersOf(policySource) === void 0 ? void 0 : snapshot.allows(policySource, memberId);
			rows.push({
				group: "gate",
				label: "发送者",
				value: `${sender} · ${listed === void 0 ? "名单不可得" : listed ? "在名单内" : "不在名单内"}`,
				tone: listed === void 0 ? "muted" : listed ? "ok" : "warn"
			});
		}
		if (addressed !== void 0) rows.push({
			group: "gate",
			label: "点名",
			value: addressed === "direct" ? "直接点名智能体" : addressed === "mention" ? "@提及智能体（算点名）" : "未点名（走准入表）",
			tone: addressed === "direct" || addressed === "mention" ? "ok" : "muted"
		});
		if (scope) rows.push({
			group: "gate",
			label: "授权范围",
			tone: "muted",
			...freeFact(scope, factId(decision, "scope"), sink)
		});
		rows.push({
			group: "gate",
			label: "策略版本",
			value: version ? `${shortVersion(version)}${snapshot?.savedAt ? ` · 快照 ${localTime$1(snapshot.savedAt)}` : " · 当时快照不可得"}` : "未记录",
			tone: snapshot ? "ok" : "muted"
		});
	} else {
		rows.push({
			group: "gate",
			label: "准入结果",
			value: `未接单 · ${codeLabel(KIND_LABEL, decision.kind) ?? decision.kind}`,
			tone: "warn"
		});
		rows.push({
			group: "gate",
			label: "强度",
			value: codeLabel(STRENGTH_LABEL, decision.strength) ?? "未记录",
			tone: "muted"
		});
		if (trigger) rows.push({
			group: "gate",
			label: "点名",
			value: trigger.addressed === "direct" ? "直接点名智能体" : trigger.addressed === "mention" ? "@提及智能体（算点名）" : "未点名（走准入表）",
			tone: trigger.addressed ? "ok" : "muted"
		});
	}
	const rules = decision.audit?.rule_assessments ?? [];
	if (rules.length > 0) {
		const matched = rules.filter((rule) => rule.matched).length;
		rows.push({
			group: "assessment",
			label: "研判",
			value: rules.map((rule) => `${codeLabel(RULE_LABEL, rule.rule_id) ?? rule.rule_id} ${rule.matched ? "命中" : "未命中"}`).join(" · "),
			tone: matched === rules.length ? "ok" : matched === 0 ? "warn" : "muted"
		});
		const firstReason = rules.find((rule) => rule.reason)?.reason;
		if (firstReason) rows.push({
			group: "assessment",
			label: "研判理由",
			tone: "muted",
			...freeFact(firstReason, factId(decision, "reason"), sink)
		});
		const evidence = decision.audit?.direction?.["evidence"];
		if (evidence) rows.push({
			group: "assessment",
			label: "证据",
			tone: "muted",
			...freeFact(String(evidence), factId(decision, "evidence"), sink)
		});
	} else rows.push({
		group: "assessment",
		label: "研判",
		value: "未运行：准入已放行，不需要模型判断",
		tone: "muted"
	});
	rows.push({
		group: "action",
		label: "路由决定",
		value: rules.length > 0 || decision.mandate?.basis?.["via"] === "admission" ? `评估工具 → eval_decide（工单 Ticket ${ticketId}）` : `未调用评估工具（准入直接放行 → 工单 Ticket ${ticketId}）`,
		tone: "muted"
	});
	rows.push({
		group: "decision",
		label: "决定",
		value: `${codeLabel(KIND_LABEL, decision.kind) ?? decision.kind} · ${codeLabel(REASON_LABEL, decision.reason?.[0]?.code) ?? "未记录"} · 强度 ${codeLabel(STRENGTH_LABEL, decision.strength) ?? "—"}`,
		tone: decision.kind === "accept" ? "ok" : decision.kind === "ignore" ? "warn" : "muted"
	});
	const reasonText = decision.reason?.[0]?.values?.["text"];
	if (reasonText) rows.push({
		group: "decision",
		label: "理由",
		tone: "muted",
		...freeFact(reasonText, factId(decision, "reason-text"), sink)
	});
	return rows;
}
const shortVersion = (version) => version.slice(0, 8);
function localTime$1(value) {
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : value;
}
//#endregion
//#region src/service/thoughts.ts
const EVAL_TOOLS = /* @__PURE__ */ new Set(["orchestrator_eval", "orchestrator_eval_decide"]);
function thoughtBeforeEval(events, triggerId) {
	let latestText = "";
	for (const event of events) {
		if (event.type === "assistant/message") {
			const text = textOf(event.data ?? {});
			if (text) latestText = text;
			continue;
		}
		if (event.type !== "tool/call") continue;
		const name = typeof event.data?.["name"] === "string" ? String(event.data["name"]) : "";
		if (!EVAL_TOOLS.has(name)) continue;
		const args = parseArgs(event.data?.["arguments"] ?? event.data?.["args"]);
		const id = typeof args?.["trigger_id"] === "string" ? String(args["trigger_id"]) : void 0;
		if (triggerId === void 0 || id === triggerId) return latestText || void 0;
	}
}
function parseArgs(raw) {
	if (raw && typeof raw === "object") return raw;
	if (typeof raw !== "string") return void 0;
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : void 0;
	} catch {
		return;
	}
}
function textOf(data) {
	const direct = data["text"];
	if (typeof direct === "string") return direct;
	const message = data["message"];
	if (message && typeof message === "object") return textOf(message);
	const content = data["content"];
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => part && typeof part === "object" && typeof part.text === "string" ? String(part.text) : "").join("");
	return "";
}
//#endregion
//#region src/adapter/session/zstd.ts
/**
* 会话日志是**多帧** zstd：Node 的 `zstdDecompressSync` 只解第一帧，
* 直接整文件调用会静默丢掉其余帧（实测：60KB 文件只解出 261 字节的 header）。
* 这里按帧魔数切开，逐帧解压再拼接。
*
* 帧魔数也可能出现在压缩数据内部；切开后解压失败就把边界往后挪一帧重试。
*/
const MAGIC = Buffer.from([
	40,
	181,
	47,
	253
]);
/** 读取并解压整个会话文件。文件不可读或不是 zstd 时返回空串，不抛。 */
function decodeSessionText(file) {
	try {
		return decodeZstdFrames(readFileSync(file));
	} catch {
		return "";
	}
}
/**
* 只解第一帧：header 就在第一帧里，逐帧切开会把整个文件都解一遍。
* 注意只适用于「首行即全部所需」的读取。
*/
function decodeFirstFrame(file) {
	try {
		return zstdDecompressSync(readFileSync(file)).toString("utf8");
	} catch {
		return "";
	}
}
/** 逐帧解压一个多帧 zstd 缓冲。无法解码的部分丢弃，不让一帧坏数据毁掉整次读取。 */
function decodeZstdFrames(buffer) {
	let out = "";
	let start = buffer.indexOf(MAGIC);
	if (start < 0) return "";
	while (start < buffer.length) {
		const firstBoundary = nextMagic(buffer, start + MAGIC.length);
		let end = firstBoundary;
		let decoded;
		while (end !== void 0) try {
			decoded = zstdDecompressSync(buffer.subarray(start, end)).toString("utf8");
			break;
		} catch {
			end = nextMagic(buffer, end + MAGIC.length);
		}
		if (decoded === void 0) {
			if (firstBoundary !== void 0) break;
			try {
				decoded = zstdDecompressSync(buffer.subarray(start)).toString("utf8");
			} catch {
				break;
			}
			end = buffer.length;
		}
		if (end === void 0) break;
		out += decoded;
		start = end;
	}
	return out;
}
function nextMagic(buffer, from) {
	const at = buffer.indexOf(MAGIC, from);
	return at < 0 ? void 0 : at;
}
//#endregion
//#region src/adapter/session/children.ts
/**
* 子代理与会话发现：直接读会话目录里的 header。
*
* 实测结构（2026-11-07）：`<sessions>/<workspace>/<sessionId>/session.v4.jsonl.zstd`，
* 首行是会话 header，含 `parentSession` / `origin` / `delegationDepth`。
* 这是官方字段，不依赖命名约定，也不需要 `subagent/descriptor` 事件。
*
* 识别子代理必须看 `origin === 'subagent'`：只看 `parentSession` 会把 fork 误判成子代理
* （`subagent/child-agent.ts:135-152`、`core/session/src/types.ts:110-128`）。
*/
/** 按会话 id 读它的 header（只解第一帧，成本与子代理发现同级）。 */
function readSessionHeader(sessionsRoot, sessionId) {
	const file = sessionFileOf(sessionsRoot, sessionId);
	if (!file) return void 0;
	const header = readHeader(file);
	if (!header || typeof header.id !== "string") return void 0;
	return {
		id: header.id,
		...typeof header.agentPreset === "string" ? { agentPreset: header.agentPreset } : {}
	};
}
/** 扫描 sessions 根目录，返回父会话等于 `parentId` 的子代理会话。失败返回空数组。 */
function findChildSessions(sessionsRoot, parentId) {
	const found = [];
	for (const descriptor of sessionFiles(sessionsRoot)) {
		const header = readHeader(descriptor.file);
		if (header?.parentSession !== parentId || typeof header.id !== "string") continue;
		if (header.origin !== void 0 && header.origin !== "subagent") continue;
		found.push({
			id: header.id,
			createdAt: typeof header.createdAt === "number" ? header.createdAt : 0,
			depth: typeof header.delegationDepth === "number" ? header.delegationDepth : 1
		});
	}
	return found;
}
/** 读出整个会话文件的事件行（含 data），用于取工具调用的精确时间。 */
function readSessionEvents(file) {
	const out = [];
	for (const line of decodeSessionText(file).split("\n")) {
		if (!line) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed.type !== "session") out.push(parsed);
		} catch {}
	}
	return out;
}
/** 找到某个会话目录里的日志文件；找不到返回 undefined。 */
function sessionFileOf(sessionsRoot, sessionId) {
	return sessionFiles(sessionsRoot).find((descriptor) => descriptor.id === sessionId)?.file;
}
/** 列出所有会话日志，带上 header 里读得到的元信息。 */
function sessionFiles(sessionsRoot) {
	const files = [];
	let workspaces = [];
	try {
		workspaces = readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch {
		return files;
	}
	for (const workspace of workspaces) {
		let sessions = [];
		try {
			sessions = readdirSync(join(sessionsRoot, workspace), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		} catch {
			continue;
		}
		for (const sessionId of sessions) files.push({
			id: sessionId,
			file: join(sessionsRoot, workspace, sessionId, "session.v4.jsonl.zstd")
		});
	}
	return files;
}
/**
* 主控会话：优先用 kv 的 `master-id`（上游自己记的指针，`src/kv.ts:33`）。
* 没有指针时退回到 `orchestrator-*` 会话里按 trigger id 找；再找不到才取最新一个。
*/
function findRouterSessionId(sessionsRoot, lookup = {}) {
	const candidates = routerSessions(sessionsRoot);
	if (candidates.length === 0) return void 0;
	const ids = lookup.triggerIds ?? [];
	if (ids.length > 0) {
		const bounded = lookup.atMs === void 0 ? candidates : candidates.filter((item) => item.createdAt <= lookup.atMs + 1e3);
		for (const candidate of (bounded.length > 0 ? bounded : candidates).slice(0, 5)) if (mentionsAny(readSessionEvents(candidate.file), ids)) return candidate.id;
		if (lookup.requireMention) return void 0;
	} else if (lookup.requireMention) return;
	return ((lookup.atMs === void 0 ? candidates : candidates.filter((item) => item.createdAt <= lookup.atMs + 1e3))[0] ?? candidates[0]).id;
}
/** 主控会话们，按创建时间从新到旧。 */
function routerSessions(sessionsRoot) {
	const found = [];
	for (const descriptor of sessionFiles(sessionsRoot)) {
		if (!descriptor.id.startsWith("orchestrator-")) continue;
		const header = readHeader(descriptor.file);
		const createdAt = typeof header?.createdAt === "number" ? header.createdAt : 0;
		found.push({
			id: descriptor.id,
			file: descriptor.file,
			createdAt
		});
	}
	return found.sort((left, right) => right.createdAt - left.createdAt);
}
/** 工具入参里是否出现这批 trigger id；出现在别的会话说明不是它的评估。 */
function mentionsAny(events, triggerIds) {
	return events.some((event) => {
		if (event.type !== "tool/call") return false;
		const raw = event.data?.["arguments"];
		if (typeof raw !== "string") return false;
		return triggerIds.some((id) => raw.includes(id));
	});
}
/** 只解压够读首行的一段；文件损坏就当没有。 */
function readHeader(file) {
	try {
		const firstLine = decodeFirstFrame(file).split("\n", 1)[0];
		if (!firstLine) return void 0;
		const parsed = JSON.parse(firstLine);
		return parsed.type === "session" ? parsed : void 0;
	} catch {
		return;
	}
}
//#endregion
//#region src/service/reader.ts
function createReader(options) {
	const store = openStore(options.stateDir);
	/**
	* 策略快照**按需读**，不缓存。
	*
	* 设置随时会被保存：启动时读一份的话，之后新存的策略版本在 `at()` 里查不到，
	* 界面就会把「我们没刷新」说成「库里没有这份快照」——那是假话。
	* 代价只是每次扫一遍 `kv` 里少量 `settings-version:*` 行，且只在读工单/事件详情时发生。
	*/
	const policyOf = () => store ? readPolicy(store) : void 0;
	const sourceDirectory = () => {
		try {
			return options.sourceDirectory?.() ?? [];
		} catch {
			return [];
		}
	};
	/**
	* 正文全文缓存：抽屉只回预览，点「展开原文」再按 id 取全文。
	* 不缓存就得每次重读多帧 zstd 会话（一段就是几十帧），展开会明显卡。
	* 同一 id 的文本写入后不再变，命中即定值；按条数与字数双上限先进先出淘汰。
	*/
	const textCache = /* @__PURE__ */ new Map();
	/**
	* 会话 header 的 `agentPreset`：header 是首帧，记的是**建会话时**的 preset，重选不会改写它。
	* 只缓存读到的值——会话还没建好时每次都重试，否则会把「暂时没有」记成「永远没有」。
	* 条数上限与 textCache 同级，长生命周期进程里不会无限堆积。
	*/
	const presetCache = /* @__PURE__ */ new Map();
	const PRESET_CACHE_MAX = 2e3;
	const sessionsRoot = `${options.stateDir}/../../sessions`;
	const presetOf = (sessionId) => {
		const cached = presetCache.get(sessionId);
		if (cached !== void 0) return cached;
		const preset = readSessionHeader(sessionsRoot, sessionId)?.agentPreset;
		if (preset !== void 0) {
			if (presetCache.size >= PRESET_CACHE_MAX) {
				const oldest = presetCache.keys().next().value;
				if (oldest !== void 0) presetCache.delete(oldest);
			}
			presetCache.set(sessionId, preset);
		}
		return preset;
	};
	let cachedChars = 0;
	const CACHE_MAX_ENTRIES = 2e3;
	const CACHE_MAX_CHARS = 6e6;
	const cacheKey = (ticketId, textId) => `${ticketId}\u0000${textId}`;
	const remember = (ticketId, sink) => {
		for (const [textId, text] of sink) {
			const key = cacheKey(ticketId, textId);
			const previous = textCache.get(key);
			if (previous === text) continue;
			if (previous !== void 0) cachedChars -= previous.length;
			textCache.set(key, text);
			cachedChars += text.length;
		}
		while (textCache.size > CACHE_MAX_ENTRIES || cachedChars > CACHE_MAX_CHARS) {
			const oldest = textCache.keys().next();
			if (oldest.done) break;
			cachedChars -= textCache.get(oldest.value)?.length ?? 0;
			textCache.delete(oldest.value);
		}
	};
	return {
		async listChains(limit, source) {
			if (!store) return [];
			const triggers = new Map(store.triggers().map((trigger) => [trigger.id, trigger]));
			const rows = source ? store.ticketsBySource(source, limit) : store.tickets(limit);
			const decisions = store.decisions();
			return rows.map((ticket) => {
				const chain = buildChain(store, ticket.id, {
					ticket,
					decisions
				});
				const originId = ticket.origin?.triggerId;
				const originSource = originId ? triggers.get(originId)?.source : void 0;
				return {
					ticketId: ticket.id,
					title: ticket.title,
					state: stateOf(ticket),
					createdAt: ticket.createdAt,
					...ticket.ended?.at ? { endedAt: ticket.ended.at } : {},
					stepCount: ticket.assignments?.length ?? 0,
					...originSource ? { source: originSource } : {},
					...chain && originSource ? { summary: chainSummary({
						...chain,
						source: originSource
					}) } : {}
				};
			});
		},
		async readChain(ticketId) {
			if (!store) return void 0;
			const chain = buildChain(store, ticketId);
			if (!chain) return void 0;
			const raw = store.ticket(ticketId);
			const triggers = new Map(store.triggers().map((trigger) => [trigger.id, trigger]));
			const originId = raw?.origin?.triggerId;
			const source = originId ? triggers.get(originId)?.source : void 0;
			const origins = (raw?.origin?.triggerIds ?? []).map((id) => ({
				triggerId: id,
				...triggers.get(id)?.at ? { at: triggers.get(id).at } : {}
			}));
			const events = await readSessionEvents$1(options.sessionQuery, workerSessionId(ticketId));
			const base = Date.parse(chain.createdAt);
			const subagents = await subagentSpans(options.sessionQuery, options.stateDir, workerSessionId(ticketId), base);
			const firstTriggerMs = origins.map((origin) => origin.at ? Date.parse(origin.at) : NaN).filter((value) => Number.isFinite(value));
			const sinceMs = firstTriggerMs.length > 0 ? Math.min(...firstTriggerMs) : base;
			const marks = await toolMarks(options.sessionQuery, ticketId, routerSessionOf(store, options.stateDir, ticketId, { requireMention: false }), sinceMs);
			return {
				...chain,
				...source ? { source } : {},
				...origins.length > 0 ? { origins } : {},
				...marks ? { marks } : {},
				spans: [...mergeExecutorSpans(chain.spans, events, base), ...subagents]
			};
		},
		async readLink(ticketId, linkId) {
			const chain = await this.readChain(ticketId);
			if (!chain) return void 0;
			const raw = store?.ticket(ticketId);
			const assignments = (raw?.assignments ?? []).map((item, index) => {
				const base = Date.parse(chain.createdAt);
				const start = item.startedAt ? Date.parse(item.startedAt) - base : 0;
				const end = item.endedAt ? Date.parse(item.endedAt) - base : start;
				const report = item.report;
				return {
					id: item.id,
					label: `派工 #${index + 1}`,
					startMs: start,
					endMs: end,
					...item.state ? { state: item.state } : {},
					...report?.state ? { reportState: report.state } : {},
					...report?.summary ? { reportSummary: report.summary } : {},
					...report?.at ? { reportAt: report.at } : {}
				};
			});
			const outbox = (store?.outbox(ticketId) ?? []).map((item) => ({
				id: item.id,
				kind: item.kind,
				text: item.text,
				...item.status ? { status: item.status } : {},
				...item.dropped?.reason ? { droppedReason: item.dropped.reason } : {}
			}));
			const originTriggerId = raw?.origin?.triggerId;
			const byId = new Map((store?.triggers() ?? []).map((item) => [item.id, item]));
			const originEvents = [.../* @__PURE__ */ new Set([...raw?.origin?.triggerIds ?? [], ...originTriggerId ? [originTriggerId] : []])].flatMap((id) => {
				const trigger = byId.get(id);
				if (!trigger) return [];
				const threads = threadsOf(trigger);
				return [{
					triggerId: id,
					...trigger.text ? { text: trigger.text } : {},
					...trigger.at ? { at: trigger.at } : {},
					...trigger.actor?.id !== void 0 ? { actor: String(trigger.actor.id) } : {},
					...trigger.human !== void 0 ? { human: trigger.human } : {},
					...threads ? { threads } : {},
					addressed: trigger.addressed ?? null
				}];
			});
			const sink = /* @__PURE__ */ new Map();
			const link = buildLink({
				chain,
				dispositions: dispositionOf(store, ticketId, byId),
				assignments,
				outbox,
				...originTriggerId ? { originTriggerId } : {},
				...originEvents.length > 0 ? { originEvents } : {}
			}, linkId, sink);
			remember(ticketId, sink);
			return link;
		},
		async readSpanDetail(ticketId, spanId) {
			const chain = await this.readChain(ticketId);
			if (!chain) return void 0;
			let routerId;
			let routerResolved = false;
			const resolveRouterId = () => {
				if (!routerResolved) {
					routerResolved = true;
					routerId = routerSessionOf(store, options.stateDir, ticketId);
				}
				return routerId;
			};
			const sink = /* @__PURE__ */ new Map();
			const detail = await readSpanDetail(options.sessionQuery, workerSessionId(ticketId), chain, spanId, options.translator, {
				routerThoughts: async (id) => {
					const routerSessionId = resolveRouterId();
					if (!routerSessionId) return [];
					try {
						const snapshot = await options.sessionQuery?.readSession?.(routerSessionId);
						const decision = store?.decisions().find((item) => item.ticketId === id);
						const thought = thoughtBeforeEval(snapshot?.events ?? [], decision?.triggerIds?.[0]);
						return thought ? [thought] : [];
					} catch {
						return [];
					}
				},
				routerReceived: (id) => {
					const triggerId = (store?.decisions().find((item) => item.ticketId === id))?.triggerIds?.[0];
					const trigger = triggerId ? store?.triggers().find((item) => item.id === triggerId) : void 0;
					return trigger?.text ? [trigger.text] : [];
				},
				routerNote: (id) => {
					const decision = store?.decisions().find((item) => item.ticketId === id);
					if (!decision) return "这次没有留下模型思考。";
					return (decision.audit?.rule_assessments?.length ?? 0) > 0 ? "这次没有留下模型思考，但下面有模型对规则的逐条研判。" : "这次没有模型思考：准入已放行，直接转派工，不需要模型判断。";
				},
				factsFor: (id, collect) => {
					const decision = store?.decisions().find((item) => item.ticketId === id);
					if (!decision) return [];
					const triggerId = decision.triggerIds?.[0];
					return gateFacts(decision, triggerId ? store?.triggers().find((item) => item.id === triggerId) : void 0, policyOf(), id, collect, resolveRouterId());
				},
				eventFacts: (id, spanId, collect) => eventFactsOf(store, id, spanId, collect),
				presetOf,
				leadFor: (id, spanId) => {
					if (spanId.startsWith("decision-")) {
						const decision = store?.decisions().find((item) => item.id === spanId.slice(9));
						if (!decision) return void 0;
						const scope = decision.mandate?.scope?.trim();
						if (scope) return {
							text: scope,
							source: "system"
						};
						const label = codeLabel(KIND_LABEL, decision.kind) ?? decision.kind;
						const code = decision.reason?.[0]?.code;
						const reason = codeLabel(REASON_LABEL, code);
						return {
							text: reason ? `${label} · ${reason}` : label,
							source: "system"
						};
					}
					if (spanId.startsWith("assignment-")) {
						const assignmentId = spanId.slice(11);
						const summary = (store?.ticket(id)?.assignments?.find((item) => item.id === assignmentId))?.report?.summary?.trim();
						return summary ? {
							text: summary,
							source: "model"
						} : void 0;
					}
				}
			}, sink);
			remember(ticketId, sink);
			return detail;
		},
		async readText(ticketId, textId) {
			const key = cacheKey(ticketId, textId);
			const hit = textCache.get(key);
			if (hit !== void 0) return hit;
			const [, owner] = /^span\/([^/]+)\//.exec(textId) ?? [];
			const [, linkOwner] = /^link\/([^/]+)\//.exec(textId) ?? [];
			try {
				if (owner) await this.readSpanDetail(ticketId, owner);
				else if (linkOwner) await this.readLink(ticketId, linkOwner);
				else return void 0;
			} catch {
				return;
			}
			return textCache.get(key);
		},
		async readSessionSample(ticketId) {
			const client = options.sessionQuery;
			let raw = [];
			try {
				raw = (await client?.readSession?.(workerSessionId(ticketId)))?.events ?? [];
			} catch {}
			const histogram = {};
			const samples = {};
			for (const event of raw) {
				const type = typeof event["type"] === "string" ? String(event["type"]) : "?";
				histogram[type] = (histogram[type] ?? 0) + 1;
				if (!samples[type]) samples[type] = shapeOf(event);
			}
			const probe = raw.find((event) => event["type"] === "tool/call");
			let full;
			if (probe && typeof probe["seq"] === "number") try {
				full = (await client?.readEvent?.({
					sessionId: workerSessionId(ticketId),
					seq: probe["seq"]
				}))?.target;
			} catch (error) {
				full = String(error);
			}
			let sessions = "unavailable";
			try {
				sessions = (await options.sessionQuery?.listSessions?.() ?? []).map((item) => {
					return {
						keys: Object.keys(item),
						id: item["id"],
						parentSession: item["parentSession"],
						origin: item["origin"],
						depth: item["delegationDepth"]
					};
				});
			} catch (error) {
				sessions = String(error);
			}
			return {
				total: raw.length,
				histogram,
				samples,
				full,
				sessions
			};
		},
		async readDispositions(ticketId) {
			if (!store) return [];
			return dispositionOf(store, ticketId);
		},
		async listSources() {
			if (!store) return [];
			return mergeSources({
				aggregates: store.sourceAggregates(),
				dispositions: store.dispositionSources(),
				tickets: store.ticketIndex(),
				configured: store.configuredSources(),
				directory: sourceDirectory()
			});
		},
		async listSourceEvents(source, limit, cursor) {
			if (!store) return {
				items: [],
				more: false
			};
			const before = decodeCursor(cursor);
			const rows = store.sourceEventRows(source, limit + 1, before);
			return pageOf(toSourceEvents(rows, new Map(rows.flatMap((row) => {
				const disposition = store.disposition(row.id);
				return disposition ? [[row.id, disposition]] : [];
			})), decisionsByTrigger(store.decisions())), limit);
		},
		async readSourceEvent(source, triggerId) {
			if (!store) return void 0;
			const trigger = store.trigger(triggerId);
			if (trigger && trigger.source !== source) return void 0;
			const disposition = store.disposition(triggerId);
			if (!trigger && !disposition) return void 0;
			const labels = store.sourceLabels(source);
			const threads = (trigger?.threads ?? []).map((thread) => {
				const key = `${thread.source}:${thread.id}`;
				const entry = store.thread(key);
				const label = labels?.[thread.id];
				return {
					key,
					...label ? { label } : {},
					...entry ? { thread: entry } : {}
				};
			});
			const policy = policyOf();
			return buildSourceEventDetail({
				source,
				triggerId,
				...trigger ? { trigger } : {},
				...disposition ? { disposition } : {},
				decisions: store.decisionsOfTrigger(triggerId),
				threads,
				tickets: store.ticketIndex(),
				...policy ? { policy } : {}
			});
		},
		async readSourceEventText(source, triggerId) {
			if (!store) return void 0;
			const trigger = store.trigger(triggerId);
			if (!trigger || trigger.source !== source) return void 0;
			return typeof trigger.text === "string" ? trigger.text : void 0;
		}
	};
}
/**
* 这张工单的主控会话。
*
* `kv['master-id']` 是上游自己维护的指针（`src/kv.ts:33`），优先用它；
* 没有指针才按 trigger id 在 `orchestrator-*` 会话里找——**找不到就返回 undefined**，
* 不拿「最新的某个主控会话」顶替（会话目录跨 workspace，顶替会署错名）。
*/
function routerSessionOf(store, stateDir, ticketId, options = {}) {
	if (!store) return void 0;
	const master = store.kv("master-id");
	if (typeof master === "string" && master) return master;
	const decision = store.decisions().find((item) => item.ticketId === ticketId);
	const at = decision?.at ? Date.parse(decision.at) : void 0;
	return findRouterSessionId(`${stateDir}/../../sessions`, {
		...Number.isFinite(at) ? { atMs: at } : {},
		...decision?.triggerIds ? { triggerIds: decision.triggerIds } : {},
		...options.requireMention !== false ? { requireMention: true } : {}
	});
}
/** 工具入参里的工单归属：上游统一写 `ticket_id`，兼容驼峰。 */
function ticketIdOf(arguments_) {
	let value = arguments_;
	if (typeof arguments_ === "string") try {
		value = JSON.parse(arguments_);
	} catch {
		return;
	}
	if (!value || typeof value !== "object") return void 0;
	const record = value;
	const id = record["ticket_id"] ?? record["ticketId"];
	return typeof id === "string" ? id : void 0;
}
/**
* 某会话里某个工具的调用时刻，**只收本工单的**。
*
* 主控会话是长生命周期的：同一个 `orchestrator-*` 会话里既有别的工单的 reply，
* 也可能有几小时前的。不过滤的话，别的工单的回复会把时间轴起点拉到十几个小时前，
* 本工单真实的几分钟会被压成亚像素——图上看起来就是「什么都没有」。
* 归属证据是工具入参里的 `ticket_id`；旧日志没有这个字段时，用「不早于本工单首条触发」兜底。
*/
function toolCallTimes(events, tool, ticketId, sinceMs) {
	const out = [];
	for (const event of events) {
		if (event.type !== "tool/call") continue;
		if (typeof event.time !== "number") continue;
		const data = event.data ?? {};
		if (data["name"] !== tool) continue;
		const owner = ticketIdOf(data["arguments"]);
		if (owner !== void 0) {
			if (owner !== ticketId) continue;
		} else if (sinceMs !== void 0 && event.time < sinceMs) continue;
		out.push(event.time);
	}
	return out;
}
/**
* 关键时点：`orchestrator_ack` 由执行器调用，`orchestrator_reply` 由主控调用。
* 直接从会话日志里取工具调用的时间戳——比按块边界估算准。
*/
async function toolMarks(query, ticketId, routerId, sinceMs) {
	const client = query;
	const timesOf = async (sessionId, tool) => {
		if (!sessionId || !client?.readSession) return [];
		try {
			return toolCallTimes((await client.readSession(sessionId))?.events ?? [], tool, ticketId, sinceMs);
		} catch {
			return [];
		}
	};
	const acks = await timesOf(workerSessionId(ticketId), "orchestrator_ack");
	const replies = await timesOf(routerId, "orchestrator_reply");
	if (acks.length === 0 && replies.length === 0) return void 0;
	return {
		...acks[0] !== void 0 ? { ackMs: acks[0] } : {},
		...replies[0] !== void 0 ? { replyMs: replies[0] } : {},
		...replies.length > 0 ? { replies } : {}
	};
}
/**
* 子代理会话：header 里 `parentSession` 指向父会话，`delegationDepth` 给出层级。
* 嵌套在执行器列内，不单独占列。
*/
async function subagentSpans(query, stateDir, parentId, base) {
	const root = `${stateDir}/../../sessions`;
	const client = query;
	const spans = [];
	for (const [index, child] of findChildSessions(root, parentId).entries()) {
		let endMs = Math.max(child.createdAt - base, 0);
		try {
			const times = ((await client?.readSession?.(child.id))?.events ?? []).map((event) => event.time).filter((time) => typeof time === "number");
			if (times.length > 0) endMs = Math.max(Math.max(...times) - base, 0);
		} catch {}
		const startMs = Math.max(child.createdAt - base, 0);
		spans.push({
			id: `subagent-${child.id}`,
			role: "subagent",
			kind: "activity",
			label: `子代理 #${index + 1}`,
			badge: child.depth > 1 ? `第 ${child.depth} 层` : "委派",
			startMs,
			endMs: Math.max(endMs, startMs),
			source: { sessionId: child.id }
		});
	}
	return spans;
}
/**
* 把会话事件折进执行器那一段：不新增列，只把 step/tool 收进同一个 span。
* 事件为空时原样返回——内容缺失是正常情况，不是错误。
*/
function mergeExecutorSpans(spans, events, base) {
	if (events.length === 0 || !Number.isFinite(base)) return spans;
	return spans.map((span) => {
		if (span.role !== "executor" || span.kind !== "activity") return span;
		const tools = events.filter((event) => {
			if (event.type !== "tool/call") return false;
			const offset = event.atMs - base;
			return offset >= span.startMs && offset <= span.endMs;
		}).length;
		return {
			...span,
			badge: tools > 0 ? `${tools} 次调用` : span.badge
		};
	});
}
/**
* 离散事件的抽屉内容。全部取自领域表（ticket / decision），不读会话日志：
* 这些事件本来就没有会话痕迹，硬读只会得到空。
*/
function eventFactsOf(store, ticketId, spanId, sink) {
	if (!store) return void 0;
	const ticket = store.ticket(ticketId);
	if (!ticket) return void 0;
	const free = (text, key) => {
		if (text.length <= 200) return { value: text };
		const id = `span/${spanId}/facts/${key}`;
		sink?.set(id, text);
		return {
			value: text.slice(0, 200),
			prose: {
				length: text.length,
				id
			}
		};
	};
	if (spanId === "event-attention") {
		const attention = ticket.attention;
		if (!attention) return void 0;
		const facts = [{
			label: "问题",
			group: "meta",
			...free(attention.question ?? "（上游没有记录问题正文）", "question")
		}];
		if (attention.triggerId) facts.push({
			label: "对应消息",
			value: attention.triggerId,
			group: "meta"
		});
		return {
			title: "提问 · 执行器 → 人",
			facts,
			note: "提问时刻没有落库：图上的位置按提出问题的报告反推，起点画虚线。"
		};
	}
	if (spanId === "event-delivery") {
		const delivery = ticket.delivery;
		if (!delivery) return void 0;
		return {
			title: "投递失败 · 输入没有送到执行器",
			facts: [{
				label: "时间",
				value: localTime(delivery.at),
				group: "meta"
			}, {
				label: "错误",
				group: "meta",
				tone: "warn",
				...free(delivery.error ?? "（上游没有记录错误文本）", "error")
			}],
			note: "上游在下次投递成功或工单结束时清除这条记录，所以它只反映当前状态。"
		};
	}
	if (spanId === "event-ended") {
		const ended = ticket.ended;
		if (!ended) return void 0;
		const facts = [
			{
				label: "时间",
				value: localTime(ended.at),
				group: "meta"
			},
			{
				label: "由谁结束",
				value: codeLabel(TICKET_END_BY_LABEL, ended.by) ?? "未记录",
				group: "meta"
			},
			{
				label: "去向",
				value: codeLabel(TICKET_OUTCOME_LABEL, ended.outcome) ?? ended.outcome,
				group: "decision",
				tone: ended.outcome === "failed" ? "warn" : "ok"
			}
		];
		if (ended.reason) facts.push({
			label: "原因",
			group: "meta",
			...free(ended.reason, "reason")
		});
		return {
			title: `工单 Ticket ${ticketId} · 结束`,
			facts
		};
	}
	const retry = /^event-retry-(.+)$/.exec(spanId);
	if (retry?.[1]) {
		const list = ticket.assignments ?? [];
		const index = list.findIndex((item) => item.id === retry[1]);
		if (index < 0) return void 0;
		const previous = list[index - 1];
		const facts = [
			{
				label: "上一次派工",
				value: previous ? `#${index} · ${previous.state}` : "未知",
				group: "meta"
			},
			{
				label: "上一次结束原因",
				value: previous?.endedReason ?? "未记录",
				group: "meta",
				tone: "warn"
			},
			{
				label: "本次起点",
				value: localTime(list[index]?.createdAt),
				group: "meta"
			}
		];
		return {
			title: `重试 · 第 ${index + 1} 次派工`,
			facts,
			note: "上游用一条新派工重试，旧派工的结束原因是「人工重试（retried）」；新派工的创建时刻就是重试点。"
		};
	}
	const decisionId = /^event-decision-(.+)$/.exec(spanId);
	if (decisionId?.[1]) {
		const found = store.decisions().find((item) => item.id === decisionId[1]);
		if (!found) return void 0;
		const facts = [{
			label: "判定",
			value: codeLabel(OUTCOME_LABEL, found.kind) ?? found.kind,
			group: "decision",
			tone: found.kind === "stop" ? "warn" : "muted"
		}];
		for (const reason of found.reason ?? []) facts.push({
			label: "理由码",
			value: codeLabel(REASON_LABEL, reason.code) ?? reason.code,
			group: "decision",
			tone: "muted"
		});
		return {
			title: found.kind === "stop" ? "停止 · 主控判定" : "不可用 · 主控判定",
			facts,
			note: found.kind === "stop" ? "这是合法的停止判定；非法的停止请求在上游会被降级成「不接（ignore）」，不会出现在这里。" : "不可用是判定结果，不是失败。"
		};
	}
}
/** 时间戳 → 本地可读；缺失或解析失败给一句明确说明，不留空。 */
function localTime(value) {
	if (!value) return "（没有记录时间）";
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : value;
}
/**
* 事件去向。三条路径互斥，按终态优先级归类：
* 直达工单 > 进评估 > 源头丢弃。
*
* 关键：本工单线程上**被规则拒绝**的事件（没有 ticketId）也必须算进来，
* 否则比例带会漏掉"没被理"的那一类。
*/
function dispositionOf(store, ticketId, known) {
	const triggers = known ?? new Map(store.triggers().map((trigger) => [trigger.id, trigger]));
	const ticket = store.ticket(ticketId);
	const originTrigger = ticket?.origin?.triggerId ? triggers.get(ticket.origin.triggerId) : void 0;
	const threadKeys = new Set((originTrigger?.threads ?? []).map((thread) => `${thread.source}:${thread.id}`));
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const decision of store.decisions()) {
		const onTicket = decision.ticketId === ticketId;
		const onThread = decision.threadKey !== void 0 && [...threadKeys].some((key) => decision.threadKey === key || decision.threadKey?.endsWith(`:${key}`));
		if (!onTicket && !onThread) continue;
		const trigger = decision.triggerIds?.[0] ? triggers.get(decision.triggerIds[0]) : void 0;
		const key = decision.id;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			path: "routed",
			outcome: decision.kind,
			...decision.at ? { at: decision.at } : {},
			...trigger?.text ? { text: trigger.text } : {},
			...trigger?.id ? { triggerId: trigger.id } : {},
			...trigger?.actor?.id ? { actor: String(trigger.actor.id) } : {},
			...trigger?.human !== void 0 ? { human: trigger.human } : {},
			...threadsOf(trigger) ? { threads: threadsOf(trigger) } : {},
			...trigger ? { addressed: trigger.addressed ?? null } : {}
		});
	}
	for (const row of store.dispositions()) {
		const fanout = row.fanout ?? [];
		const trigger = triggers.get(row.id);
		const common = {
			...row.at ? { at: row.at } : {},
			...trigger?.text ? { text: trigger.text } : {},
			triggerId: row.id,
			...trigger?.actor?.id ? { actor: String(trigger.actor.id) } : {},
			...trigger?.human !== void 0 ? { human: trigger.human } : {},
			...threadsOf(trigger) ? { threads: threadsOf(trigger) } : {},
			...trigger ? { addressed: trigger.addressed ?? null } : {}
		};
		if (row.filtered) {
			out.push({
				path: "filtered",
				outcome: row.filtered.code,
				...common
			});
			continue;
		}
		if (row.context?.includes(ticketId)) {
			out.push({
				path: "context",
				outcome: "delivered",
				...common
			});
			continue;
		}
		if (row.requeued) continue;
		if ((row.handbacks?.length ?? 0) > 0) continue;
		if (fanout.includes(ticketId) && !row.decisionId) out.push({
			path: "direct",
			outcome: "delivered",
			...common
		});
	}
	return out;
}
/** 事件第一层字段名与类型，只给开发期调试路由看形状。 */
function shapeOf(event) {
	const out = {};
	for (const [key, value] of Object.entries(event)) out[key] = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
	return out;
}
/** 事件所在线程：优先用 id（上游已含来源前缀），否则拼 `source:id`。 */
function threadsOf(trigger) {
	const list = (trigger?.threads ?? []).map((thread) => thread.id || `${thread.source}:${thread.id}`).filter(Boolean);
	return list.length > 0 ? list : void 0;
}
//#endregion
//#region src/service/translate.ts
const cache = /* @__PURE__ */ new Map();
const CACHE_LIMIT = 300;
const SYSTEM = "你是翻译。把用户给出的英文技术推理译为简洁中文，保留代码、命令与专有名词原文，不要解释，不要加任何前缀。";
/** 只查缓存，不产生任何模型调用。用于"再次打开直接用译文"。 */
function peekTranslations(texts, options) {
	if (!options) return texts.map(() => void 0);
	return texts.map((text) => cache.get(`${options.provider}/${options.model}:${hash(text)}`));
}
async function translateAll(llm, texts, options) {
	if (!llm?.prepareCall || !options) return texts.map(() => void 0);
	const maxChars = options.maxChars ?? 1200;
	const out = [];
	for (const text of texts) {
		if (!text || text.length > maxChars) {
			out.push(void 0);
			continue;
		}
		const key = `${options.provider}/${options.model}:${hash(text)}`;
		const hit = cache.get(key);
		if (hit) {
			out.push(hit);
			continue;
		}
		const translated = await once(llm, text, options);
		if (translated) remember(key, translated);
		out.push(translated);
	}
	return out;
}
async function once(llm, text, options) {
	try {
		const prepared = await llm.prepareCall({
			provider: options.provider,
			model: options.model
		});
		const chunks = prepared.stream({
			...prepared.config ?? {
				provider: options.provider,
				model: options.model
			},
			system: SYSTEM,
			messages: [{
				role: "user",
				content: [{
					type: "text",
					text
				}]
			}]
		});
		let out = "";
		for await (const chunk of chunks) {
			if (chunk?.type === "text-delta" && typeof chunk.text === "string") out += chunk.text;
			const anyChunk = chunk;
			if (!out && typeof anyChunk?.delta?.text === "string") out += anyChunk.delta.text;
			if (!out && typeof anyChunk?.content === "string") out += anyChunk.content;
		}
		const clean = out.trim();
		return clean.length > 0 ? clean : void 0;
	} catch (error) {
		return;
	}
}
function remember(key, value) {
	if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
	cache.set(key, value);
}
function hash(text) {
	let value = 2166136261;
	for (let index = 0; index < text.length; index += 1) {
		value ^= text.charCodeAt(index);
		value = Math.imul(value, 16777619);
	}
	return (value >>> 0).toString(36);
}
//#endregion
//#region src/service/routes.ts
const PREFIX = "/agent-trace";
/** 注册所有路由。任何异常都转成 500，绝不让宿主进程崩。 */
function registerRoutes(web, reader, translator, health, status) {
	web.register({
		kind: "prefix",
		path: PREFIX,
		handler: async (req, res) => {
			const started = Date.now();
			let label = "/other";
			try {
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(12) : url.pathname;
				label = routeLabel(path);
				if (!sameOrigin(req, url, web.port)) return send(res, 403, { error: "same-origin request required" });
				const method = (req.method ?? "GET").toUpperCase();
				if (path === "/status") {
					if (method !== "GET") return send(res, 405, { error: "method not allowed" });
					return send(res, 200, status);
				}
				if (path === "/health") {
					if (method !== "GET") return send(res, 405, { error: "method not allowed" });
					return send(res, 200, health.snapshot());
				}
				if (!reader) return send(res, 503, {
					unconfigured: true,
					...status
				});
				if (path.startsWith("/translate")) {
					if (method !== "POST") return send(res, 405, { error: "method not allowed" });
					const body = await readJson(req);
					const texts = (Array.isArray(body?.texts) ? body.texts : []).slice(0, 5);
					return send(res, 200, {
						items: await translator(texts),
						skipped: texts.flatMap((text, index) => text.length > 1200 ? [index] : [])
					});
				}
				if (method !== "GET") return send(res, 405, { error: "method not allowed" });
				if (path === "/chains") {
					const limit = clamp(Number(url.searchParams.get("limit") ?? 20), 1, 100);
					const source = url.searchParams.get("source") || void 0;
					return send(res, 200, { items: await reader.listChains(limit, source) });
				}
				const debugMatch = /^\/debug\/([^/]+)$/.exec(path);
				if (debugMatch?.[1]) return send(res, 200, await reader.readSessionSample(decodeURIComponent(debugMatch[1])));
				const linkMatch = /^\/links\/([^/]+)\/([^/]+)$/.exec(path);
				if (linkMatch?.[1] && linkMatch[2]) {
					const link = await reader.readLink(decodeURIComponent(linkMatch[1]), decodeURIComponent(linkMatch[2]));
					if (!link) return send(res, 404, { error: "link not found" });
					return send(res, 200, { link });
				}
				const spanMatch = /^\/spans\/([^/]+)\/([^/]+)$/.exec(path);
				if (spanMatch?.[1] && spanMatch[2]) {
					const detail = await reader.readSpanDetail(decodeURIComponent(spanMatch[1]), decodeURIComponent(spanMatch[2]));
					if (!detail) return send(res, 404, { error: "span not found" });
					return send(res, 200, { detail });
				}
				const textMatch = /^\/texts\/([^/]+)\/(.+)$/.exec(path);
				if (textMatch?.[1] && textMatch[2]) {
					const text = await reader.readText(decodeURIComponent(textMatch[1]), decodeURIComponent(textMatch[2]));
					if (text === void 0) return send(res, 404, { error: "text not found" });
					return send(res, 200, { text });
				}
				if (path === "/sources") return send(res, 200, { items: await reader.listSources() });
				const eventsMatch = /^\/sources\/([^/]+)\/events$/.exec(path);
				if (eventsMatch?.[1]) {
					const limit = clamp(Number(url.searchParams.get("limit") ?? 50), 1, 200);
					const cursor = url.searchParams.get("cursor") ?? void 0;
					return send(res, 200, await reader.listSourceEvents(decodeURIComponent(eventsMatch[1]), limit, cursor));
				}
				const eventTextMatch = /^\/sources\/([^/]+)\/events\/([^/]+)\/text$/.exec(path);
				if (eventTextMatch?.[1] && eventTextMatch[2]) {
					const text = await reader.readSourceEventText(decodeURIComponent(eventTextMatch[1]), decodeURIComponent(eventTextMatch[2]));
					if (text === void 0) return send(res, 404, { error: "event text not found" });
					return send(res, 200, { text });
				}
				const eventMatch = /^\/sources\/([^/]+)\/events\/([^/]+)$/.exec(path);
				if (eventMatch?.[1] && eventMatch[2]) {
					const detail = await reader.readSourceEvent(decodeURIComponent(eventMatch[1]), decodeURIComponent(eventMatch[2]));
					if (!detail) return send(res, 404, { error: "event not found" });
					return send(res, 200, { detail });
				}
				const chainMatch = /^\/chains\/([^/]+)$/.exec(path);
				if (chainMatch?.[1]) {
					const chain = await reader.readChain(decodeURIComponent(chainMatch[1]));
					if (!chain) return send(res, 404, { error: "chain not found" });
					return send(res, 200, {
						chain,
						dispositions: await reader.readDispositions(chain.ticketId)
					});
				}
				return send(res, 404, { error: "unknown route" });
			} catch (error) {
				if (error instanceof URIError) return send(res, 400, { error: "bad percent-encoding in path" });
				return send(res, 500, { error: String(error).slice(0, 200) });
			} finally {
				health.record(label, Date.now() - started, res.statusCode < 500);
			}
		}
	});
}
/** 读取 JSON body，上限 64KB；解析失败返回 undefined，不抛。 */
function readJson(req) {
	return new Promise((resolve) => {
		if (!req.on) {
			resolve(void 0);
			return;
		}
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			size += buffer.length;
			if (size > 65536) {
				resolve(void 0);
				return;
			}
			chunks.push(buffer);
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				resolve(void 0);
			}
		});
		req.on("error", () => resolve(void 0));
	});
}
function sameOrigin(req, url, port) {
	const origin = req.headers["origin"];
	if (typeof origin !== "string" || !port) return true;
	try {
		const parsed = new URL(origin);
		return parsed.port === String(port) || parsed.host === `127.0.0.1:${port}` || parsed.host === `localhost:${port}`;
	} catch {
		return false;
	}
}
function clamp(value, min, max) {
	if (!Number.isFinite(value)) return min;
	return Math.min(Math.max(Math.trunc(value), min), max);
}
function send(res, status, body) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(body));
}
//#endregion
//#region src/index.ts
/**
* dsh-superagent-trace — host 插件入口。
*
* M1 目标：把数据层接上并产出可验证的链路，不做任何 UI。
* 约束（P4）：handler 纯、吞异常、只读基本类型；任何失败都不得影响宿主。
*/
/**
* 诊断日志**默认不写**：只有显式设置 `DSH_AGENT_TRACE_LOG=<文件路径>` 才落盘。
*
* M4 安全清单要求「正文不写日志」，并且分发出去的插件不能把路径钉死在这台机器上
* （旧实现写死了一个 `/Users/<开发机>/...` 的绝对路径，换台机器就会尝试往不存在的目录写）。
* 日志只记事件与计数，不记原文/标题——要看正文请在界面上看。
*/
const LOG = typeof process.env.DSH_AGENT_TRACE_LOG === "string" && process.env.DSH_AGENT_TRACE_LOG ? process.env.DSH_AGENT_TRACE_LOG : void 0;
const say = (line) => {
	if (!LOG) return;
	try {
		appendFileSync(LOG, `${(/* @__PURE__ */ new Date()).toISOString()} ${line}\n`);
	} catch {}
};
const name = "dsh-superagent-trace";
const inject = [
	"orchestrator",
	"sessionQuery",
	"webServer",
	"llm"
];
/**
* 解析要读哪个 stateDir。
*
* 顺序：显式配置 → orchestrator 自己的 `machine.stateDir` → 都没有。
*
* 第二档不是兜底，是**正确缺省**：本插件读的 `orchestrator.sqlite` 就住在
* superagent 的 stateDir 里，所以 superagent 配在哪，我们就该读哪。
* 有了这一档，bundle 自动挂载的用户不用配任何东西也能工作——
* bundle 内的 patch 不能写死绝对路径，这正是之前会静默退出的根因。
*/
function resolveStateDir(config, orchestrator) {
	const configured = typeof config?.stateDir === "string" ? config.stateDir.trim() : "";
	if (configured) return {
		stateDir: configured,
		origin: "config"
	};
	const machine = orchestrator?.machine;
	const inherited = typeof machine?.stateDir === "string" ? machine.stateDir : "";
	if (inherited.trim()) return {
		stateDir: inherited,
		origin: "orchestrator"
	};
	return {
		stateDir: "",
		origin: "none"
	};
}
function apply(ctx, config) {
	say("APPLY: plugin loaded");
	const resolved = resolveStateDir(config, ctx.orchestrator);
	const stateDir = resolved.stateDir;
	say(`CONFIG: stateDir=${stateDir || "(未配置)"} origin=${resolved.origin}`);
	const translateConfig = config?.translate?.provider && config.translate.model ? {
		provider: config.translate.provider,
		model: config.translate.model
	} : void 0;
	say(`TRANSLATE: ${translateConfig ? `${translateConfig.provider}/${translateConfig.model}` : "未配置"}`);
	const sourceDirectory = () => {
		try {
			const sources = ctx.orchestrator?.sources;
			if (!sources?.instances) return [];
			const instances = sources.instances();
			if (!Array.isArray(instances)) return [];
			return instances.flatMap((instance) => {
				const item = instance;
				if (typeof item?.id !== "string") return [];
				const kind = sources.kind?.(item.id);
				const label = typeof kind?.title?.zh === "string" ? kind.title.zh : void 0;
				return [{
					source: item.id,
					...label ? { label } : {},
					...typeof item.installed === "boolean" ? { installed: item.installed } : {},
					...typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}
				}];
			});
		} catch {
			return [];
		}
	};
	const reader = stateDir ? createReader({
		stateDir,
		sessionQuery: ctx.sessionQuery,
		sourceDirectory,
		...translateConfig ? { translator: {
			translate: (texts) => translateAll(ctx.llm, texts, translateConfig),
			peek: (texts) => peekTranslations(texts, translateConfig)
		} } : {}
	}) : void 0;
	const health = createHealth(Date.now, stateDir ? storeProbe(() => openStore(stateDir)) : () => ({
		ok: false,
		ms: 0,
		error: "stateDir unset"
	}));
	try {
		if (ctx.webServer) {
			registerRoutes(ctx.webServer, reader, async (texts) => translateConfig ? translateAll(ctx.llm, texts, translateConfig) : texts.map(() => void 0), health, {
				configured: Boolean(reader),
				stateDirOrigin: resolved.origin,
				...reader ? {} : { hint: "没有拿到 superagent 的 stateDir（orchestrator 没有暴露 machine.stateDir）。若 superagent 用了自定义目录，在 profile 的 cordis.patch.yml 里给 dsh-superagent-trace 加 config.stateDir。" }
			});
			say("ROUTES: /agent-trace/chains 已注册");
		} else say("ROUTES: webServer 不可用");
	} catch (error) {
		say(`ROUTES ERR: ${String(error)}`);
	}
	if (LOG && reader) (async () => {
		try {
			const summaries = await reader.listChains(3);
			say(`CHAINS: ${summaries.length} 条`);
			for (const summary of summaries) say(`  · ${summary.ticketId} ${summary.state} steps=${summary.stepCount}`);
			const latest = summaries[0];
			if (!latest) return;
			const chain = await reader.readChain(latest.ticketId);
			if (!chain) {
				say("CHAIN: undefined");
				return;
			}
			say(`CHAIN ${chain.ticketId} stage=${chain.stage} spans=${chain.spans.length}`);
			for (const span of chain.spans) say(`  span ${span.role} ${span.label} ${span.startMs}→${span.endMs}ms ${span.badge ?? ""}`);
			const dispositions = await reader.readDispositions(latest.ticketId);
			say(`DISPOSITIONS: ${dispositions.map((item) => `${item.path}/${item.outcome}`).join(" ")}`);
		} catch (error) {
			say(`READ ERR: ${String(error)}`);
		}
	})();
}
//#endregion
export { apply, inject, name, resolveStateDir };
