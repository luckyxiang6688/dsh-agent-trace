window.__ModuleLoader__.load({
	id: "dsh-superagent-trace",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/boundary.ts
		/**
		* 渲染错误边界：一处组件抛错不能连带卸掉整块面板。
		*
		* 为什么放 `.ts` 而不是 `.tsx`：这里没有一处 JSX，纯 `createElement`；
		* 放在 `.ts` 里才能被 `node --test` 直接 import（Node 的类型剥离不认 `.tsx`），
		* 于是「抛错后兄弟节点还在、兜底文案出来了」可以有单测，而不是只能靠 E2E 猜。
		*/
		var ErrorBoundary = class extends react.Component {
			state = { error: void 0 };
			static getDerivedStateFromError(error) {
				return { error };
			}
			componentDidCatch(_error, _info) {}
			render() {
				const { error } = this.state;
				return error ? this.props.fallback(error) : this.props.children;
			}
		};
		//#endregion
		//#region src/client/api.ts
		const PREFIX = "/agent-trace";
		async function getJson(path) {
			try {
				const response = await fetch(`${PREFIX}${path}`, { headers: { accept: "application/json" } });
				if (!response.ok) return void 0;
				return await response.json();
			} catch {
				return;
			}
		}
		async function fetchStatus() {
			return getJson("/status");
		}
		async function fetchSources() {
			const data = await getJson("/sources");
			return Array.isArray(data?.items) ? data.items : void 0;
		}
		async function fetchSourceEvents(source, limit, cursor) {
			const query = new URLSearchParams({ limit: String(limit) });
			if (cursor) query.set("cursor", cursor);
			return getJson(`/sources/${encodeURIComponent(source)}/events?${query.toString()}`);
		}
		async function fetchSourceEvent(source, triggerId) {
			return (await getJson(`/sources/${encodeURIComponent(source)}/events/${encodeURIComponent(triggerId)}`))?.detail;
		}
		async function fetchSourceEventText(source, triggerId) {
			const data = await getJson(`/sources/${encodeURIComponent(source)}/events/${encodeURIComponent(triggerId)}/text`);
			return typeof data?.text === "string" ? data.text : void 0;
		}
		async function fetchChains(limit, source) {
			const data = await getJson(`/chains?${source ? `limit=${limit}&source=${encodeURIComponent(source)}` : `limit=${limit}`}`);
			return Array.isArray(data?.items) ? data.items : void 0;
		}
		async function fetchChain(ticketId) {
			const data = await getJson(`/chains/${encodeURIComponent(ticketId)}`);
			if (!data?.chain) return void 0;
			return {
				chain: data.chain,
				dispositions: data.dispositions ?? []
			};
		}
		async function fetchSpanDetail(ticketId, spanId) {
			return (await getJson(`/spans/${encodeURIComponent(ticketId)}/${encodeURIComponent(spanId)}`))?.detail;
		}
		async function fetchLink(ticketId, linkId) {
			return (await getJson(`/links/${encodeURIComponent(ticketId)}/${encodeURIComponent(linkId)}`))?.link;
		}
		async function fetchText(ticketId, textId) {
			const data = await getJson(`/texts/${encodeURIComponent(ticketId)}/${encodeURIComponent(textId)}`);
			return typeof data?.text === "string" ? data.text : void 0;
		}
		/** 翻译由用户主动触发；失败返回 undefined，调用方保留原文即可。 */
		async function translateTexts(texts) {
			try {
				const response = await fetch(`${PREFIX}/translate`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ texts })
				});
				if (!response.ok) return void 0;
				return await response.json();
			} catch {
				return;
			}
		}
		//#endregion
		//#region src/client/labels.ts
		/**
		* 界面上的短标签。抽成纯函数是为了能被 `node --test` 直接 import：
		* 组件文件是 `.tsx`，Node 的类型剥离不认这个扩展名（ERR_UNKNOWN_FILE_EXTENSION），
		* 一行字符串拼接若留在组件里，就只能靠肉眼或整套 E2E 才能验。
		*/
		/** 关联工单按钮上的文案：`标题 · 短 id`，跨来源时补 ` · 来源 X`。 */
		function relatedTicketLabel(ticket, currentSource) {
			const base = `${ticket.title ?? "工单"} · ${ticket.ticketId.slice(0, 8)}`;
			return ticket.source && ticket.source !== currentSource ? `${base} · 来源 ${ticket.source}` : base;
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* 页面的内联样式。同一个对象被工单视图、来源页、两个抽屉共用，
		* 所以只能有一份——颜色、圆角、抽屉宽度不许各写一套。
		*/
		const styles = {
			app: {
				display: "grid",
				gridTemplateColumns: "var(--trace-rail, 268px) minmax(0,1fr)",
				height: "100%",
				minHeight: 0,
				position: "relative"
			},
			rail: {
				borderRight: "1px solid #e6e8eb",
				background: "#fbfbfc",
				padding: "12px 10px",
				overflow: "auto",
				transition: "width .16s"
			},
			railCollapsed: {
				width: 56,
				padding: "12px 6px"
			},
			railHead: {
				display: "flex",
				alignItems: "center",
				margin: "0 0 10px 4px"
			},
			railToggle: {
				marginLeft: "auto",
				border: "1px solid #e6e8eb",
				background: "#fff",
				borderRadius: 6,
				width: 22,
				height: 22,
				cursor: "pointer",
				color: "#8a93a0",
				fontSize: 11,
				lineHeight: 1,
				padding: 0
			},
			dot: {
				display: "block",
				width: 8,
				height: 8,
				margin: "0 auto",
				borderRadius: 4,
				background: "#34d399"
			},
			itemCollapsed: {
				padding: "11px 0",
				textAlign: "center"
			},
			railTitle: {
				fontSize: 11.5,
				color: "#9aa1ab",
				letterSpacing: ".05em",
				margin: "0 0 10px 8px"
			},
			item: {
				display: "block",
				width: "100%",
				textAlign: "left",
				padding: "9px 10px",
				marginBottom: 4,
				border: "1px solid transparent",
				borderRadius: 8,
				background: "transparent",
				cursor: "pointer"
			},
			itemOn: {
				background: "#eef1f5",
				borderColor: "#e2e6ea"
			},
			itemName: {
				fontSize: 12.5,
				fontWeight: 600,
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis"
			},
			itemMeta: {
				fontSize: 11,
				color: "#9aa1ab",
				marginTop: 3
			},
			itemState: {
				fontSize: 11,
				color: "#9aa1ab"
			},
			itemSummary: {
				fontSize: 11,
				color: "#7c8698",
				marginTop: 2,
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis"
			},
			main: {
				padding: "20px 24px",
				overflow: "auto",
				minWidth: 0
			},
			/** 覆盖层里的工单正文：滚动交给外层，这里只负责内边距。 */
			ticketBody: {
				padding: "16px 24px 28px",
				minWidth: 0
			},
			title: {
				fontSize: 18,
				fontWeight: 650,
				margin: "0 0 4px"
			},
			identity: {
				fontSize: 12,
				color: "#6b7280",
				marginBottom: 2,
				wordBreak: "break-all"
			},
			sub: {
				fontSize: 12.5,
				color: "#6b7280",
				marginBottom: 12
			},
			canvas: {
				border: "1px solid #e6e8eb",
				borderRadius: 12,
				background: "#fff",
				padding: 12
			},
			barCard: {
				border: "1px solid #e6e8eb",
				borderRadius: 12,
				background: "#fff",
				padding: "12px 14px",
				marginBottom: 12
			},
			barHead: {
				display: "flex",
				alignItems: "baseline",
				fontSize: 12.5,
				color: "#334155",
				marginBottom: 10
			},
			barTotal: {
				marginLeft: "auto",
				fontSize: 11.5,
				color: "#9aa1ab"
			},
			barTrack: {
				display: "flex",
				height: 10,
				borderRadius: 6,
				overflow: "hidden",
				background: "#f1f3f5"
			},
			legend: {
				display: "flex",
				flexWrap: "wrap",
				gap: "6px 16px",
				marginTop: 10,
				fontSize: 11.5,
				color: "#64748b"
			},
			legendItem: {
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				cursor: "pointer"
			},
			legendOff: {
				color: "#c2c8d0",
				cursor: "default"
			},
			swatch: {
				width: 8,
				height: 8,
				borderRadius: 2,
				display: "inline-block"
			},
			barTitle: { display: "none" },
			scroller: {
				overflow: "auto",
				maxHeight: "72vh",
				borderTop: "1px solid #f2f4f6"
			},
			svg: {
				display: "block",
				width: 900,
				minHeight: 520,
				height: "auto"
			},
			drawer: {
				position: "absolute",
				top: 0,
				right: 0,
				bottom: 0,
				width: 380,
				borderLeft: "1px solid #e6e8eb",
				background: "#fff",
				overflow: "auto",
				boxShadow: "-8px 0 24px rgba(15,23,42,.08)",
				zIndex: 5
			},
			drawerHead: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "14px 16px",
				borderBottom: "1px solid #e6e8eb"
			},
			drawerBody: {
				padding: "10px 16px 20px",
				fontSize: 12.5,
				color: "#475569"
			},
			sec: { marginTop: 14 },
			secHead: {
				display: "flex",
				alignItems: "center",
				marginBottom: 6
			},
			secAction: {
				marginLeft: "auto",
				border: "1px solid #e6e8eb",
				background: "#fff",
				borderRadius: 6,
				padding: "1px 8px",
				fontSize: 11,
				color: "#475569",
				cursor: "pointer"
			},
			secTitle: {
				fontSize: 11,
				color: "#9aa1ab",
				letterSpacing: ".06em",
				marginBottom: 0
			},
			linkSub: {
				fontSize: 11,
				color: "#9aa1ab",
				marginBottom: 10,
				letterSpacing: ".04em"
			},
			lead: {
				display: "flex",
				gap: 8,
				alignItems: "flex-start",
				background: "#f8fafc",
				borderLeft: "3px solid #c7d2fe",
				borderRadius: 6,
				padding: "8px 10px",
				marginTop: 6,
				lineHeight: 1.6,
				color: "#334155"
			},
			leadTag: {
				flex: "none",
				fontSize: 10.5,
				color: "#9aa1ab",
				letterSpacing: ".04em",
				paddingTop: 2
			},
			proseClamp: {
				display: "-webkit-box",
				WebkitLineClamp: 4,
				WebkitBoxOrient: "vertical",
				overflow: "hidden"
			},
			proseFull: {
				maxHeight: 320,
				overflowY: "auto"
			},
			proseBar: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				marginTop: 3
			},
			proseToggle: {
				marginLeft: "auto",
				border: "1px solid #e6e8eb",
				background: "#fff",
				borderRadius: 6,
				padding: "1px 8px",
				fontSize: 11,
				color: "#475569",
				cursor: "pointer"
			},
			proseError: {
				fontSize: 11,
				color: "#b45309"
			},
			fieldProse: {
				flex: 1,
				minWidth: 0
			},
			quoteIn: {
				background: "#f7f8fa",
				border: "1px solid #eceef1",
				borderRadius: 8,
				padding: "8px 10px",
				lineHeight: 1.6,
				whiteSpace: "pre-wrap",
				color: "#475569"
			},
			quoteSay: {
				background: "#eef7f1",
				border: "1px solid #d6ecdf",
				borderRadius: 8,
				padding: "8px 10px",
				lineHeight: 1.6,
				whiteSpace: "pre-wrap",
				color: "#2f5c46"
			},
			checkItem: {
				padding: "8px 0 8px 10px",
				borderLeft: "3px solid #dfe3ea",
				marginBottom: 4
			},
			checkOk: { borderLeftColor: "#8fd3ac" },
			checkWarn: { borderLeftColor: "#f0c184" },
			checkHead: {
				display: "flex",
				alignItems: "center",
				gap: 8
			},
			checkName: {
				fontSize: 12,
				fontWeight: 600,
				color: "#334155"
			},
			checkNote: {
				fontSize: 11.5,
				color: "#8a93a0",
				marginTop: 3,
				lineHeight: 1.5
			},
			pill: {
				fontSize: 10,
				borderRadius: 4,
				padding: "1px 6px",
				marginLeft: "auto"
			},
			pillOk: {
				color: "#177245",
				background: "#e8f6ee"
			},
			pillWarn: {
				color: "#a15c00",
				background: "#fdf1e0"
			},
			pillMuted: {
				color: "#6b7280",
				background: "#f1f3f5"
			},
			badges: {
				display: "flex",
				flexWrap: "wrap",
				gap: 6,
				marginTop: 4
			},
			badge: {
				fontSize: 10.5,
				color: "#475569",
				background: "#f1f3f5",
				borderRadius: 5,
				padding: "1px 7px"
			},
			stepBlock: {
				border: "1px solid #eceef1",
				borderRadius: 8,
				padding: "8px 10px",
				marginTop: 10
			},
			stepHead: {
				fontSize: 11.5,
				color: "#64748b",
				marginBottom: 6
			},
			stepModel: {
				fontSize: 10.5,
				color: "#8a6a1f"
			},
			rows: {
				border: "1px solid #eceef1",
				borderRadius: 8,
				overflow: "hidden"
			},
			row: {
				display: "grid",
				gridTemplateColumns: "72px 1fr",
				gap: 10,
				padding: "7px 10px",
				borderBottom: "1px solid #f2f4f6"
			},
			rowLabel: {
				color: "#9aa1ab",
				fontSize: 11.5
			},
			rowValue: {
				color: "#334155",
				wordBreak: "break-word",
				lineHeight: 1.5
			},
			pending: {
				marginTop: 6,
				fontSize: 11.5,
				color: "#9aa1ab"
			},
			original: {
				marginTop: 8,
				fontSize: 11.5,
				color: "#9aa1ab"
			},
			originalSummary: { cursor: "pointer" },
			originalText: {
				marginTop: 6,
				padding: "6px 8px",
				background: "#fbfbfc",
				borderRadius: 6,
				color: "#7c8698",
				lineHeight: 1.5
			},
			quote: {
				background: "#f7f8fa",
				border: "1px solid #eceef1",
				borderRadius: 8,
				padding: "8px 10px",
				lineHeight: 1.6,
				whiteSpace: "pre-wrap"
			},
			quoteThink: {
				background: "#f5f3fd",
				border: "1px solid #e7e2fb",
				borderRadius: 8,
				padding: "9px 11px",
				lineHeight: 1.65,
				whiteSpace: "pre-wrap",
				color: "#3b3557"
			},
			action: {
				border: "1px solid #eceef1",
				borderRadius: 8,
				padding: "8px 10px",
				marginBottom: 6
			},
			actionFailed: {
				borderColor: "#f0cfa0",
				background: "#fefaf3"
			},
			actionTool: {
				fontSize: 12,
				fontWeight: 600,
				color: "#334155",
				marginBottom: 4
			},
			toolRaw: {
				marginLeft: 6,
				fontSize: 10.5,
				fontWeight: 400,
				color: "#9aa1ab"
			},
			field: {
				display: "grid",
				gridTemplateColumns: "64px 1fr",
				gap: 8,
				padding: "2px 0"
			},
			fieldLabel: {
				color: "#9aa1ab",
				fontSize: 11.5
			},
			fieldValue: {
				color: "#334155",
				wordBreak: "break-word"
			},
			/** 结果行没有正文可读：比内容字段更轻，避免和参数抢注意力。 */
			fieldMeta: {
				color: "#8a93a0",
				fontSize: 11.5,
				wordBreak: "break-word"
			},
			truncNote: {
				marginTop: 8,
				padding: "6px 8px",
				borderRadius: 6,
				background: "#fff8e6",
				color: "#8a6a1f",
				fontSize: 11.5,
				lineHeight: 1.5
			},
			fieldCode: {
				color: "#334155",
				fontFamily: "ui-monospace, SFMono-Regular, monospace",
				fontSize: 11.5,
				background: "#f4f5f7",
				borderRadius: 4,
				padding: "1px 5px",
				wordBreak: "break-all"
			},
			headAction: {
				marginLeft: "auto",
				border: "1px solid #e6e8eb",
				background: "#fff",
				borderRadius: 6,
				padding: "2px 10px",
				fontSize: 11.5,
				color: "#475569",
				cursor: "pointer"
			},
			headActionBusy: {
				color: "#9aa1ab",
				cursor: "default"
			},
			close: {
				marginLeft: "auto",
				border: "1px solid #e6e8eb",
				background: "#fff",
				borderRadius: 6,
				width: 24,
				height: 24,
				cursor: "pointer"
			},
			empty: {
				color: "#9aa1ab",
				fontSize: 13
			},
			error: {
				color: "#a15c00",
				background: "#fef7ec",
				border: "1px dashed #f0cfa0",
				borderRadius: 8,
				padding: "8px 12px",
				marginBottom: 12
			},
			/** 渲染崩了的兜底：说得清是什么坏了、还能怎么办，不带栈也不带数据。 */
			crashed: {
				margin: 16,
				padding: "14px 16px",
				border: "1px solid #f0cfa0",
				background: "#fef7ec",
				borderRadius: 10,
				color: "#7a4600"
			},
			crashedTitle: {
				fontSize: 13.5,
				fontWeight: 650,
				marginBottom: 6
			},
			crashedHint: {
				fontSize: 12,
				color: "#8a6a3a",
				lineHeight: 1.6
			},
			/** 未配置时的整页说明：没有左栏、没有事件流，只有原因和下一步。 */
			unconfiguredPane: {
				height: "100%",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				padding: 24
			},
			unconfiguredCard: {
				maxWidth: 560,
				border: "1px solid #e6e8eb",
				background: "#fff",
				borderRadius: 10,
				padding: "20px 22px",
				display: "flex",
				flexDirection: "column",
				gap: 8
			},
			/** 主区：工单覆盖层与抽屉都相对它定位（inset:0 才是「盖住右侧内容」）。 */
			mainPane: {
				position: "relative",
				minWidth: 0,
				minHeight: 0,
				height: "100%",
				overflow: "hidden"
			},
			railShell: {
				display: "flex",
				flexDirection: "column",
				height: "100%",
				minHeight: 0,
				borderRight: "1px solid #e6e8eb",
				background: "#fbfbfc",
				transition: "width .16s"
			},
			railHeadBar: {
				display: "flex",
				alignItems: "center",
				padding: "12px 10px 8px",
				flex: "none"
			},
			/** 两区与分隔条的共同容器：比例只对着它量（标题栏不算）。 */
			railBody: {
				display: "flex",
				flexDirection: "column",
				flex: 1,
				minHeight: 0
			},
			railSection: {
				overflowY: "auto",
				overflowX: "hidden",
				minHeight: 0,
				padding: "0 10px"
			},
			railSplit: {
				flex: "none",
				height: 9,
				cursor: "row-resize",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				touchAction: "none"
			},
			railSplitBar: {
				width: 30,
				height: 3,
				borderRadius: 2,
				background: "#e2e6ea"
			},
			railSplitOn: { background: "#c7cdd6" },
			railSectionTitle: {
				fontSize: 11,
				color: "#9aa1ab",
				letterSpacing: ".06em",
				padding: "6px 8px 4px"
			},
			railFoot: {
				flex: "none",
				padding: "8px 10px 12px"
			},
			sourceRow: {
				display: "block",
				width: "100%",
				textAlign: "left",
				padding: "8px 10px",
				marginBottom: 4,
				border: "1px solid transparent",
				borderRadius: 8,
				background: "transparent",
				cursor: "pointer"
			},
			sourceRowOff: {
				color: "#c2c8d0",
				cursor: "default"
			},
			sourceName: {
				fontSize: 12.5,
				fontWeight: 600,
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis"
			},
			sourceMeta: {
				fontSize: 11,
				color: "#9aa1ab",
				marginTop: 3
			},
			sourceWarn: { color: "#a15c00" },
			sourcePane: {
				display: "flex",
				flexDirection: "column",
				height: "100%",
				minHeight: 0
			},
			sourceView: {
				padding: "20px 24px",
				overflow: "auto",
				minHeight: 0,
				flex: 1
			},
			sourceTitle: {
				fontSize: 18,
				fontWeight: 650,
				margin: "0 0 4px"
			},
			statLine: {
				fontSize: 12,
				color: "#6b7280",
				marginBottom: 12,
				display: "flex",
				gap: 12,
				flexWrap: "wrap"
			},
			statStrong: {
				color: "#334155",
				fontWeight: 600
			},
			filterChip: {
				fontSize: 11,
				color: "#475569",
				background: "#eef1f5",
				borderRadius: 10,
				padding: "2px 9px",
				cursor: "pointer",
				display: "inline-flex",
				gap: 6,
				alignItems: "center"
			},
			eventList: {
				border: "1px solid #e6e8eb",
				borderRadius: 12,
				background: "#fff",
				overflow: "hidden"
			},
			eventRow: {
				display: "grid",
				gridTemplateColumns: "64px 96px minmax(0,1fr)",
				gap: 10,
				alignItems: "baseline",
				width: "100%",
				textAlign: "left",
				padding: "8px 12px 8px 10px",
				border: 0,
				borderLeft: "3px solid #e5e7eb",
				borderBottom: "1px solid #f4f6f8",
				background: "transparent",
				cursor: "pointer",
				fontSize: 12
			},
			eventRowOn: { background: "#f7f9fb" },
			eventRowHover: { background: "#f5f7fa" },
			detailChip: {
				marginLeft: 6,
				fontSize: 10.5,
				color: "#64748b",
				background: "#f1f5f9",
				border: 0,
				borderRadius: 5,
				padding: "1px 7px",
				cursor: "pointer",
				whiteSpace: "nowrap"
			},
			eventTime: {
				color: "#9aa1ab",
				fontSize: 11,
				whiteSpace: "nowrap"
			},
			eventFate: {
				fontSize: 10.5,
				whiteSpace: "nowrap"
			},
			eventText: {
				color: "#334155",
				display: "flex",
				alignItems: "center",
				gap: 4,
				minWidth: 0,
				overflow: "hidden"
			},
			eventLabel: {
				minWidth: 0,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			eventEmpty: {
				padding: "18px 14px",
				color: "#9aa1ab",
				fontSize: 12.5
			},
			loadMore: {
				margin: "10px 0 20px",
				border: "1px solid #e6e8eb",
				background: "#fff",
				borderRadius: 8,
				padding: "6px 12px",
				fontSize: 12,
				color: "#475569",
				cursor: "pointer"
			},
			ticketChip: {
				marginLeft: 6,
				fontSize: 10.5,
				color: "#4f46e5",
				background: "#eef0ff",
				borderRadius: 5,
				padding: "1px 6px"
			},
			notRecorded: {
				marginTop: 6,
				fontSize: 11.5,
				color: "#8a93a0",
				lineHeight: 1.55
			},
			notRecordedItem: {
				marginTop: 4,
				paddingLeft: 10,
				borderLeft: "2px solid #eceef1"
			},
			interpretation: {
				marginTop: 6,
				fontSize: 11.5,
				color: "#475569",
				lineHeight: 1.6,
				background: "#f8fafc",
				borderLeft: "3px solid #c7d2fe",
				borderRadius: 6,
				padding: "7px 9px"
			},
			interpTag: {
				fontSize: 10,
				color: "#6d6ad8",
				letterSpacing: ".04em",
				marginRight: 6
			},
			openTicket: {
				marginTop: 8,
				border: "1px solid #d9dce3",
				background: "#fff",
				borderRadius: 7,
				padding: "5px 10px",
				fontSize: 12,
				color: "#4338ca",
				cursor: "pointer"
			},
			overlay: {
				position: "absolute",
				inset: 0,
				background: "#f7f8fa",
				zIndex: 6,
				display: "flex",
				flexDirection: "column",
				borderLeft: "1px solid #e2e6ea",
				boxShadow: "-10px 0 28px rgba(15,23,42,.10)",
				minHeight: 0
			},
			overlayHead: {
				flex: "none",
				display: "flex",
				alignItems: "center",
				gap: 12,
				padding: "10px 16px",
				borderBottom: "1px solid #e6e8eb",
				background: "#fff",
				paddingTop: "max(10px, var(--dsh-frame-top-clearance, 0px))"
			},
			overlayBack: {
				border: "1px solid #e6e8eb",
				background: "#fff",
				borderRadius: 7,
				padding: "3px 10px",
				fontSize: 12,
				color: "#475569",
				cursor: "pointer"
			},
			overlayCrumb: {
				fontSize: 11.5,
				color: "#9aa1ab",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			overlayBody: {
				flex: 1,
				minHeight: 0,
				overflow: "auto"
			},
			hidden: { visibility: "hidden" }
		};
		//#endregion
		//#region src/client/EventDrawer.tsx
		/**
		* 来源事件抽屉。骨架沿用旧抽屉（380px、`aside` + `b` + 关闭按钮）：
		* E2E 靠这个形状识别抽屉，换皮不换骨。
		*
		* 段序固定：原文 → 事实 → 解释 → 没记录的事实 → 线程 → 关联工单。
		* 先看这条消息自己说了什么，再看系统怎么判它；三段的口径必须分开：
		*   原文     —— 这条事件的原话，只回预览，点「展开全文」才取；
		*   事实     —— 库里写下的字段，原文照录；
		*   解释     —— 由原因码查表得来，明确标「解释」，不是记录；
		*   没记录的事实 —— 库没写、也不能靠猜补的，逐条声明。
		* 每段只放数据，不放「这段是怎么来的」旁注——那是实现约束，摆在抽屉里像在免责。
		*/
		function EventDrawer(props) {
			const { detail } = props;
			const primary = detail?.relatedTickets[0]?.ticketId;
			return (0, react.createElement)("aside", {
				"data-drawer": "1",
				style: styles.drawer
			}, (0, react.createElement)("div", { style: styles.drawerHead }, (0, react.createElement)("b", null, detail?.title ?? "事件详情"), (0, react.createElement)("button", {
				style: styles.close,
				onClick: props.onClose
			}, "×")), (0, react.createElement)("div", { style: styles.drawerBody }, props.error ? (0, react.createElement)("div", { style: styles.error }, `读不到事件：${props.error}`) : !detail ? (0, react.createElement)("div", { style: styles.pending }, "读取中…") : [
				detail.text ? section("原文", [(0, react.createElement)(SourceProse, {
					key: "prose",
					source: props.source,
					triggerId: detail.triggerId,
					prose: detail.text
				})]) : null,
				section("事实", detail.facts.map((fact, index) => (0, react.createElement)("div", {
					key: index,
					"data-fact": fact.label,
					style: {
						...styles.checkItem,
						...fact.tone === "ok" ? styles.checkOk : fact.tone === "warn" ? styles.checkWarn : {}
					}
				}, (0, react.createElement)("div", { style: styles.checkName }, fact.label), (0, react.createElement)("div", { style: styles.checkNote }, fact.value)))),
				detail.interpretations.length ? section("解释", [...detail.interpretations.map((item, index) => (0, react.createElement)("div", {
					key: index,
					"data-interp": "1",
					style: styles.interpretation
				}, (0, react.createElement)("span", { style: styles.interpTag }, "解释"), (0, react.createElement)("span", { style: { fontWeight: 600 } }, item.label), `：${item.text}`))]) : null,
				detail.notRecorded.length ? section("没记录的事实", detail.notRecorded.map((text, index) => (0, react.createElement)("div", {
					key: index,
					style: styles.notRecordedItem
				}, text))) : null,
				detail.threads.length ? section("线程", [...detail.threads.map((thread) => (0, react.createElement)("div", {
					key: thread.key,
					style: styles.stepBlock
				}, (0, react.createElement)("div", { style: styles.stepHead }, thread.label ?? thread.key), (0, react.createElement)("div", { style: styles.field }, (0, react.createElement)("span", { style: styles.fieldLabel }, "线程"), (0, react.createElement)("span", { style: styles.fieldValue }, thread.key)), (0, react.createElement)("div", { style: styles.field }, (0, react.createElement)("span", { style: styles.fieldLabel }, "订阅"), (0, react.createElement)("span", { style: styles.fieldValue }, thread.subscriptions.length ? thread.subscriptions.join(" · ") : "没有")), (0, react.createElement)("div", { style: styles.field }, (0, react.createElement)("span", { style: styles.fieldLabel }, "仅上下文"), (0, react.createElement)("span", { style: styles.fieldMeta }, thread.context.length ? thread.context.join(" · ") : "没有")), thread.lastAt ? (0, react.createElement)("div", { style: styles.field }, (0, react.createElement)("span", { style: styles.fieldLabel }, "最近活动"), (0, react.createElement)("span", { style: styles.fieldMeta }, thread.lastAt)) : null))]) : null,
				detail.relatedTickets.length ? section("关联工单", [...detail.relatedTickets.map((ticket) => (0, react.createElement)("button", {
					key: ticket.ticketId,
					style: styles.openTicket,
					onClick: () => props.onOpenTicket(ticket.ticketId)
				}, relatedTicketLabel(ticket, props.source))), primary ? (0, react.createElement)("button", {
					key: "primary",
					style: {
						...styles.openTicket,
						borderColor: "#c7c9f5",
						fontWeight: 600
					},
					onClick: () => props.onOpenTicket(primary)
				}, "打开工单时序图 →") : null]) : null
			]));
		}
		function section(title, content) {
			return (0, react.createElement)("div", {
				key: title,
				style: styles.sec
			}, (0, react.createElement)("div", {
				"data-drawer-section": title,
				style: styles.secTitle
			}, title), ...content.filter(Boolean));
		}
		/**
		* 原文：默认显示预览；超过预览长度时给「展开全文」，点了才取全文。
		* 取不到就明说，预览不消失——源码可读性差的时候不要把它变成空白。
		*/
		function SourceProse(props) {
			const { prose } = props;
			const [open, setOpen] = (0, react.useState)(false);
			const [full, setFull] = (0, react.useState)();
			const [loading, setLoading] = (0, react.useState)(false);
			const [failed, setFailed] = (0, react.useState)(false);
			const expandable = prose.length > prose.text.length;
			const body = open && full !== void 0 ? full : prose.text;
			const toggle = async () => {
				if (open) {
					setOpen(false);
					return;
				}
				if (full !== void 0) {
					setOpen(true);
					return;
				}
				setLoading(true);
				setFailed(false);
				const text = await fetchSourceEventText(props.source, props.triggerId);
				setLoading(false);
				if (text === void 0) {
					setFailed(true);
					return;
				}
				setFull(text);
				setOpen(true);
			};
			return (0, react.createElement)("div", null, (0, react.createElement)("div", { style: {
				...styles.quoteIn,
				...open ? styles.proseFull : {}
			} }, body), expandable || open ? (0, react.createElement)("div", { style: styles.proseBar }, failed ? (0, react.createElement)("span", { style: styles.proseError }, "原文已不可读") : null, (0, react.createElement)("button", {
				style: styles.proseToggle,
				disabled: loading,
				onClick: () => void toggle()
			}, loading ? "读取中…" : open ? "收起" : `展开全文 · ${prose.length} 字`)) : null);
		}
		//#endregion
		//#region src/client/escape.ts
		const stack = [];
		let installed = false;
		/** 只弹栈顶。返回是否消费了这次 Esc（空栈 → false，交给别人处理）。 */
		function handleEscape() {
			const top = stack[stack.length - 1];
			if (!top) return false;
			top();
			return true;
		}
		function onKeyDown(event) {
			if (event.key !== "Escape") return;
			if (!handleEscape()) return;
			event.stopPropagation();
		}
		function install() {
			if (installed || typeof document === "undefined") return;
			installed = true;
			document.addEventListener("keydown", onKeyDown, true);
		}
		/**
		* 压一个「关掉我」的动作。返回取消函数：幂等，重复调用不会误删别人的条目。
		* 组件卸载时必须调用它——否则关掉的抽屉还挂在栈上，Esc 会被吃掉。
		*/
		function pushEscape(close) {
			install();
			stack.push(close);
			return () => {
				const index = stack.lastIndexOf(close);
				if (index >= 0) stack.splice(index, 1);
			};
		}
		//#endregion
		//#region src/client/split.ts
		/**
		* 左栏上下两区的分隔比例。
		*
		* 比例存的是「上区占左栏高度的百分比」，不是像素：换窗口大小、换机器都还对。
		* 存储里的坏值（NaN、越界、非数字）一律回落默认值，不抛——脏数据只影响一次布局。
		*/
		const SPLIT_KEY = "dsh-superagent-trace:rail-split:v1";
		const DEFAULT_RATIO = .55;
		const MIN_RATIO = .15;
		const MAX_RATIO = .85;
		function clampRatio(value) {
			if (!Number.isFinite(value)) return DEFAULT_RATIO;
			return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
		}
		function storage() {
			try {
				return typeof localStorage === "undefined" ? void 0 : localStorage;
			} catch {
				return;
			}
		}
		function readStoredRatio(source = storage()) {
			if (!source) return DEFAULT_RATIO;
			try {
				const raw = source.getItem(SPLIT_KEY);
				if (raw === null || raw.trim() === "") return DEFAULT_RATIO;
				const value = Number(raw);
				return Number.isFinite(value) ? clampRatio(value) : DEFAULT_RATIO;
			} catch {
				return DEFAULT_RATIO;
			}
		}
		function writeStoredRatio(ratio, target = storage()) {
			if (!target) return;
			try {
				target.setItem(SPLIT_KEY, String(clampRatio(ratio)));
			} catch {}
		}
		/** 指针位置 → 比例。容器高度为 0（还没布局）时给默认值，别除零。 */
		function ratioFromPointer(clientY, top, height) {
			if (!Number.isFinite(height) || height <= 0) return DEFAULT_RATIO;
			return clampRatio((clientY - top) / height);
		}
		function splitterUsable(height) {
			return Number.isFinite(height) && height >= 160;
		}
		//#endregion
		//#region src/client/Splitter.tsx
		/**
		* 左栏两区之间的横线。拖拽用 pointer capture（指针滑出去也继续跟手），
		* 位移按 rAF 合并——每像素都 setState 会让整个来源页跟着重渲染。
		*/
		function Splitter(props) {
			const [dragging, setDragging] = (0, react.useState)(false);
			const latest = (0, react.useRef)(props.ratio);
			const frame = (0, react.useRef)(0);
			const cancelFrame = () => {
				if (!frame.current) return;
				cancelAnimationFrame(frame.current);
				frame.current = 0;
			};
			const ratioAt = (clientY) => {
				const box = props.measure();
				if (!box) return props.ratio;
				return ratioFromPointer(clientY, box.top, box.height);
			};
			const onPointerDown = (event) => {
				event.preventDefault();
				try {
					event.currentTarget.setPointerCapture?.(event.pointerId);
				} catch {}
				latest.current = props.ratio;
				setDragging(true);
			};
			const onPointerMove = (event) => {
				if (!dragging) return;
				latest.current = ratioAt(event.clientY);
				if (frame.current) return;
				frame.current = requestAnimationFrame(() => {
					frame.current = 0;
					props.onChange(latest.current);
				});
			};
			const onPointerUp = (event) => {
				if (!dragging) return;
				setDragging(false);
				cancelFrame();
				try {
					event.currentTarget.releasePointerCapture?.(event.pointerId);
				} catch {}
				props.onChange(latest.current);
				props.onCommit(latest.current);
			};
			const onKeyDown = (event) => {
				if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
				event.preventDefault();
				const next = clampRatio(props.ratio + (event.key === "ArrowDown" ? .02 : -.02));
				props.onChange(next);
				props.onCommit(next);
			};
			return (0, react.createElement)("div", {
				"data-splitter": "1",
				role: "separator",
				"aria-orientation": "horizontal",
				"aria-valuenow": Math.round(props.ratio * 100),
				"aria-valuemin": Math.round(MIN_RATIO * 100),
				"aria-valuemax": Math.round(MAX_RATIO * 100),
				"aria-label": "调整来源与工单两区高度",
				tabIndex: 0,
				title: "拖动调整两区高度（或用 ↑ ↓）",
				style: styles.railSplit,
				onPointerDown,
				onPointerMove,
				onPointerUp,
				onPointerCancel: onPointerUp,
				onKeyDown
			}, (0, react.createElement)("span", { style: {
				...styles.railSplitBar,
				...dragging ? styles.railSplitOn : {}
			} }));
		}
		//#endregion
		//#region src/client/Rail.tsx
		/**
		* 左栏：上面「来源」，中间可拖的横线，下面「工单」。
		*
		* 两组各自滚动、各自有独立高度——来源列表长了不能把工单列表挤没，
		* 反过来也一样。折叠按钮保留自旧版，折叠时横线不画（56px 宽没有拖的意义）。
		*
		* 这里**不许出现 `<b>`**：E2E 用「aside 里有 b 且第一个按钮是关闭」识别抽屉。
		*/
		function Rail(props) {
			const { collapsed } = props;
			const body = (0, react.useRef)(null);
			const [usable, setUsable] = (0, react.useState)(true);
			(0, react.useLayoutEffect)(() => {
				const element = body.current;
				if (!element) return;
				const measure = () => setUsable(splitterUsable(element.getBoundingClientRect().height));
				measure();
				if (typeof ResizeObserver === "undefined") return;
				const observer = new ResizeObserver(measure);
				observer.observe(element);
				return () => observer.disconnect();
			}, []);
			return (0, react.createElement)("aside", { style: {
				...styles.railShell,
				...collapsed ? { width: 56 } : {}
			} }, (0, react.createElement)("div", { style: styles.railHeadBar }, collapsed ? null : (0, react.createElement)("span", { style: {
				...styles.railTitle,
				margin: 0
			} }, "来源与工单"), (0, react.createElement)("button", {
				style: styles.railToggle,
				title: collapsed ? "展开" : "收起",
				onClick: props.onToggle
			}, collapsed ? "»" : "«")), (0, react.createElement)("div", {
				ref: body,
				"data-rail-body": "1",
				style: styles.railBody
			}, (0, react.createElement)("div", {
				"data-rail-sources": "1",
				style: {
					...styles.railSection,
					flexBasis: `${props.ratio * 100}%`,
					flexGrow: 0,
					flexShrink: 0
				}
			}, collapsed ? null : (0, react.createElement)("div", { style: styles.railSectionTitle }, "来源"), props.sources.length === 0 ? (0, react.createElement)("div", { style: styles.railFoot }, (0, react.createElement)("span", { style: styles.empty }, "还没有来源")) : props.sources.map((item) => {
				const name = item.label ?? item.source;
				const empty = item.received === 0;
				return (0, react.createElement)("button", {
					key: item.source,
					"data-source-row": item.source,
					title: empty ? `${name} · 没有事件` : `${name} · ${item.received} 条事件`,
					onClick: () => props.onPickSource(item.source),
					style: {
						...styles.sourceRow,
						...item.source === props.activeSource ? styles.itemOn : {},
						...empty && item.source !== props.activeSource ? styles.sourceRowOff : {}
					}
				}, collapsed ? (0, react.createElement)("div", { style: {
					...styles.itemCollapsed,
					padding: 0
				} }, name.slice(0, 2)) : [(0, react.createElement)("div", {
					key: "n",
					style: styles.sourceName
				}, name), (0, react.createElement)("div", {
					key: "m",
					style: styles.sourceMeta
				}, item.enabled === false ? (0, react.createElement)("span", { style: styles.sourceWarn }, "未启用") : empty ? "没有事件" : `${item.received} 条事件 · ${item.tickets} 张工单`)]);
			})), collapsed || !usable ? null : (0, react.createElement)(Splitter, {
				ratio: props.ratio,
				measure: () => body.current?.getBoundingClientRect() ?? null,
				onChange: props.onRatioChange,
				onCommit: props.onRatioCommit
			}), (0, react.createElement)("div", {
				"data-rail-tickets": "1",
				style: {
					...styles.railSection,
					flex: 1,
					borderTop: collapsed ? "1px solid #e6e8eb" : void 0
				}
			}, collapsed ? null : (0, react.createElement)("div", { style: styles.railSectionTitle }, "工单"), props.tickets.length === 0 ? (0, react.createElement)("div", { style: styles.railFoot }, (0, react.createElement)("span", { style: styles.empty }, "还没有工单")) : props.tickets.map((item) => (0, react.createElement)("button", {
				key: item.ticketId,
				"data-ticket-row": item.ticketId,
				title: item.title,
				onClick: () => props.onPickTicket(item.ticketId),
				style: {
					...styles.item,
					...item.ticketId === props.activeTicketId ? styles.itemOn : {},
					...collapsed ? styles.itemCollapsed : {}
				}
			}, collapsed ? (0, react.createElement)("span", { style: styles.dot }) : [
				(0, react.createElement)("div", {
					key: "n",
					style: styles.itemName
				}, item.title),
				(0, react.createElement)("div", {
					key: "m",
					style: styles.itemMeta
				}, (0, react.createElement)("span", { style: styles.itemState }, `${item.state} · ${item.stepCount} 段`)),
				item.summary ? (0, react.createElement)("div", {
					key: "s",
					style: styles.itemSummary
				}, item.summary) : null
			])))));
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
		//#endregion
		//#region src/service/sources.ts
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
		//#endregion
		//#region src/client/SourceView.tsx
		/**
		* 来源页的主内容：去向比例带 + 事件流（新 → 旧，游标分页）。
		*
		* 比例带的图例就是筛选器：点一次只看这一类，再点恢复全部。
		* 注意这里的 DOM 命名不用 `data-link` / `data-legend`——那些只属于工单视图，
		* E2E 会全量收集它们来数时序图的连线，来源页混进来会污染断言。
		*/
		const FATE_ORDER = [
			"routed",
			"direct",
			"context",
			"filtered",
			"requeued",
			"handback",
			"undecided",
			"unrecorded"
		];
		const FATE_COLOR = {
			routed: "#818cf8",
			direct: "#f59e0b",
			context: "#a3b8c9",
			filtered: "#e5e7eb",
			requeued: "#c084fc",
			handback: "#fb7185",
			undecided: "#cbd5e1",
			unrecorded: "#f1f5f9"
		};
		/** 「丢弃/没记录」这类不是好消息也不刺眼：行内文字用更淡的灰。 */
		function fateInk(kind) {
			if (kind === "filtered" || kind === "unrecorded" || kind === "undecided") return "#9aa1ab";
			return FATE_COLOR[kind];
		}
		function countOf(summary, kind) {
			if (kind === "unrecorded") return summary.unrecorded;
			return summary.counts[kind];
		}
		/** 事件的本地时间：只到分钟；没有时间就明说，不补一个假时刻。 */
		function formatWhen(at) {
			if (!at) return "时间未记录";
			const ms = Date.parse(at);
			if (!Number.isFinite(ms)) return "时间未记录";
			const date = new Date(ms);
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}
		function ticketsOf(fate) {
			switch (fate.kind) {
				case "routed": return fate.ticketId ? [fate.ticketId] : [];
				case "direct":
				case "context":
				case "handback": return fate.tickets;
				default: return [];
			}
		}
		function SourceView(props) {
			const { summary, events, filter } = props;
			const name = summary?.label ?? summary?.source ?? "来源";
			const rows = filter ? events.filter((event) => event.fate.kind === filter) : events;
			if (!summary) return (0, react.createElement)("div", { style: styles.sourceView }, props.error ? (0, react.createElement)("div", { style: styles.error }, `读不到来源：${props.error}`) : null, (0, react.createElement)("div", { style: styles.empty }, props.loading ? "读取中…" : "选择一个来源"));
			const total = summary.received;
			return (0, react.createElement)("div", {
				"data-source-view": summary.source,
				style: styles.sourceView
			}, (0, react.createElement)("h1", { style: styles.sourceTitle }, name), props.summary?.label && props.summary.label !== summary.source ? (0, react.createElement)("div", { style: styles.sub }, summary.source) : null, (0, react.createElement)("div", {
				"data-source-stats": "1",
				style: styles.statLine
			}, (0, react.createElement)("span", null, (0, react.createElement)("span", { style: styles.statStrong }, String(summary.received)), " 条事件"), (0, react.createElement)("span", null, (0, react.createElement)("span", { style: styles.statStrong }, String(summary.tickets)), " 张工单"), (0, react.createElement)("span", null, summary.lastAt ? `最后 ${formatWhen(summary.lastAt)}` : "还没有事件"), summary.unrecorded > 0 ? (0, react.createElement)("span", { title: "有事件行但没有去向行" }, `${summary.unrecorded} 条没有去向记录`) : null), total > 0 ? (0, react.createElement)(FateBar, {
				summary,
				filter,
				onToggle: props.onToggleFilter
			}) : null, filter ? (0, react.createElement)("div", { style: styles.statLine }, (0, react.createElement)("button", {
				style: styles.filterChip,
				title: "取消筛选",
				onClick: () => props.onToggleFilter(filter)
			}, `只看 ${FATE_LABEL[filter]} · `, (0, react.createElement)("span", { style: { color: "#9aa1ab" } }, "×"))) : null, (0, react.createElement)("div", { style: styles.eventList }, rows.length === 0 ? (0, react.createElement)("div", { style: styles.eventEmpty }, props.loading ? "读取中…" : total === 0 ? "这个来源还没有事件。" : filter ? `已加载的事件里没有「${FATE_LABEL[filter]}」。` : "这条来源没有可展示的事件。") : rows.map((event) => (0, react.createElement)(EventRow, {
				key: event.triggerId,
				event,
				onOpen: props.onOpenEvent,
				onOpenTicket: props.onOpenTicket
			}))), filter && props.more ? (0, react.createElement)("div", { style: styles.notRecorded }, `筛选只作用于已加载的 ${events.length} 条；更早的事件还没加载。`) : null, props.more ? (0, react.createElement)("button", {
				style: styles.loadMore,
				disabled: props.loadingMore,
				onClick: props.onLoadMore
			}, props.loadingMore ? "加载中…" : "加载更早的事件") : null, props.error ? (0, react.createElement)("div", { style: styles.error }, `读取失败：${props.error}`) : null);
		}
		/** 比例带：段宽按事件数，图例就是筛选入口。 */
		function FateBar(props) {
			const { summary, filter } = props;
			const total = Math.max(summary.received, 1);
			const counts = FATE_ORDER.map((kind) => ({
				kind,
				n: countOf(summary, kind)
			}));
			return (0, react.createElement)("div", { style: styles.barCard }, (0, react.createElement)("div", { style: styles.barHead }, (0, react.createElement)("span", null, "事件去向"), (0, react.createElement)("span", { style: styles.barTotal }, `${summary.received} 条事件（去重后）`)), (0, react.createElement)("div", { style: styles.barTrack }, ...counts.filter((item) => item.n > 0).map((item) => (0, react.createElement)("div", {
				key: item.kind,
				"data-source-fate": item.kind,
				title: `${FATE_LABEL[item.kind]} ${item.n} 条`,
				onClick: () => props.onToggle(item.kind),
				style: {
					width: `${item.n / total * 100}%`,
					background: FATE_COLOR[item.kind],
					height: "100%",
					cursor: "pointer",
					opacity: filter && filter !== item.kind ? .3 : 1,
					...item.kind === "direct" ? { backgroundImage: "repeating-linear-gradient(45deg, rgba(255,255,255,.35) 0 4px, transparent 4px 8px)" } : {}
				}
			}))), (0, react.createElement)("div", { style: styles.legend }, ...counts.map((item) => (0, react.createElement)("span", {
				key: item.kind,
				"data-fate-legend": item.n === 0 ? void 0 : item.kind,
				style: {
					...styles.legendItem,
					...item.n === 0 ? styles.legendOff : {},
					...filter === item.kind ? {
						color: "#334155",
						fontWeight: 600
					} : {}
				},
				onClick: item.n === 0 ? void 0 : () => props.onToggle(item.kind)
			}, (0, react.createElement)("i", { style: {
				...styles.swatch,
				background: FATE_COLOR[item.kind]
			} }), `${FATE_LABEL[item.kind]} ${item.n} 条`))));
		}
		function EventRow(props) {
			const { event } = props;
			const fate = event.fate;
			const tickets = ticketsOf(fate);
			const [hover, setHover] = (0, react.useState)(false);
			return (0, react.createElement)("div", {
				"data-event": event.triggerId,
				"data-fate": fate.kind,
				role: "button",
				tabIndex: 0,
				title: `${event.text ?? "(没有正文)"} · 点开看详情`,
				onClick: () => props.onOpen(event.triggerId),
				onMouseEnter: () => setHover(true),
				onMouseLeave: () => setHover(false),
				onFocus: () => setHover(true),
				onBlur: () => setHover(false),
				onKeyDown: (keyEvent) => {
					if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
					keyEvent.preventDefault();
					props.onOpen(event.triggerId);
				},
				style: {
					...styles.eventRow,
					borderLeftColor: FATE_COLOR[fate.kind],
					...hover ? styles.eventRowHover : {}
				}
			}, (0, react.createElement)("span", { style: styles.eventTime }, formatWhen(event.at)), (0, react.createElement)("span", { style: {
				...styles.eventFate,
				color: fateInk(fate.kind)
			} }, FATE_LABEL[fate.kind]), (0, react.createElement)("span", { style: styles.eventText }, (0, react.createElement)("span", { style: styles.eventLabel }, event.text ?? "(没有正文)"), (0, react.createElement)("button", {
				"data-event-detail": "true",
				style: styles.detailChip,
				title: "打开这条事件的详情",
				onClick: (clickEvent) => {
					clickEvent.stopPropagation();
					props.onOpen(event.triggerId);
				}
			}, "详情"), ...tickets.map((ticketId) => (0, react.createElement)("button", {
				key: ticketId,
				"data-ticket-chip": ticketId,
				style: styles.ticketChip,
				title: `打开工单 ${ticketId}`,
				onClick: (clickEvent) => {
					clickEvent.stopPropagation();
					props.onOpenTicket(ticketId);
				}
			}, `工单 ${ticketId.slice(0, 8)}`))));
		}
		//#endregion
		//#region src/presenter/swimlane.ts
		/** 报告六态 → 箭头标签；未知值原样透传。 */
		const REPORT_LABEL = {
			progress: "进行中",
			waiting: "等待触发",
			ready: "就绪",
			blocked: "受阻",
			failed: "失败",
			dropped: "无需处理"
		};
		/** 同泳道卡片挤不下时允许长高，但有硬上限：否则长工单又会长成几万像素。 */
		const MAX_CANVAS_PX = 1200;
		/**
		* 来源显示名一律取数据里的 source id。
		* 不写死中文名：换一个来源（飞书/GitHub/自定义 Source）时视图不需要改。
		* 宿主若提供 SourceKind.title，由 adapter 决定是否替换成 title——presenter 不猜。
		*/
		/**
		* 按实际参与者算列：来源可以有多个，主控与执行器各一个。
		* 两条来源 → 四列；一条来源 → 三列。位置均分，首尾留边。
		*/
		function lanesFor(chain, extraSources = []) {
			const sources = [.../* @__PURE__ */ new Set([...chain.source ? [chain.source] : [], ...extraSources])];
			const keys = [
				...sources.length > 0 ? sources : ["source"],
				"router",
				"executor"
			];
			const total = keys.length;
			return keys.map((key, index) => {
				const x = (index + 1) / (total + 1);
				if (key === "router") return {
					key,
					role: "router",
					label: "主控",
					labelEn: "Router",
					x
				};
				if (key === "executor") return {
					key,
					role: "executor",
					label: "执行器",
					labelEn: "Worker",
					x
				};
				if (key === "source") return {
					key,
					role: "source",
					label: "来源",
					labelEn: "Source",
					x
				};
				return {
					key,
					role: "source",
					label: key,
					labelEn: key,
					x
				};
			});
		}
		/**
		* 自适应缩放：短链路用基准密度（34px/s）保证可读；
		* 长链路压到目标高度内，否则一次 811 分钟的链路会变成一百六十万像素。
		* `minPxPerSecond` 是同泳道卡片防重叠所需的下界，由 `overlapFloor` 给出。
		*
		* 34px/秒只压 `fitted`（观感目标），不压下界——短链路两张卡只隔 10ms 时，
		* 不重叠需要 41.6px/秒，把它截回 34 就会出现「卡片互相压住」。画布高度另有
		* `MAX_CANVAS_PX` 硬上限兜底，所以这里放开是安全的。
		*/
		function scaleFor(durationMs, targetHeightPx, minPxPerSecond = 0) {
			if (durationMs <= 0) return 34;
			const fitted = targetHeightPx / durationMs * 1e3;
			return Math.max(Math.min(fitted, 34), minPxPerSecond);
		}
		/**
		* 同泳道防重叠下界（px/秒）。
		*
		* A、B 的顶边相距 `(dA + gapMs) * scale`，A 的高度是 `max(dA*scale, minNodeHeight)`。
		* 不重叠的条件是 `(dA+gapMs)*scale >= max(dA*scale, minNodeHeight)`；`gapPx` 只对
		* **被最小高撑开**的卡片追加——真实工单里相邻派工常只隔几十毫秒，如果「任何情况都留 8px」，
		* 335 秒的链路会被抬到 89px/秒、直接顶到 1200px，与「画布固定大小」冲突。
		*
		* 是否被撑开取决于比例，所以先看**参考比例**（present 传进来的 fit）：参考比例下已按时长
		* 画开的对，不需要任何下界；被撑开且间距不足 `minNodeHeight+gapPx` 的对，才抬到
		* `(minNodeHeight+gapPx)/(dA+gapMs)`。
		*/
		function overlapFloor(chain, minNodeHeight = 42, gapPx = 8, referencePxPerSecond = 34) {
			const reference = referencePxPerSecond / 1e3;
			const byLane = /* @__PURE__ */ new Map();
			for (const span of chain.spans) {
				if (span.kind !== "activity" || span.role === "subagent") continue;
				const key = span.role;
				const list = byLane.get(key) ?? [];
				list.push(span);
				byLane.set(key, list);
			}
			let worst = 0;
			for (const list of byLane.values()) {
				const spans = list.slice().sort((left, right) => left.startMs - right.startMs);
				for (let index = 0; index < spans.length - 1; index += 1) {
					const a = spans[index];
					const gapMs = spans[index + 1].startMs - a.endMs;
					const dA = Math.max(a.endMs - a.startMs, 0);
					if (gapMs <= 0) continue;
					if (dA * reference >= minNodeHeight) continue;
					const required = minNodeHeight + (dA * gapPx < minNodeHeight * gapMs ? gapPx : 0);
					if ((dA + gapMs) * reference >= required) continue;
					worst = Math.max(worst, required / (dA + gapMs) * 1e3);
				}
			}
			return worst;
		}
		/** 链路的绝对零点：最早一段、最早触发、最早关键时点、最早状态带的最小值。全部坐标都相对它。 */
		function originOf(chain) {
			const base = Date.parse(chain.createdAt);
			const offsets = [
				...chain.spans.map((span) => span.startMs),
				...(chain.stateBands ?? []).map((band) => band.startMs),
				...(chain.origins ?? []).map((origin) => origin.at ? Date.parse(origin.at) - base : NaN),
				...(chain.marks?.replies ?? []).map((at) => at - base),
				...chain.marks?.ackMs === void 0 ? [] : [chain.marks.ackMs - base],
				...chain.marks?.replyMs === void 0 ? [] : [chain.marks.replyMs - base]
			].filter((value) => Number.isFinite(value));
			return offsets.length === 0 ? 0 : Math.min(...offsets);
		}
		/** 耗时：从零点到最晚结束。触发与关键时点都算，避免箭头画到画布外。 */
		function durationOf(chain) {
			const base = Date.parse(chain.createdAt);
			const offsets = [
				...chain.spans.map((span) => span.endMs),
				...(chain.origins ?? []).map((origin) => origin.at ? Date.parse(origin.at) - base : NaN),
				...(chain.marks?.replies ?? []).map((at) => at - base),
				...chain.marks?.ackMs === void 0 ? [] : [chain.marks.ackMs - base],
				...chain.marks?.replyMs === void 0 ? [] : [chain.marks.replyMs - base]
			].filter((value) => Number.isFinite(value));
			if (offsets.length === 0) return 0;
			return Math.max(Math.max(...offsets) - originOf(chain), 0);
		}
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
		* 生成刻度：最多 `maxTicks` 条，步长取「好看的整数」，
		* 避免出现 7s、14s、21s 这种读不出来的刻度。
		* 阶梯一直排到一天，长工单不会被压在 2 分钟一格里画出几百条线。
		*/
		function ticksFor(durationMs, maxTicks = 8) {
			if (durationMs <= 0) return [0];
			const rough = durationMs / Math.max(maxTicks, 1);
			const step = [
				100,
				250,
				500,
				1e3,
				2e3,
				5e3,
				1e4,
				15e3,
				3e4,
				6e4,
				12e4,
				3e5,
				6e5,
				9e5,
				18e5,
				36e5,
				72e5,
				108e5,
				216e5,
				432e5,
				864e5
			].find((candidate) => candidate >= rough) ?? Math.ceil(rough / 864e5) * 864e5;
			const out = [];
			for (let at = 0; at <= durationMs; at += step) out.push(at);
			return out;
		}
		/**
		* 时间跨度（毫秒）：只依赖时间戳，与 scale 无关，所以可以先算它再定 scale。
		* 必须和 `buildArrows`/`buildNotices`/`buildStateBands` 的取时刻口径一致；
		* 漏掉状态带会让超出最后一段活动的带被裁掉。
		*/
		function extentOf(chain, events, origin) {
			const base = Date.parse(chain.createdAt);
			const at = (value) => value ? Date.parse(value) - base - origin : NaN;
			const offsets = [
				durationOf(chain) + (originOf(chain) - origin),
				...(chain.origins ?? []).map((entry) => at(entry.at)),
				...(chain.marks?.replies ?? []).map((ms) => ms - base - origin),
				chain.marks?.ackMs === void 0 ? NaN : chain.marks.ackMs - base - origin,
				chain.marks?.replyMs === void 0 ? NaN : chain.marks.replyMs - base - origin,
				...(chain.stateBands ?? []).map((band) => band.endMs - origin),
				...events.map((event) => at(event.at))
			].filter((value) => Number.isFinite(value));
			return Math.max(0, ...offsets);
		}
		/** Chain → 可绘制的模型。 */
		function present(chain, options = {}) {
			const topPadding = options.topPadding ?? 48;
			const minNodeHeight = options.minNodeHeight ?? 42;
			const targetHeightPx = options.targetHeightPx ?? 600;
			const baseOfChain = Date.parse(chain.createdAt);
			const events = options.events ?? [];
			const timelineEvents = events.filter((event) => event.path === "direct" || event.path === "context");
			const eventOffsets = timelineEvents.map((event) => event.at ? Date.parse(event.at) - baseOfChain : NaN).filter((value) => Number.isFinite(value));
			const origin = eventOffsets.length > 0 ? Math.min(originOf(chain), ...eventOffsets) : originOf(chain);
			const durationMs = extentOf(chain, timelineEvents, origin);
			const durationSec = durationMs / 1e3;
			const overlapPxPerSecond = overlapFloor(chain, minNodeHeight, 8, scaleFor(durationMs, targetHeightPx));
			const capRoom = Math.max(MAX_CANVAS_PX - topPadding - 24 - minNodeHeight, 1);
			const capPxPerSecond = durationSec > 0 ? capRoom / durationSec : 34;
			const scale = (options.pxPerSecond ?? scaleFor(durationMs, targetHeightPx, Math.min(overlapPxPerSecond, capPxPerSecond))) / 1e3;
			const canvasWidth = options.canvasWidth ?? 1e3;
			const lanes = lanesFor(chain, options.extraSources ?? []);
			const nodes = chain.spans.map((span) => {
				const top = topPadding + (span.startMs - origin) * scale;
				const rawHeight = (span.endMs - span.startMs) * scale;
				const isEvent = span.kind === "event";
				return {
					id: span.id,
					atMs: span.startMs - origin,
					role: span.role,
					laneKey: laneKeyFor(span.role, lanes),
					label: span.label,
					...span.badge ? { badge: span.badge } : {},
					...span.role === "subagent" ? { nested: true } : {},
					...isEvent ? { event: true } : {},
					...span.startsApprox ? { approxStart: true } : {},
					top,
					width: isEvent ? 108 : span.role === "subagent" ? 86 : 130,
					height: isEvent ? 14 : Math.max(rawHeight, minNodeHeight),
					solid: isEvent || rawHeight >= 12
				};
			});
			const arrows = buildArrows(chain, lanes, origin, topPadding, scale, events).filter((arrow) => Number.isFinite(arrow.top));
			const notices = buildNotices(lanes, origin, topPadding, scale, events, chain.createdAt).filter((notice) => Number.isFinite(notice.top));
			attachSteps(nodes, arrows);
			placeLabels(nodes, arrows, lanes, canvasWidth);
			const stateBands = buildStateBands(chain, lanes, origin, topPadding, scale, canvasWidth);
			const bands = buildBands(nodes, arrows, lanes, topPadding, durationMs * scale).filter((band) => !(stateBands.length > 0 && band.laneKey === executorLaneKey(lanes)));
			const ticks = ticksFor(durationMs).map((atMs) => ({
				atMs,
				top: topPadding + atMs * scale,
				label: formatDuration(atMs)
			}));
			return {
				durationMs,
				heightPx: topPadding + Math.max(durationMs * scale, ...nodes.map((node) => node.top - topPadding + node.height), ...arrows.map((arrow) => arrow.top - topPadding + 12), ...notices.map((notice) => notice.top - topPadding + 12), ...stateBands.map((band) => band.top - topPadding + band.height), 0) + 24,
				canvasWidth,
				lanes,
				nodes,
				ticks,
				arrows,
				notices,
				bands,
				stateBands
			};
		}
		/** 执行器列键：状态带只铺这一列。 */
		function executorLaneKey(lanes) {
			return lanes.find((lane) => lane.role === "executor")?.key;
		}
		/** 状态键 → 大分类：客户端按分类选底色，不解析中文。 */
		function groupOfTag(tag) {
			if (tag.startsWith("person/")) return "person";
			if (tag === "idle") return "idle";
			if (tag === "ended") return "ended";
			return "working";
		}
		function buildStateBands(chain, lanes, origin, topPadding, scale, canvasWidth) {
			const laneKey = executorLaneKey(lanes);
			const input = chain.stateBands ?? [];
			if (!laneKey || input.length === 0) return [];
			const laneIndex = lanes.findIndex((lane) => lane.key === laneKey);
			return input.map((band) => {
				const top = topPadding + (band.startMs - origin) * scale;
				const height = Math.max((band.endMs - band.startMs) * scale, 0);
				return {
					id: band.id,
					laneKey,
					tag: band.tag,
					group: groupOfTag(band.tag),
					label: band.label,
					top,
					height,
					...band.startsApprox ? { startsApprox: true } : {},
					...band.reason ? { reason: band.reason } : {},
					...height > 14 ? bandLabelPlacement(lanes[laneIndex], laneIndex, lanes, top, height, band.startsApprox, band.label, canvasWidth) : {}
				};
			});
		}
		/**
		* 状态带标签的位置：色块右缘之外、下一列节点左缘之内。
		* 执行器永远是最后一列（`lanesFor`），所以右侧留白最宽；
		* 留白放不下就不画字，避免再压到块标题上（本次要修的缺陷）。
		*/
		function bandLabelPlacement(lane, index, lanes, top, height, startsApprox, label, canvasWidth) {
			const rectRight = lane.x * canvasWidth + 66;
			const next = lanes[index + 1];
			if ((next ? next.x * canvasWidth - 65 : canvasWidth - 40) - rectRight - 6 < Math.max(48, label.length * 10)) return {};
			return {
				labelX: rectRight + 6,
				labelY: top + Math.min(startsApprox ? 26 : 13, Math.max(height - 3, 8)),
				labelAnchor: "start"
			};
		}
		/** 箭头：触发 → 派工 → 报告 → 回复，以及直通。时间取域内数据，不猜。 */
		function buildArrows(chain, lanes, origin, topPadding, scale, events) {
			const sourceKey = lanes[0].key;
			const routerKey = lanes.find((lane) => lane.role === "router")?.key ?? sourceKey;
			const executorKey = lanes.find((lane) => lane.role === "executor")?.key ?? routerKey;
			const base = Date.parse(chain.createdAt);
			const out = [];
			const baseOfChain = Date.parse(chain.createdAt);
			const markTop = (ms) => ms === void 0 ? void 0 : topPadding + (ms - baseOfChain - origin) * scale;
			const first = chain.spans.find((span) => span.role === "router");
			const origins = chain.origins ?? [];
			if (origins.length > 0) origins.forEach((entry, index) => {
				const at = entry.at ? Date.parse(entry.at) : NaN;
				const atMs = Number.isFinite(at) ? at - baseOfChain - origin : (first?.startMs ?? origin) - origin;
				out.push({
					id: index === 0 ? "arrow-trigger" : `arrow-trigger-${index}`,
					step: 0,
					atMs,
					from: sourceKey,
					to: routerKey,
					top: topPadding + atMs * scale,
					label: index === 0 ? "事件" : `事件 #${index + 1}`,
					labelEn: "Trigger",
					kind: "call"
				});
			});
			else if (first) out.push({
				id: "arrow-trigger",
				step: 0,
				atMs: first.startMs - origin,
				from: sourceKey,
				to: routerKey,
				top: topPadding + (first.startMs - origin) * scale,
				label: "事件",
				labelEn: "Trigger",
				kind: "call"
			});
			const canReply = chain.canReply !== false;
			if (first && canReply) {
				const ackAt = markTop(chain.marks?.ackMs);
				if (ackAt !== void 0) out.push({
					id: "arrow-ack",
					step: 0,
					atMs: chain.marks.ackMs - baseOfChain - origin,
					from: routerKey,
					to: sourceKey,
					top: ackAt,
					label: "确认收到",
					labelEn: "Acknowledge",
					kind: "back"
				});
			}
			for (const [index, event] of events.entries()) {
				if (event.path !== "direct" && event.path !== "context" || !event.at) continue;
				const at = Date.parse(event.at);
				if (!Number.isFinite(at)) continue;
				const isContext = event.path === "context";
				out.push({
					id: `arrow-fast-${index}`,
					step: 0,
					atMs: at - base - origin,
					from: sourceKey,
					to: executorKey,
					top: topPadding + (at - base - origin) * scale,
					label: isContext ? "仅上下文" : "订阅直通",
					labelEn: isContext ? "Context only" : "Fast path",
					kind: "fast"
				});
			}
			const assignments = chain.spans.filter((item) => item.role === "executor" && item.kind === "activity");
			for (const [index, span] of assignments.entries()) {
				out.push({
					id: `arrow-dispatch-${span.id}`,
					step: 0,
					atMs: span.startMs - origin,
					from: routerKey,
					to: executorKey,
					top: topPadding + (span.startMs - origin) * scale - 6,
					label: `派工 #${index + 1}`,
					labelEn: "Assignment",
					kind: "call"
				});
				if (span.reportState) out.push({
					id: `arrow-report-${span.id}`,
					step: 0,
					atMs: span.endMs - origin,
					from: executorKey,
					to: routerKey,
					top: topPadding + (span.endMs - origin) * scale + 6,
					label: `报告：${REPORT_LABEL[span.reportState] ?? span.reportState}`,
					labelEn: "Report",
					kind: "back"
				});
				const replyMs = canReply ? chain.marks?.replies?.[index] ?? (index === 0 ? chain.marks?.replyMs : void 0) : void 0;
				const replyAt = markTop(replyMs);
				if (replyAt !== void 0) out.push({
					id: `arrow-reply-${index}`,
					step: 0,
					atMs: replyMs - baseOfChain - origin,
					from: routerKey,
					to: sourceKey,
					top: replyAt,
					label: "回复",
					labelEn: "Reply",
					kind: "back"
				});
			}
			return out;
		}
		/**
		* 按时间给块与箭头统一编号。
		* 同一时刻用语义顺序兜底：事件 → 评估 → 派工箭头 → 执行块 → 报告 → 回复。
		* 纯按像素排会让"派工"跑到"事件"前面（派工箭头比事件线高 6px）。
		*/
		const RANK = {
			"arrow-trigger": 0,
			"arrow-ack": 1,
			"node-router": 2,
			"arrow-dispatch": 3,
			/** 派工箭头先于执行块：先"派过去"，才有"在干活"这一段。 */
			"node-executor": 4,
			"arrow-fast": 4.5,
			"arrow-report": 5,
			"arrow-reply": 6
		};
		function rankOf(node, arrow) {
			if (node) {
				if (node.event) {
					if (node.id.startsWith("event-retry")) return RANK["arrow-dispatch"] - .1;
					if (node.id.startsWith("event-attention")) return RANK["arrow-report"] + .2;
					if (node.id.startsWith("event-ended")) return RANK["arrow-reply"] + .5;
					if (node.role === "router") return RANK["node-router"] + .1;
					return RANK["node-executor"] + .1;
				}
				if (node.role === "router") return RANK["node-router"];
				if (node.role === "executor") return RANK["node-executor"];
				return RANK["node-executor"] + .2;
			}
			if (!arrow) return 9;
			if (arrow.id.startsWith("arrow-dispatch")) return RANK["arrow-dispatch"];
			if (arrow.id.startsWith("arrow-fast")) return RANK["arrow-fast"];
			if (arrow.id.startsWith("arrow-report")) return RANK["arrow-report"];
			if (arrow.id.startsWith("arrow-reply")) return RANK["arrow-reply"];
			if (arrow.id.startsWith("arrow-ack")) return RANK["arrow-ack"];
			return RANK["arrow-trigger"];
		}
		function attachSteps(nodes, arrows) {
			[...nodes.filter((node) => !node.nested).map((node) => ({
				at: node.atMs,
				rank: rankOf(node, void 0),
				assign: (step) => {
					node.step = step;
				}
			})), ...arrows.map((arrow) => ({
				at: arrow.atMs,
				rank: rankOf(void 0, arrow),
				assign: (step) => {
					arrow.step = step;
				}
			}))].sort((left, right) => left.at - right.at || left.rank - right.rank).forEach((entry, index) => entry.assign(index + 1));
		}
		/** 字号与宽度的保守估算：CJK 按 1 倍高、西文按 0.55 倍。不依赖 DOM 测量。 */
		function estimateWidth(text, fontSize) {
			let units = 0;
			for (const char of text) units += /[\u2e80-\u9fff\uff00-\uffef]/.test(char) ? 1 : .55;
			return units * fontSize;
		}
		/** 块标题行的可用宽度：左边让出圈码/缩进，右边留 6px 余量。 */
		function titleRoom(node) {
			const indent = node.nested ? 10 : node.event ? 24 : 28;
			return node.width - indent - 6;
		}
		/**
		* 箭头标签实际占的宽度：圈码 + 空格 + 中文 + 英文副标。
		* 渲染层画的是 `⑤ 订阅直通 Fast path`，只按中文估会系统性少算一截。
		*/
		function arrowLabelWidth(arrow) {
			const circle = arrow.step === void 0 ? 0 : 10 + estimateWidth(" ", 10);
			const english = arrow.labelEn ? estimateWidth(` ${arrow.labelEn}`, 7.5) : 0;
			return circle + estimateWidth(arrow.label, 10) + english;
		}
		/** 块顶上「起点未知」那行小字：块右缘起，宽 4 个 CJK 字。 */
		const APPROX_NOTE_TEXT = "起点未知";
		/**
		* 箭头标签压在活动块上时的落点。
		*
		* 真实形态：直通箭头的落点在主控列，而主控列这一段正是「评估」块——
		* 标签会直接盖住块标题。三条退路，按顺序试：
		*   1. 内联进块标题行（`② 评估 ⑤ 准入放行`），前提是这一行还放得下、且不挤掉已有徽章；
		*   2. 挪到块的右侧/左侧，仍在箭头同一条线上；
		*   3. 留在原位加白色描边——最后兜底，笔画压着块也不糊成一片。
		*/
		function placeLabels(nodes, arrows, lanes, canvasWidth) {
			const hosts = nodes.filter((node) => !node.nested && !node.event).map((node) => {
				const center = (lanes.find((item) => item.key === node.laneKey)?.x ?? 0) * canvasWidth;
				return {
					node,
					left: center - node.width / 2,
					right: center + node.width / 2
				};
			});
			const placed = [];
			for (const arrow of arrows) {
				if (!Number.isFinite(arrow.top)) continue;
				const from = lanes.find((lane) => lane.key === arrow.from);
				const to = lanes.find((lane) => lane.key === arrow.to);
				if (!from || !to) continue;
				const mid = (from.x + to.x) / 2 * canvasWidth;
				const width = arrowLabelWidth(arrow);
				const box = {
					left: mid - width / 2,
					right: mid + width / 2,
					top: arrow.top - 16,
					bottom: arrow.top - 4
				};
				const hit = hosts.map((host) => ({
					host,
					overlap: Math.min(host.node.top + host.node.height, box.bottom) - Math.max(host.node.top, box.top)
				})).filter((entry) => entry.overlap > 0 && box.right > entry.host.left && box.left < entry.host.right).sort((left, right) => right.overlap - left.overlap)[0];
				if (!hit) continue;
				const node = hit.host.node;
				const fits = (arrow.step === void 0 ? 0 : 7.5 + estimateWidth(" ", 7.5)) + estimateWidth(arrow.label, 7.5) + 4 + estimateWidth(node.label, 11) <= titleRoom(node);
				const redundant = node.badge === arrow.label;
				const free = node.badge === void 0 || redundant;
				if (fits && free && node.badgeStep === void 0) {
					node.badge = arrow.label;
					node.badgeStep = arrow.step;
					node.badgeKind = arrow.kind;
					arrow.inline = true;
					continue;
				}
				const noteRoom = node.approxStart === true && box.bottom > node.top && box.top < node.top + 12 ? estimateWidth(APPROX_NOTE_TEXT, 8.5) + 6 : 0;
				const beside = [{
					x: hit.host.right + 6 + noteRoom,
					anchor: "start"
				}, {
					x: hit.host.left - 6,
					anchor: "end"
				}].find((candidate) => {
					const left = candidate.anchor === "start" ? candidate.x : candidate.x - width;
					const right = left + width;
					const clearsHost = !hosts.some((host) => right > host.left && left < host.right && box.bottom > host.node.top && box.top < host.node.top + host.node.height);
					const clearsLabels = !placed.some((other) => right > other.left && left < other.right && box.bottom > other.top && box.top < other.bottom);
					return clearsHost && clearsLabels;
				});
				if (beside) {
					arrow.labelX = beside.x;
					arrow.labelAnchor = beside.anchor;
					const left = beside.anchor === "start" ? beside.x : beside.x - width;
					placed.push({
						left,
						right: left + width,
						top: box.top,
						bottom: box.bottom
					});
					continue;
				}
				arrow.halo = true;
			}
		}
		/** 知会：直通时主控只收到一份副本，不参与决策。 */
		function buildNotices(lanes, origin, topPadding, scale, events, createdAt) {
			const routerKey = lanes.find((lane) => lane.role === "router")?.key;
			if (!routerKey) return [];
			const base = Date.parse(createdAt);
			return events.filter((event) => event.path === "direct" && event.at).map((event, index) => ({
				id: `notice-${index}`,
				laneKey: routerKey,
				top: topPadding + (Date.parse(event.at) - base - origin) * scale,
				label: "知会"
			}));
		}
		/**
		* 空档带：某列在这段时间里**完全没有参与**，才画斜纹。
		*
		* "参与"包括两种：活动块（在干活），以及箭头端点（收到报告、发出回复）。
		* 只看块会得出错误结论——主控在 13s 收到过报告，不该被标成整段"未参与"。
		*/
		function buildBands(nodes, arrows, lanes, topPadding, total) {
			const bands = [];
			for (const lane of lanes) {
				const label = lane.role === "router" ? "主控未参与" : lane.role === "executor" ? "执行器空闲" : "";
				if (!label) continue;
				const moments = [...nodes.filter((node) => node.laneKey === lane.key).map((node) => ({
					top: node.top,
					bottom: node.top + node.height
				})), ...arrows.filter((arrow) => arrow.from === lane.key || arrow.to === lane.key).map((arrow) => ({
					top: arrow.top,
					bottom: arrow.top + 1
				}))].sort((left, right) => left.top - right.top);
				if (moments.length === 0) continue;
				const merged = [];
				for (const moment of moments) {
					const last = merged[merged.length - 1];
					if (last && moment.top <= last.bottom + 1) last.bottom = Math.max(last.bottom, moment.bottom);
					else merged.push({ ...moment });
				}
				for (let index = 0; index < merged.length - 1; index += 1) {
					const from = merged[index].bottom;
					const to = merged[index + 1].top;
					if (to - from < 40) continue;
					bands.push({
						id: `band-${lane.key}-${index}`,
						laneKey: lane.key,
						top: from,
						height: to - from,
						label
					});
				}
				const tail = topPadding + total;
				const lastEnd = merged[merged.length - 1].bottom;
				if (tail - lastEnd > 40) bands.push({
					id: `band-${lane.key}-tail`,
					laneKey: lane.key,
					top: lastEnd,
					height: tail - lastEnd,
					label
				});
			}
			const widest = /* @__PURE__ */ new Map();
			for (const band of bands) {
				const current = widest.get(band.laneKey);
				if (current === void 0 || band.height > current) widest.set(band.laneKey, band.height);
			}
			return bands.map((band) => band.height >= widest.get(band.laneKey) ? band : {
				...band,
				label: ""
			});
		}
		/** 泳道查找：按 key 找，支持多条来源。 */
		function laneOf(model, key) {
			return model.lanes.find((lane) => lane.key === key) ?? model.lanes[0];
		}
		/** 角色 → 泳道键：来源取第一条来源列，其余按角色。 */
		function laneKeyFor(role, lanes) {
			const wanted = role === "subagent" ? "executor" : role;
			return lanes.find((lane) => lane.role === wanted)?.key ?? lanes[0].key;
		}
		//#endregion
		//#region src/client/TicketView.tsx
		/**
		* 一张工单的内部视图：比例带 + 时序图 + 两抽屉。
		*
		* 它不再自带左栏：内存里没有路由，工单是覆盖在来源页之上的一层
		* （`TicketOverlay`），来源页在下面保持挂载。这里只负责这张工单本身。
		*/
		const ROLE_COLOR = {
			source: "#94a3b8",
			router: "#818cf8",
			executor: "#34d399",
			subagent: "#a3b8c9"
		};
		/** 状态带底色：低饱和实色，与「未参与」的斜纹一眼区分；要淡到不盖住活动块。 */
		const STATE_FILL = {
			person: "#fbf3e3",
			working: "#eef7f2",
			idle: "#f3f5f7",
			ended: "#eef0f4"
		};
		function TicketView(props) {
			const { ticketId } = props;
			const [chain, setChain] = (0, react.useState)();
			const [dispositions, setDispositions] = (0, react.useState)([]);
			const [detail, setDetail] = (0, react.useState)();
			const [link, setLink] = (0, react.useState)();
			const [translations, setTranslations] = (0, react.useState)({});
			const [translating, setTranslating] = (0, react.useState)(false);
			const [skipped, setSkipped] = (0, react.useState)({});
			const [error, setError] = (0, react.useState)();
			const [loading, setLoading] = (0, react.useState)(true);
			/** 已取回的全文，按「工单 + 文本 id」缓存：展开/收起不重复请求。 */
			const fullTexts = (0, react.useRef)(/* @__PURE__ */ new Map());
			(0, react.useEffect)(() => {
				let alive = true;
				setLoading(true);
				setChain(void 0);
				setDispositions([]);
				setDetail(void 0);
				setLink(void 0);
				setError(void 0);
				(async () => {
					const data = await fetchChain(ticketId);
					if (!alive) return;
					if (!data) {
						setError(`读不到工单 ${ticketId}`);
						setLoading(false);
						return;
					}
					setChain(data.chain);
					setDispositions(data.dispositions);
					setLoading(false);
				})();
				return () => {
					alive = false;
				};
			}, [ticketId]);
			(0, react.useEffect)(() => {
				if (!detail && !link) return;
				return pushEscape(() => {
					setDetail(void 0);
					setLink(void 0);
				});
			}, [detail, link]);
			(0, react.useEffect)(() => {
				if (!detail && !link) return;
				const close = () => {
					setDetail(void 0);
					setLink(void 0);
				};
				const onDown = (event) => {
					const target = event.target;
					if (!target) return;
					if (target.closest("[data-drawer]")) return;
					if (target.closest("[data-span], [data-link], [data-legend]")) return;
					close();
				};
				document.addEventListener("mousedown", onDown, true);
				return () => document.removeEventListener("mousedown", onDown, true);
			}, [detail, link]);
			const model = (0, react.useMemo)(() => chain ? present(chain, { events: dispositions }) : void 0, [chain, dispositions]);
			/** 取一段正文的全文；抽屉默认只有预览，点「展开原文」才走这里。 */
			const loadText = (0, react.useCallback)(async (textId) => {
				if (!chain) return void 0;
				const key = `${chain.ticketId}\u0000${textId}`;
				const hit = fullTexts.current.get(key);
				if (hit !== void 0) return hit;
				const text = await fetchText(chain.ticketId, textId);
				if (text !== void 0) fullTexts.current.set(key, text);
				return text;
			}, [chain]);
			const openLink = (0, react.useCallback)(async (linkId) => {
				if (!chain) return;
				const data = await fetchLink(chain.ticketId, linkId);
				if (!data) {
					setError(`读不到连线 ${linkId}`);
					return;
				}
				setDetail(void 0);
				setTranslations({});
				setSkipped({});
				setLink(data);
			}, [chain]);
			const openSpan = (0, react.useCallback)(async (spanId) => {
				if (!chain) return;
				const data = await fetchSpanDetail(chain.ticketId, spanId);
				if (!data) {
					setError(`读不到这一段 ${spanId}`);
					return;
				}
				setLink(void 0);
				setDetail(data);
				setSkipped({});
				setTranslations(data.translations ?? {});
			}, [chain]);
			const translate = (0, react.useCallback)(async (items) => {
				if (items.length === 0) return;
				setTranslating(true);
				try {
					for (let start = 0; start < items.length; start += 5) {
						const batch = items.slice(start, start + 5);
						const fulls = await Promise.all(batch.map((item) => item.length > item.text.length ? loadText(item.id) : Promise.resolve(item.text)));
						const ready = batch.map((item, index) => ({
							item,
							text: fulls[index]
						})).filter((entry) => entry.text !== void 0);
						if (ready.length === 0) continue;
						const payload = await translateTexts(ready.map((entry) => entry.text));
						if (!payload) continue;
						setTranslations((previous) => {
							const next = { ...previous };
							payload.items?.forEach((item, index) => {
								const prose = ready[index]?.item;
								if (item && prose) next[prose.id] = item;
							});
							return next;
						});
						const skippedIds = (payload.skipped ?? []).map((index) => ready[index]?.item.id).filter((id) => typeof id === "string");
						if (skippedIds.length > 0) setSkipped((previous) => ({
							...previous,
							...Object.fromEntries(skippedIds.map((id) => [id, true]))
						}));
					}
				} catch {}
				setTranslating(false);
			}, [loadText]);
			return (0, react.createElement)("div", { style: styles.ticketBody }, error ? (0, react.createElement)("div", { style: styles.error }, `读不到数据：${error}`) : null, chain ? (0, react.createElement)("h1", { style: styles.title }, chain.title) : null, chain ? (0, react.createElement)("div", {
				"data-identity": "1",
				style: styles.identity
			}, `工单 Ticket ${chain.ticketId} · ${chain.source ? `来源 ${chain.source}` : "来源（未记录）"}`) : null, chain ? (0, react.createElement)("div", { style: styles.sub }, `${chain.stage} · ${model ? formatDuration(model.durationMs) : ""}`) : null, chain && model ? (0, react.createElement)(Bar, {
				items: dispositions,
				chain,
				onLink: (id) => void openLink(id)
			}) : null, chain && model ? (0, react.createElement)(Sequence, {
				chain,
				model,
				onLink: (id) => void openLink(id),
				onPick: (id) => void openSpan(id)
			}) : (0, react.createElement)("div", { style: styles.empty }, loading ? "读取中…" : "这张工单没有可画的时序"), link ? (0, react.createElement)("aside", {
				"data-drawer": "1",
				style: styles.drawer
			}, (0, react.createElement)("div", { style: styles.drawerHead }, (0, react.createElement)("b", null, link.title), (0, react.createElement)("button", {
				style: styles.close,
				onClick: () => setLink(void 0)
			}, "×")), (0, react.createElement)("div", { style: styles.drawerBody }, ...renderLink(link, loadText))) : null, detail ? (0, react.createElement)("aside", {
				"data-drawer": "1",
				style: styles.drawer
			}, (0, react.createElement)("div", { style: styles.drawerHead }, (0, react.createElement)("b", null, detail.title), (0, react.createElement)("button", {
				style: styles.close,
				onClick: () => setDetail(void 0)
			}, "×")), (0, react.createElement)("div", { style: styles.drawerBody }, ...renderDetail(detail, translations, skipped, translating, loadText, (items) => void translate(items)))) : null);
		}
		/**
		* 一段正文：默认只显示预览（最多 200 字）。超过预览长度时给「展开原文 · N 字」，
		* 点了才去取全文；取不到就明说，预览不消失。
		*/
		function ProseBlock(props) {
			const { prose, display, say, clamp, onLoad } = props;
			const [open, setOpen] = (0, react.useState)(false);
			const [full, setFull] = (0, react.useState)();
			const [loading, setLoading] = (0, react.useState)(false);
			const [failed, setFailed] = (0, react.useState)(false);
			const expandable = prose.length > prose.text.length;
			const collapsed = display ?? prose.text;
			const body = open && full !== void 0 ? full : collapsed;
			const toggle = async () => {
				if (open) {
					setOpen(false);
					return;
				}
				if (full !== void 0) {
					setOpen(true);
					return;
				}
				setLoading(true);
				setFailed(false);
				const text = await onLoad(prose.id);
				setLoading(false);
				if (text === void 0) {
					setFailed(true);
					return;
				}
				setFull(text);
				setOpen(true);
			};
			return (0, react.createElement)("div", null, (0, react.createElement)("div", { style: {
				...say ? styles.quoteSay : styles.quoteIn,
				...clamp && !open ? styles.proseClamp : {},
				...open ? styles.proseFull : {}
			} }, body), expandable || open ? (0, react.createElement)("div", { style: styles.proseBar }, failed ? (0, react.createElement)("span", { style: styles.proseError }, "原文已不可读（会话可能已归档）") : null, (0, react.createElement)("button", {
				style: styles.proseToggle,
				disabled: loading,
				onClick: () => void toggle()
			}, loading ? "读取中…" : open ? "收起" : `展开原文 · ${prose.length} 字`)) : null);
		}
		/** 连线详情：形状与原型一致——引用气泡 / 徽章行 / 说明，不用表格。 */
		function renderLink(link, onLoad) {
			return [link.subtitle ? (0, react.createElement)("div", {
				key: "sub",
				style: styles.linkSub
			}, link.subtitle) : null, ...link.sections.map((section, index) => (0, react.createElement)("div", {
				key: index,
				style: styles.sec
			}, (0, react.createElement)("div", { style: styles.secTitle }, section.title), ...section.body ? [(0, react.createElement)(ProseBlock, {
				key: "b",
				prose: section.body,
				say: section.say,
				onLoad
			})] : section.text ? [(0, react.createElement)("div", {
				key: "t",
				style: section.say ? styles.quoteSay : styles.quote
			}, section.text)] : [], ...section.items?.length ? [(0, react.createElement)("div", {
				key: "b",
				style: styles.badges
			}, ...section.items.map((item, i) => (0, react.createElement)("span", {
				key: i,
				style: {
					...styles.badge,
					...item.tone === "ok" ? styles.pillOk : item.tone === "warn" ? styles.pillWarn : {}
				}
			}, item.text)))] : [], ...section.kind === "note" && !section.text ? [(0, react.createElement)("div", {
				key: "n",
				style: styles.pending
			}, "—")] : []))].filter(Boolean);
		}
		function renderDetail(detail, translations, skipped, translating, onLoad, onTranslate) {
			const blocks = [];
			/** 一段「它的想法」：右侧带翻译按钮，翻过的直接给中文 */
			const thoughtSection = (key, items) => {
				if (items.length === 0) return null;
				const done = items.every((item) => translations[item.id] || skipped[item.id]);
				return (0, react.createElement)("div", {
					key,
					style: styles.sec
				}, (0, react.createElement)("div", { style: styles.secHead }, (0, react.createElement)("span", { style: styles.secTitle }, "它的想法"), done ? null : (0, react.createElement)("button", {
					style: {
						...styles.secAction,
						...translating ? styles.headActionBusy : {}
					},
					disabled: translating,
					onClick: () => onTranslate(items)
				}, translating ? "翻译中…" : "翻译")), ...items.map((item) => (0, react.createElement)(ProseBlock, {
					key: item.id,
					prose: item,
					display: translations[item.id],
					clamp: true,
					onLoad
				})), ...items.filter((item) => skipped[item.id]).map((item) => (0, react.createElement)("div", {
					key: `skip-${item.id}`,
					style: styles.proseError
				}, `原文 ${item.length} 字，超过翻译上限（1200 字）`)));
			};
			/** 一组结构化事实（勾选项/徽章，不套表格）；没有行就不画空壳。 */
			const factsSection = (key, title) => {
				const rows = (detail.facts ?? []).filter((row) => (row.group ?? "gate") === key);
				if (rows.length === 0) return null;
				return (0, react.createElement)("div", {
					key: `facts-${key}`,
					style: styles.sec
				}, (0, react.createElement)("div", { style: styles.secTitle }, title), ...rows.map((row, index) => {
					const tone = row.tone ?? "muted";
					const isMeta = (row.group ?? "gate") === "meta";
					return (0, react.createElement)("div", {
						key: index,
						"data-fact": row.label,
						style: {
							...styles.checkItem,
							...!isMeta && tone === "ok" ? styles.checkOk : !isMeta && tone === "warn" ? styles.checkWarn : {}
						}
					}, (0, react.createElement)("div", { style: styles.checkHead }, (0, react.createElement)("b", { style: styles.checkName }, row.label), isMeta ? null : (0, react.createElement)("span", { style: {
						...styles.pill,
						...tone === "ok" ? styles.pillOk : tone === "warn" ? styles.pillWarn : styles.pillMuted
					} }, tone === "ok" ? "通过" : tone === "warn" ? "未通过" : "记录")), row.prose ? (0, react.createElement)("div", { style: styles.checkNote }, (0, react.createElement)(ProseBlock, {
						prose: {
							text: row.value,
							length: row.prose.length,
							id: row.prose.id
						},
						clamp: true,
						onLoad
					})) : (0, react.createElement)("div", { style: styles.checkNote }, row.value));
				}));
			};
			if (detail.lead) blocks.push((0, react.createElement)("div", {
				key: "lead",
				style: styles.lead
			}, (0, react.createElement)("span", { style: styles.leadTag }, detail.leadSource === "system" ? "系统记录" : "模型自述"), (0, react.createElement)("span", null, detail.lead)));
			const summary = factsSection("meta", "概要");
			if (summary) blocks.push(summary);
			if (detail.received.length) blocks.push((0, react.createElement)("div", {
				key: "recv",
				style: styles.sec
			}, (0, react.createElement)("div", { style: styles.secTitle }, "它收到的"), ...detail.received.map((item) => (0, react.createElement)(ProseBlock, {
				key: item.id,
				prose: item,
				onLoad
			}))));
			const topThoughts = thoughtSection("think", detail.thoughts);
			if (topThoughts) blocks.push(topThoughts);
			else if (detail.note) blocks.push((0, react.createElement)("div", {
				key: "note",
				style: styles.sec
			}, (0, react.createElement)("div", { style: styles.secTitle }, "它的想法"), (0, react.createElement)("div", { style: styles.pending }, detail.note)));
			for (const group of [
				{
					key: "gate",
					title: "判定依据 · 准入 Gate"
				},
				{
					key: "action",
					title: "它的动作"
				},
				{
					key: "assessment",
					title: "研判 Assessment"
				},
				{
					key: "decision",
					title: "决定 Decision"
				}
			]) {
				const section = factsSection(group.key, group.title);
				if (section) blocks.push(section);
			}
			const manyTurns = new Set((detail.steps ?? []).map((step) => step.turn).filter((turn) => turn !== void 0)).size > 1;
			for (const step of detail.steps ?? []) {
				const label = manyTurns && step.turn !== void 0 ? `第 ${step.turn} 轮 · 第 ${step.step} 步` : `第 ${step.step} 步`;
				blocks.push((0, react.createElement)("div", {
					key: `step-${step.turn ?? ""}-${step.step}`,
					style: styles.stepBlock
				}, (0, react.createElement)("div", { style: styles.stepHead }, label + (step.tools.length ? ` · ${step.tools.join(" / ")}` : ""), step.model ? (0, react.createElement)("span", {
					key: "model",
					style: styles.stepModel
				}, ` · 模型改为 ${step.model.provider ? `${step.model.provider} / ` : ""}${step.model.model}`) : null), ...step.received.length ? [(0, react.createElement)("div", {
					key: "step-recv",
					style: styles.sec
				}, (0, react.createElement)("div", { style: styles.secTitle }, "它收到的"), ...step.received.map((item) => (0, react.createElement)(ProseBlock, {
					key: item.id,
					prose: item,
					onLoad
				})))] : [], thoughtSection(`th-${step.step}`, step.thoughts) ?? void 0, (0, react.createElement)("div", {
					key: "act",
					style: styles.sec
				}, (0, react.createElement)("div", { style: styles.secTitle }, "它的动作"), ...step.actions.map((action, index) => renderAction(action, index, onLoad)))));
			}
			if (detail.truncated) blocks.push((0, react.createElement)("div", {
				key: "truncated",
				style: styles.truncNote
			}, `这段活动有 ${detail.truncated.total} 条记录，抽屉只展开了最早的 ${detail.truncated.shown} 条，后面的步骤没有加载（长任务的会话日志读取上限）。`));
			if (detail.outcome) blocks.push((0, react.createElement)("div", {
				key: "outcome",
				style: styles.sec
			}, (0, react.createElement)("div", { style: styles.secTitle }, "结果"), (0, react.createElement)(ProseBlock, {
				prose: detail.outcome,
				onLoad
			})));
			if (blocks.length === 0) blocks.push((0, react.createElement)("div", {
				key: "none",
				style: styles.pending
			}, "这一段没有留下可读的记录"));
			return blocks.filter(Boolean);
		}
		/** 一次工具调用：工具名 + 参数 + 结果行。成功只报体量，失败才带可展开的原文。 */
		function renderAction(action, index, onLoad) {
			const result = action.result;
			return (0, react.createElement)("div", {
				key: index,
				style: {
					...styles.action,
					...action.failed ? styles.actionFailed : {}
				}
			}, (0, react.createElement)("div", { style: styles.actionTool }, action.toolNote ?? action.tool, action.toolNote ? (0, react.createElement)("span", {
				key: "raw",
				style: styles.toolRaw
			}, action.toolRaw ?? action.tool) : null, action.failed ? (0, react.createElement)("span", {
				key: "f",
				style: {
					...styles.pill,
					...styles.pillWarn,
					marginLeft: 6
				}
			}, "失败") : null), ...action.fields.map((field, fieldIndex) => (0, react.createElement)("div", {
				key: fieldIndex,
				style: styles.field
			}, (0, react.createElement)("span", { style: styles.fieldLabel }, field.label), field.prose ? (0, react.createElement)("div", { style: styles.fieldProse }, (0, react.createElement)(ProseBlock, {
				prose: {
					text: field.value,
					length: field.prose.length,
					id: field.prose.id
				},
				clamp: true,
				onLoad
			})) : (0, react.createElement)("span", { style: field.kind === "code" ? styles.fieldCode : styles.fieldValue }, field.value))), result ? (0, react.createElement)("div", {
				key: "result",
				style: styles.field
			}, (0, react.createElement)("span", { style: styles.fieldLabel }, "结果"), result.detail ? (0, react.createElement)("div", { style: styles.fieldProse }, (0, react.createElement)(ProseBlock, {
				prose: {
					text: result.summary,
					length: result.detail.length,
					id: result.detail.id
				},
				clamp: true,
				onLoad
			})) : (0, react.createElement)("span", { style: result.status === "error" ? styles.fieldValue : styles.fieldMeta }, result.summary)) : null);
		}
		/** 本工单相关事件去向：段可点、图例可点，两处都开同一个连线详情。 */
		function Bar(props) {
			const { items, chain, onLink } = props;
			const paths = [
				{
					key: "routed",
					label: "经主控",
					color: "#818cf8",
					stripe: false
				},
				{
					key: "direct",
					label: "订阅直通",
					color: "#f59e0b",
					stripe: true
				},
				{
					key: "context",
					label: "仅上下文",
					color: "#a3b8c9",
					stripe: false
				},
				{
					key: "filtered",
					label: "源头丢弃",
					color: "#e5e7eb",
					stripe: false
				}
			];
			if (items.length === 0) return null;
			const counts = paths.map((path) => ({
				...path,
				n: items.filter((item) => item.path === path.key).length
			}));
			const total = Math.max(items.length, 1);
			return (0, react.createElement)("div", { style: styles.barCard }, (0, react.createElement)("div", { style: styles.barHead }, (0, react.createElement)("span", null, "本工单相关事件去向"), (0, react.createElement)("span", { style: styles.barTotal }, `${items.length} 条事件`)), (0, react.createElement)("div", { style: styles.barTrack }, ...counts.filter((item) => item.n > 0).map((item) => (0, react.createElement)("div", {
				key: item.key,
				"data-link": `path-${item.key}`,
				title: `${item.label} ${item.n} 条`,
				onClick: () => onLink(`path-${item.key}`),
				style: {
					width: `${item.n / total * 100}%`,
					background: item.color,
					height: "100%",
					cursor: "pointer",
					...item.stripe ? { backgroundImage: "repeating-linear-gradient(45deg, rgba(255,255,255,.35) 0 4px, transparent 4px 8px)" } : {}
				}
			}))), (0, react.createElement)("div", { style: styles.legend }, ...counts.map((item) => (0, react.createElement)("span", {
				key: item.key,
				"data-legend": item.n === 0 ? void 0 : `path-${item.key}`,
				style: {
					...styles.legendItem,
					...item.n === 0 ? styles.legendOff : {}
				},
				onClick: item.n === 0 ? void 0 : () => onLink(`path-${item.key}`)
			}, (0, react.createElement)("i", { style: {
				...styles.swatch,
				background: item.color
			} }), `${item.label} ${item.n} 条`, outcomeSummary(items.filter((entry) => entry.path === item.key))))), (0, react.createElement)("div", { style: styles.barTitle }, chain.title));
		}
		/** 括号里的结果分布：接单 1 · 拒绝 0 */
		function outcomeSummary(items) {
			if (items.length === 0) return "";
			const tally = /* @__PURE__ */ new Map();
			for (const item of items) tally.set(item.outcome, (tally.get(item.outcome) ?? 0) + 1);
			return `（${[...tally].map(([code, n]) => `${OUTCOME_LABEL[code] ?? code} ${n}`).join(" · ")}）`;
		}
		const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
		function circled(n) {
			return n >= 1 && n <= 20 ? CIRCLED[n - 1] : `(${n})`;
		}
		function Sequence(props) {
			const { model, chain, onPick, onLink } = props;
			const width = model.canvasWidth ?? 1e3;
			return (0, react.createElement)("div", null, (0, react.createElement)("div", { style: styles.canvas }, (0, react.createElement)("div", {
				style: styles.scroller,
				"data-scroller": "timeline"
			}, (0, react.createElement)("svg", {
				viewBox: `0 0 ${width} ${model.heightPx}`,
				style: styles.svg
			}, (0, react.createElement)("defs", null, (0, react.createElement)("pattern", {
				id: "hatch",
				width: 6,
				height: 6,
				patternUnits: "userSpaceOnUse",
				patternTransform: "rotate(45)"
			}, (0, react.createElement)("rect", {
				width: 6,
				height: 6,
				fill: "#f7f8fa"
			}), (0, react.createElement)("line", {
				x1: 0,
				y1: 0,
				x2: 0,
				y2: 6,
				stroke: "#e6e9ed",
				strokeWidth: 1.2
			}))), (0, react.createElement)("text", {
				x: 8,
				y: 22,
				fontSize: 11,
				fill: "#9aa1ab",
				letterSpacing: ".04em",
				"data-chart-title": "1"
			}, "工单时序图"), ...model.lanes.map((lane) => (0, react.createElement)("g", { key: lane.key }, (0, react.createElement)("line", {
				x1: lane.x * width,
				y1: 40,
				x2: lane.x * width,
				y2: model.heightPx - 24,
				stroke: "#eef0f2",
				strokeWidth: 1.5
			}), (0, react.createElement)("text", {
				x: lane.x * width,
				y: 22,
				textAnchor: "middle",
				fontSize: 13,
				fontWeight: 650,
				fill: ROLE_COLOR[lane.role],
				"data-lane": lane.key,
				"data-lane-en": lane.labelEn === lane.label ? void 0 : lane.labelEn
			}, lane.label, lane.labelEn === lane.label ? null : (0, react.createElement)("tspan", {
				dx: 4,
				fontSize: 9,
				fontWeight: 500,
				fill: "#9aa1ab"
			}, lane.labelEn)))), ...model.ticks.map((tick) => (0, react.createElement)("g", { key: tick.atMs }, (0, react.createElement)("text", {
				x: 54,
				y: tick.top + 4,
				textAnchor: "end",
				fontSize: 9.5,
				fill: "#b6bcc4"
			}, tick.label), (0, react.createElement)("line", {
				x1: 62,
				y1: tick.top,
				x2: width - 40,
				y2: tick.top,
				stroke: "#f2f4f6",
				strokeWidth: 1
			}))), ...model.stateBands.map((band) => {
				const lane = laneOf(model, band.laneKey);
				const w = 132;
				return (0, react.createElement)("g", {
					key: band.id,
					"data-link": band.id,
					style: { cursor: "pointer" },
					onClick: () => onLink(band.id)
				}, (0, react.createElement)("rect", {
					x: lane.x * width - w / 2,
					y: band.top,
					width: w,
					height: Math.max(band.height, 2),
					rx: 4,
					fill: STATE_FILL[band.group] ?? "#eef1f5",
					opacity: .9,
					...band.startsApprox ? {
						stroke: "#d5dae1",
						strokeWidth: 1,
						strokeDasharray: "4 3"
					} : {}
				}), band.labelX === void 0 ? (0, react.createElement)("title", null, band.label) : (0, react.createElement)("text", {
					x: band.labelX,
					y: band.labelY ?? band.top + 13,
					textAnchor: band.labelAnchor ?? "start",
					fontSize: 9.5,
					fill: "#9aa1ab"
				}, band.label));
			}), ...model.bands.map((band) => {
				const lane = laneOf(model, band.laneKey);
				return (0, react.createElement)("g", { key: band.id }, (0, react.createElement)("rect", {
					x: lane.x * width - 46,
					y: band.top,
					width: 92,
					height: band.height,
					fill: "url(#hatch)",
					opacity: .7
				}), band.height > 56 ? (0, react.createElement)("text", {
					x: lane.x * width + 52,
					y: band.top + 14,
					fontSize: 9.5,
					fill: "#b6bcc4"
				}, band.label) : null);
			}), ...model.notices.map((notice) => {
				const lane = laneOf(model, notice.laneKey);
				return (0, react.createElement)("g", {
					key: notice.id,
					"data-link": notice.id,
					style: { cursor: "pointer" },
					onClick: () => onLink(notice.id)
				}, (0, react.createElement)("circle", {
					cx: lane.x * width,
					cy: notice.top,
					r: 3.5,
					fill: "#f59e0b"
				}), (0, react.createElement)("text", {
					x: lane.x * width + 10,
					y: notice.top + 13,
					fontSize: 9.5,
					fill: "#b45309"
				}, `${notice.label} Notice`));
			}), ...model.arrows.map((arrow) => {
				const from = laneOf(model, arrow.from);
				const to = laneOf(model, arrow.to);
				const x1 = from.x * width;
				const x2 = to.x * width;
				const dir = x2 > x1 ? 1 : -1;
				const color = arrow.kind === "fast" ? "#f59e0b" : arrow.kind === "back" ? "#94a3b8" : "#6366f1";
				const dash = arrow.kind === "fast" ? "6 4" : arrow.kind === "back" ? "2 3" : void 0;
				const mid = (x1 + x2) / 2;
				return (0, react.createElement)("g", {
					key: arrow.id,
					"data-link": arrow.id,
					style: { cursor: "pointer" },
					onClick: () => onLink(arrow.id)
				}, (0, react.createElement)("line", {
					x1: x1 + dir * 9,
					y1: arrow.top,
					x2: x2 - dir * 12,
					y2: arrow.top,
					stroke: color,
					strokeWidth: 1.4,
					strokeDasharray: dash
				}), (0, react.createElement)("path", {
					d: `M${x2 - dir * 12},${arrow.top - 3.5} L${x2 - dir * 3},${arrow.top} L${x2 - dir * 12},${arrow.top + 3.5} Z`,
					fill: color
				}), arrow.inline ? null : (0, react.createElement)("text", {
					x: arrow.labelX ?? mid,
					y: arrow.top - 6,
					textAnchor: arrow.labelAnchor ?? "middle",
					fontSize: 10,
					fill: color,
					...arrow.halo ? {
						style: { paintOrder: "stroke" },
						stroke: "#fff",
						strokeWidth: 3
					} : {}
				}, `${circled(arrow.step)} ${arrow.label}`, arrow.labelEn ? (0, react.createElement)("tspan", {
					fontSize: 7.5,
					fill: "#b6bcc4"
				}, ` ${arrow.labelEn}`) : null));
			}), ...model.nodes.map((node) => {
				const lane = laneOf(model, node.laneKey);
				const color = ROLE_COLOR[node.role] ?? "#94a3b8";
				const isEvent = node.event === true;
				const blockWidth = node.width;
				const blockHeight = node.nested ? 20 : node.height;
				const blockTop = node.top;
				const left = lane.x * width - blockWidth / 2;
				const textOffset = node.nested ? 10 : isEvent ? 24 : 28;
				const badge = node.nested || isEvent ? void 0 : node.badge;
				const textBaseline = blockTop + (node.nested ? 14 : isEvent ? 10 : 17);
				return (0, react.createElement)("g", {
					key: node.id,
					"data-span": node.id,
					onClick: () => onPick(node.id),
					style: { cursor: "pointer" }
				}, (0, react.createElement)("rect", {
					x: left,
					y: blockTop,
					width: blockWidth,
					height: blockHeight,
					rx: isEvent ? 7 : 6,
					fill: color,
					opacity: isEvent ? .26 : node.nested ? .12 : .16,
					stroke: color,
					strokeDasharray: node.nested ? "3 3" : void 0
				}), !node.nested && node.step ? (0, react.createElement)("text", {
					x: left + 12,
					y: textBaseline,
					fontSize: isEvent ? 9 : 11,
					fill: color
				}, circled(node.step)) : null, (0, react.createElement)("text", {
					x: left + textOffset,
					y: textBaseline,
					fontSize: node.nested ? 9.5 : isEvent ? 9.5 : 11,
					fill: "#334155"
				}, node.label, badge ? (0, react.createElement)("tspan", {
					dx: 4,
					fontSize: 7.5,
					fill: node.badgeKind === "fast" ? "#f59e0b" : node.badgeKind === "call" ? "#6366f1" : node.badgeKind === "back" ? "#94a3b8" : "#64748b"
				}, `${node.badgeStep === void 0 ? "" : `${circled(node.badgeStep)} `}${badge}`) : null), badge ? (0, react.createElement)("title", null, badge) : null, node.approxStart ? (0, react.createElement)("g", { key: "approx" }, (0, react.createElement)("line", {
					x1: lane.x * width - blockWidth / 2,
					y1: blockTop,
					x2: lane.x * width + blockWidth / 2,
					y2: blockTop,
					stroke: color,
					strokeWidth: 1.4,
					strokeDasharray: "4 3"
				}), (0, react.createElement)("text", {
					x: lane.x * width + blockWidth / 2 + 6,
					y: blockTop + 9,
					fontSize: 8.5,
					fill: "#b6bcc4"
				}, "起点未知")) : null);
			})))));
		}
		//#endregion
		//#region src/client/TicketOverlay.tsx
		/**
		* 工单覆盖层：盖住右侧主区，左栏仍可见可点。
		*
		* 这不是路由切换——宿主没有路由，打开工单只是叠一层。来源页在下面继续挂载，
		* 关掉覆盖层回到原处，滚动位置和已加载的事件都不丢。
		*/
		function TicketOverlay(props) {
			const close = (0, react.useRef)(props.onClose);
			(0, react.useEffect)(() => {
				close.current = props.onClose;
			});
			(0, react.useEffect)(() => pushEscape(() => close.current()), []);
			return (0, react.createElement)("section", {
				"data-ticket-overlay": props.ticketId,
				style: styles.overlay
			}, (0, react.createElement)("div", { style: styles.overlayHead }, (0, react.createElement)("button", {
				style: styles.overlayBack,
				onClick: props.onClose
			}, "← 返回来源"), (0, react.createElement)("span", { style: styles.overlayCrumb }, `${props.sourceLabel ?? "来源"} › 工单 ${props.ticketId}`)), (0, react.createElement)("div", { style: styles.overlayBody }, (0, react.createElement)(ErrorBoundary, {
				key: props.ticketId,
				fallback: (error) => (0, react.createElement)("div", {
					"data-boundary": "ticket",
					style: styles.crashed
				}, (0, react.createElement)("div", { style: styles.crashedTitle }, "这张工单画不出来"), (0, react.createElement)("div", { style: styles.crashedHint }, `${error.message.slice(0, 200)}。点左上「← 返回来源」回到事件列表，其它工单不受影响。`))
			}, (0, react.createElement)(TicketView, { ticketId: props.ticketId }))));
		}
		//#endregion
		//#region src/client/SourcePage.tsx
		/**
		* 落地页：来源 → 事件 → 工单。
		*
		* 数据顺序就是产品顺序：先看哪个来源进了什么、每条事件去了哪，再点进工单。
		* 工单是盖在主区上的一层（不是页面切换），所以来源页始终挂载、滚动位置不丢。
		*/
		const EVENT_PAGE = 50;
		function SourcePage() {
			const [sources, setSources] = (0, react.useState)();
			const [chains, setChains] = (0, react.useState)([]);
			const [activeSource, setActiveSource] = (0, react.useState)();
			const [events, setEvents] = (0, react.useState)([]);
			const [more, setMore] = (0, react.useState)(false);
			const [cursor, setCursor] = (0, react.useState)();
			const [loadingEvents, setLoadingEvents] = (0, react.useState)(false);
			const [loadingMore, setLoadingMore] = (0, react.useState)(false);
			const [selectedEventId, setSelectedEventId] = (0, react.useState)();
			const [detail, setDetail] = (0, react.useState)();
			const [drawerError, setDrawerError] = (0, react.useState)();
			const [filter, setFilter] = (0, react.useState)();
			const [ticketId, setTicketId] = (0, react.useState)();
			const [collapsed, setCollapsed] = (0, react.useState)(false);
			const [ratio, setRatio] = (0, react.useState)(() => readStoredRatio());
			const [error, setError] = (0, react.useState)();
			const [status, setStatus] = (0, react.useState)();
			const listSeq = (0, react.useRef)(0);
			const detailSeq = (0, react.useRef)(0);
			const chainSeq = (0, react.useRef)(0);
			(0, react.useEffect)(() => {
				(async () => {
					const nextStatus = await fetchStatus();
					setStatus(nextStatus);
					if (nextStatus && nextStatus.configured === false) return;
					const nextSources = await fetchSources();
					setSources(nextSources);
					if (nextSources === void 0) setError("来源列表读取失败");
				})();
			}, []);
			(0, react.useEffect)(() => {
				if (activeSource) return;
				const first = sources?.[0]?.source;
				if (first) setActiveSource(first);
			}, [sources, activeSource]);
			(0, react.useEffect)(() => {
				if (!activeSource) return;
				const seq = ++chainSeq.current;
				setChains([]);
				(async () => {
					const nextChains = await fetchChains(50, activeSource);
					if (seq !== chainSeq.current) return;
					setChains(nextChains ?? []);
				})();
			}, [activeSource]);
			(0, react.useEffect)(() => {
				if (!activeSource) return;
				const seq = ++listSeq.current;
				setLoadingEvents(true);
				setLoadingMore(false);
				setEvents([]);
				setMore(false);
				setCursor(void 0);
				setError(void 0);
				(async () => {
					const page = await fetchSourceEvents(activeSource, EVENT_PAGE);
					if (seq !== listSeq.current) return;
					setLoadingEvents(false);
					if (!page) {
						setError("事件读取失败");
						return;
					}
					setEvents(page.items);
					setMore(page.more);
					setCursor(page.nextCursor);
				})();
			}, [activeSource]);
			(0, react.useEffect)(() => {
				if (!activeSource || !selectedEventId) return;
				const seq = ++detailSeq.current;
				setDetail(void 0);
				setDrawerError(void 0);
				(async () => {
					const data = await fetchSourceEvent(activeSource, selectedEventId);
					if (seq !== detailSeq.current) return;
					if (!data) {
						setDrawerError("没有这条事件");
						return;
					}
					setDetail(data);
				})();
			}, [activeSource, selectedEventId]);
			(0, react.useEffect)(() => {
				if (!selectedEventId) return;
				return pushEscape(() => setSelectedEventId(void 0));
			}, [selectedEventId]);
			(0, react.useEffect)(() => {
				if (!selectedEventId) return;
				const onDown = (event) => {
					const target = event.target;
					if (!target) return;
					if (target.closest("[data-drawer]")) return;
					if (target.closest("[data-event]")) return;
					if (target.closest("[data-ticket-chip]")) return;
					setSelectedEventId(void 0);
				};
				document.addEventListener("mousedown", onDown, true);
				return () => document.removeEventListener("mousedown", onDown, true);
			}, [selectedEventId]);
			const pickSource = (0, react.useCallback)((source) => {
				setActiveSource(source);
				setSelectedEventId(void 0);
				setTicketId(void 0);
				setFilter(void 0);
			}, []);
			const pickTicket = (0, react.useCallback)((id) => {
				setSelectedEventId(void 0);
				setTicketId(id);
			}, []);
			const openEvent = (0, react.useCallback)((triggerId) => {
				setSelectedEventId(triggerId);
				setTicketId(void 0);
			}, []);
			const toggleFilter = (0, react.useCallback)((kind) => {
				setFilter((previous) => previous === kind ? void 0 : kind);
			}, []);
			const loadMore = (0, react.useCallback)(async () => {
				if (!activeSource || !cursor || loadingMore) return;
				const seq = listSeq.current;
				setLoadingMore(true);
				try {
					const page = await fetchSourceEvents(activeSource, EVENT_PAGE, cursor);
					if (seq !== listSeq.current) return;
					if (!page) {
						setError("更早的事件读取失败");
						return;
					}
					setEvents((previous) => [...previous, ...page.items]);
					setMore(page.more);
					setCursor(page.nextCursor);
				} finally {
					if (seq === listSeq.current) setLoadingMore(false);
				}
			}, [
				activeSource,
				cursor,
				loadingMore
			]);
			const summary = sources?.find((item) => item.source === activeSource);
			if (status?.configured === false) return (0, react.createElement)("div", {
				"data-source-page": "unconfigured",
				style: styles.unconfiguredPane
			}, (0, react.createElement)("div", { style: styles.unconfiguredCard }, (0, react.createElement)("div", { style: styles.crashedTitle }, "没有找到 superagent 的数据库"), (0, react.createElement)("div", { style: styles.crashedHint }, status.hint ?? "插件没有拿到 stateDir，所以不会读任何数据。"), (0, react.createElement)("div", { style: styles.empty }, `stateDir 来源：${status.stateDirOrigin === "config" ? "显式配置" : status.stateDirOrigin === "orchestrator" ? "orchestrator" : "未取到"}`)));
			return (0, react.createElement)("div", {
				"data-source-page": "1",
				style: {
					...styles.app,
					...collapsed ? { gridTemplateColumns: "56px minmax(0,1fr)" } : {}
				}
			}, (0, react.createElement)(Rail, {
				sources: sources ?? [],
				activeSource,
				onPickSource: pickSource,
				tickets: chains,
				activeTicketId: ticketId,
				onPickTicket: pickTicket,
				ratio,
				onRatioChange: setRatio,
				onRatioCommit: (next) => {
					setRatio(next);
					writeStoredRatio(next);
				},
				collapsed,
				onToggle: () => setCollapsed((value) => !value)
			}), (0, react.createElement)("main", { style: styles.mainPane }, (0, react.createElement)("div", {
				"data-source-pane": "1",
				style: {
					...styles.sourcePane,
					...ticketId ? styles.hidden : {}
				}
			}, (0, react.createElement)(SourceView, {
				summary,
				events,
				more,
				loading: loadingEvents || sources === void 0,
				loadingMore,
				error,
				filter,
				onToggleFilter: toggleFilter,
				onOpenEvent: openEvent,
				onOpenTicket: pickTicket,
				onLoadMore: () => void loadMore()
			})), ticketId ? (0, react.createElement)(TicketOverlay, {
				ticketId,
				sourceLabel: summary?.label ?? summary?.source ?? activeSource,
				onClose: () => setTicketId(void 0)
			}) : null, selectedEventId ? (0, react.createElement)(ErrorBoundary, {
				key: selectedEventId,
				fallback: (error) => (0, react.createElement)("aside", {
					"data-boundary": "drawer",
					style: styles.drawer
				}, (0, react.createElement)("div", { style: styles.drawerHead }, (0, react.createElement)("b", null, "这条事件画不出来"), (0, react.createElement)("button", {
					style: styles.close,
					onClick: () => setSelectedEventId(void 0),
					title: "关闭"
				}, "×")), (0, react.createElement)("div", { style: styles.drawerBody }, (0, react.createElement)("div", { style: styles.crashed }, (0, react.createElement)("div", { style: styles.crashedTitle }, "事件详情可能缺字段"), (0, react.createElement)("div", { style: styles.crashedHint }, `${error.message.slice(0, 200)}。关掉这条，其它事件不受影响。`))))
			}, (0, react.createElement)(EventDrawer, {
				source: activeSource ?? "",
				detail,
				error: drawerError,
				onClose: () => setSelectedEventId(void 0),
				onOpenTicket: pickTicket
			})) : null));
		}
		//#endregion
		//#region src/client/mount.tsx
		/** 把页面挂到 DSH 的侧边栏与主区。这里只做注册，不含渲染逻辑。 */
		const PANEL_ID = "agent-trace";
		const LABEL = "来源与工单";
		/**
		* 侧栏图标：一个来源点分出两条去向。
		*
		* 必须画成 16×16 的 SVG——宿主给图标位固定 16px（`.panelGlyph`），标题起点靠它撑开；
		* 之前用字符 `⌁` 只有 8.4px 宽，标题会往左错位 7.6px。线宽与相邻几项同一档，
		* 颜色走 `currentColor`，选中态 / 悬停态由宿主着色。
		*/
		const Glyph = () => (0, react.createElement)("svg", {
			width: 16,
			height: 16,
			viewBox: "0 0 16 16",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 1.4,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true"
		}, (0, react.createElement)("circle", {
			key: "source",
			cx: 2.6,
			cy: 8,
			r: 1.2,
			fill: "currentColor",
			stroke: "none"
		}), (0, react.createElement)("path", {
			key: "stem",
			d: "M4.3 8h3.2"
		}), (0, react.createElement)("path", {
			key: "fork",
			d: "M7.5 8 12 3.7M7.5 8 12 12.3"
		}), (0, react.createElement)("circle", {
			key: "up",
			cx: 13.2,
			cy: 3.1,
			r: 1.2,
			fill: "currentColor",
			stroke: "none"
		}), (0, react.createElement)("circle", {
			key: "down",
			cx: 13.2,
			cy: 12.9,
			r: 1.2,
			fill: "currentColor",
			stroke: "none"
		}));
		/**
		* 面板根部套一层错误边界：上游数据形状意外时，一次渲染抛错会把整块面板卸掉。
		*
		* 兜底文案只拼 `error.message`（截 200 字，与路由 500 响应同口径），不拼栈、不拼对象；
		* 不往宿主控制台写任何东西——那等于把上游内容带出去。代价是「抛错时把数据拼进 message」
		* 会直接显示在界面上，这条约束靠 review 与 `09` §6.3「错误上报」一行守。
		*/
		const Panel = () => (0, react.createElement)(ErrorBoundary, { fallback: (error) => (0, react.createElement)("div", {
			"data-boundary": "panel",
			style: styles.crashed
		}, (0, react.createElement)("div", { style: styles.crashedTitle }, "页面渲染出错"), (0, react.createElement)("div", { style: styles.crashedHint }, `${error.message.slice(0, 200)}。切到别的面板再切回来可以重试；一直这样请把这一步的操作告诉我。`)) }, (0, react.createElement)(SourcePage));
		function apply$1(ctx) {
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID
			}, Panel));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 10,
				label: () => LABEL
			}, Glyph));
		}
		//#endregion
		//#region src/client/index.tsx
		/** 客户端入口：向 DSH 注册一个侧边栏条目 + 一个主页面。 */
		const name = "dsh-superagent-trace";
		const inject = ["slots"];
		function apply(ctx) {
			apply$1(ctx);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
