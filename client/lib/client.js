window.__ModuleLoader__.load({
	id: "@you/dsh-drawio-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		require("@deepseek-ai/cordis");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react_dom = require("react-dom");
		//#region node_modules/.pnpm/@deepseek-ai+dsh-typert-pro_327adcbff64e037fe70f38b116ded4d5/node_modules/@deepseek-ai/dsh-typert-protocol/lib/index.js
		/** The one Remote failure class shared by owners, the Gateway, and consumers. */
		/**
		* One Remote call failure: a real Error carrying its stable code and typed
		* details. Owners throw it at the failure point; the Host Gateway encodes it
		* onto the wire unchanged; the Client face rebuilds an instance for the
		* `RemoteResult` error branch, so `throw result.error` keeps throw semantics.
		* Discrimination is always by `code`, never by instanceof.
		*/
		var RemoteError = class extends Error {
			code;
			details;
			/** Structural marker: cross-realm/bundle identification never uses instanceof. */
			isDSHRemoteError = true;
			/**
			* @param code - stable failure code declared in {@link RemoteErrorDetailsMap}.
			* @param message - human diagnostic carried across the wire.
			* @param details - structured payload typed by the code.
			* @param options - standard Error options (`cause` survives in-process only).
			*/
			constructor(code, message, details, options) {
				super(message, options);
				this.code = code;
				this.details = details;
				this.name = "RemoteError";
			}
		};
		//#endregion
		//#region client/src/resource.ts
		const SCHEME = "dsh-resource://drawio-file/";
		const FILE_ROUTE = "/drawio/file";
		const SAVE_ROUTE = "/drawio/save";
		/** sessionId + 工作区相对路径 → 资源地址。 */
		function addressFor(sessionId, relPath) {
			const segments = relPath.split("/").map(encodeURIComponent).join("/");
			return `${SCHEME}${encodeURIComponent(sessionId)}/${segments}`;
		}
		/** 资源地址 → { sessionId, path };非法地址返回 undefined。 */
		function parseAddress(address) {
			if (!address.startsWith(SCHEME)) return void 0;
			const rest = address.slice(27);
			const slash = rest.indexOf("/");
			if (slash <= 0 || slash === rest.length - 1) return void 0;
			try {
				const sessionId = decodeURIComponent(rest.slice(0, slash));
				const path = rest.slice(slash + 1).split("/").map(decodeURIComponent).join("/");
				if (sessionId === "" || path === "") return void 0;
				return {
					sessionId,
					path
				};
			} catch {
				return;
			}
		}
		/** 简易 JSON fetch;非 2xx 用响应体 message 抛错。 */
		async function fetchJson(input, init) {
			const response = await fetch(input, init);
			const text = await response.text();
			let payload;
			try {
				payload = text === "" ? void 0 : JSON.parse(text);
			} catch {
				payload = void 0;
			}
			if (!response.ok) throw new Error(String(payload?.message ?? `HTTP ${response.status}`));
			return payload ?? {};
		}
		const channels = /* @__PURE__ */ new Map();
		function channelFor(address) {
			let channel = channels.get(address);
			if (channel === void 0) {
				channel = {
					queue: [],
					waiters: [],
					rev: 0
				};
				channels.set(address, channel);
			}
			return channel;
		}
		function nextValue(channel, xml) {
			channel.rev += 1;
			return {
				xml,
				rev: channel.rev
			};
		}
		/** 保存成功后推帧;无打开中的流则积在队列里,下一个 open 仍会先拉 host 首帧。 */
		function publish(address, xml) {
			const channel = channelFor(address);
			const value = nextValue(channel, xml);
			const waiters = channel.waiters.splice(0);
			if (waiters.length > 0) {
				for (const waiter of waiters) waiter.resolve(value);
				return;
			}
			channel.queue.push(value);
		}
		/**
		* 编辑器关闭/保存的统一出口:写盘(host 校验)→ 推帧(卡片缩略图自动刷新)。
		* @throws host 拒绝或网络失败。
		*/
		async function saveAndPublish(sessionId, path, xml) {
			await fetchJson(SAVE_ROUTE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sessionId,
					path,
					xml
				})
			});
			publish(addressFor(sessionId, path), xml);
		}
		/** 地址后续帧流;signal 中止即结束(最后一个持有者离开时被 registry 中止)。 */
		async function* frames(channel, signal) {
			while (!signal.aborted) {
				let value;
				const queued = channel.queue.shift();
				if (queued !== void 0) value = queued;
				else try {
					value = await new Promise((resolveWait, rejectWait) => {
						const waiter = {
							resolve: resolveWait,
							reject: rejectWait
						};
						const onAbort = () => {
							const at = channel.waiters.indexOf(waiter);
							if (at !== -1) channel.waiters.splice(at, 1);
							rejectWait(/* @__PURE__ */ new Error("aborted"));
						};
						if (signal.aborted) {
							onAbort();
							return;
						}
						channel.waiters.push(waiter);
						signal.addEventListener("abort", onAbort, { once: true });
					});
				} catch {
					return;
				}
				yield {
					ok: true,
					value
				};
			}
		}
		/** 注册 drawio-file provider(包在 ctx.effect 内,随插件卸载回收)。 */
		function registerDrawioFileResource(ctx) {
			ctx.effect(() => ctx.resources.register({
				protocol: "drawio-file",
				async *open(address, { signal }) {
					const parsed = parseAddress(address);
					if (parsed === void 0) return;
					const channel = channelFor(address);
					try {
						const file = await fetchJson(`${FILE_ROUTE}?sessionId=${encodeURIComponent(parsed.sessionId)}&path=${encodeURIComponent(parsed.path)}`);
						if (signal.aborted) return;
						yield {
							ok: true,
							value: nextValue(channel, String(file.xml ?? ""))
						};
					} catch (error) {
						if (signal.aborted) return;
						yield {
							ok: false,
							error: new RemoteError("gateway/internal", error instanceof Error ? error.message : String(error), {})
						};
					}
					for await (const frame of frames(channel, signal)) yield frame;
				}
			}), "drawio: resource drawio-file");
		}
		//#endregion
		//#region client/src/embed.ts
		const INIT_TIMEOUT_MS = 3e4;
		const EXPORT_TIMEOUT_MS = 3e4;
		/** 一个 drawio iframe 的协议会话;`destroy` 前必须配对调用。 */
		var EmbedSession = class EmbedSession {
			iframe;
			origin;
			initResolve;
			pending;
			exportChain = Promise.resolve();
			saveListeners = /* @__PURE__ */ new Set();
			exitListeners = /* @__PURE__ */ new Set();
			destroyed = false;
			constructor(iframe, origin) {
				this.iframe = iframe;
				this.origin = origin;
				window.addEventListener("message", this.onMessage);
			}
			/**
			* 挂载 iframe 并等 `{event:'init'}` 握手。
			* @param mount - iframe 的父容器(隐藏容器也可,drawio 离屏照常导出)。
			* @param url - `/drawio/index.html?embed=1&proto=json…`。
			*/
			static open(mount, url) {
				return new Promise((resolveOpen, rejectOpen) => {
					const iframe = document.createElement("iframe");
					iframe.src = url;
					iframe.style.border = "0";
					iframe.style.width = "100%";
					iframe.style.height = "100%";
					const session = new EmbedSession(iframe, window.location.origin);
					const timer = window.setTimeout(() => {
						session.destroy();
						rejectOpen(/* @__PURE__ */ new Error("drawio: 编辑器初始化超时"));
					}, INIT_TIMEOUT_MS);
					session.initResolve = () => {
						window.clearTimeout(timer);
						resolveOpen(session);
					};
					mount.appendChild(iframe);
				});
			}
			/** 载入文档(load/export 报文同通道顺序到达,无需等 load 回包)。 */
			load(xml) {
				this.post({
					action: "load",
					xml
				});
			}
			/** 导出(串行单 pending;30s 超时)。 */
			export(format) {
				const run = () => new Promise((resolveExport, rejectExport) => {
					if (this.destroyed) {
						rejectExport(/* @__PURE__ */ new Error("drawio: 会话已销毁"));
						return;
					}
					const timer = window.setTimeout(() => {
						this.pending = void 0;
						rejectExport(/* @__PURE__ */ new Error(`drawio: export(${format}) 超时`));
					}, EXPORT_TIMEOUT_MS);
					this.pending = {
						resolve: resolveExport,
						reject: rejectExport,
						timer
					};
					this.post({
						action: "export",
						format
					});
				});
				const result = this.exportChain.then(run, run);
				this.exportChain = result.catch(() => {});
				return result;
			}
			/** 编辑器内保存(Ctrl+S 等)回调;返回退订函数。 */
			onSave(listener) {
				this.saveListeners.add(listener);
				return () => {
					this.saveListeners.delete(listener);
				};
			}
			/** 编辑器要求关闭回调;返回退订函数。 */
			onExit(listener) {
				this.exitListeners.add(listener);
				return () => {
					this.exitListeners.delete(listener);
				};
			}
			/** 移除监听、拒绝挂起导出、卸载 iframe。 */
			destroy() {
				if (this.destroyed) return;
				this.destroyed = true;
				window.removeEventListener("message", this.onMessage);
				if (this.pending !== void 0) {
					window.clearTimeout(this.pending.timer);
					this.pending.reject(/* @__PURE__ */ new Error("drawio: 会话已销毁"));
					this.pending = void 0;
				}
				this.iframe.remove();
			}
			post(message) {
				this.iframe.contentWindow?.postMessage(JSON.stringify(message), this.origin);
			}
			onMessage = (event) => {
				if (this.destroyed) return;
				if (event.origin !== this.origin || event.source !== this.iframe.contentWindow) return;
				let data;
				try {
					data = JSON.parse(String(event.data));
				} catch {
					return;
				}
				if (data === null || typeof data !== "object") return;
				switch (data.event) {
					case "init": {
						const ready = this.initResolve;
						this.initResolve = void 0;
						ready?.();
						return;
					}
					case "export": {
						const pending = this.pending;
						if (pending === void 0) return;
						this.pending = void 0;
						window.clearTimeout(pending.timer);
						pending.resolve(data);
						return;
					}
					case "save":
						for (const listener of [...this.saveListeners]) listener();
						return;
					case "exit":
						for (const listener of [...this.exitListeners]) listener();
						return;
				}
			};
		};
		//#endregion
		//#region client/src/thumbnail.tsx
		/**
		* 缩略图:资源值(xml)变化时,经隐藏 embed iframe 导出 SVG 显示。
		*
		* - 每个实例一个隐藏 EmbedSession(懒挂载,组件卸载销毁);
		* - xml 串变 → 串行 load + export('svg')(postMessage 同通道顺序到达);
		* - 回包字段宽容处理:`svg`(原始文本)或 `data`(data URI)都接受。
		*/
		const VIEWER_URL = "/drawio/index.html?embed=1&proto=json";
		/** export 回包 → <img> src;不认得的形态返回 undefined。 */
		function toSvgImgSrc(result) {
			const raw = result.svg ?? result.data;
			if (typeof raw !== "string" || raw === "") return void 0;
			if (raw.startsWith("data:")) return raw;
			if (raw.startsWith("<")) return `data:image/svg+xml;utf8,${encodeURIComponent(raw)}`;
		}
		const frameStyle = {
			border: "1px solid var(--dsh-border, #e0e0e0)",
			borderRadius: "8px",
			background: "#fff",
			padding: "8px",
			overflow: "auto"
		};
		const imageStyle = {
			display: "block",
			maxWidth: "100%",
			height: "auto"
		};
		const hintStyle = {
			fontSize: "12px",
			opacity: .7,
			padding: "12px"
		};
		const retryStyle = { marginLeft: "8px" };
		function Thumbnail({ snapshot, alt, renderingText, failedText, retryText }) {
			const [svgSrc, setSvgSrc] = (0, react.useState)();
			const [failed, setFailed] = (0, react.useState)(false);
			const [attempt, setAttempt] = (0, react.useState)(0);
			const hostRef = (0, react.useRef)(null);
			const sessionRef = (0, react.useRef)();
			const chainRef = (0, react.useRef)(Promise.resolve());
			const xml = snapshot.value?.xml;
			(0, react.useEffect)(() => {
				if (xml === void 0) return;
				let cancelled = false;
				chainRef.current = chainRef.current.then(async () => {
					try {
						const host = hostRef.current;
						if (host === null) return;
						sessionRef.current ??= await EmbedSession.open(host, VIEWER_URL);
						if (cancelled) return;
						sessionRef.current.load(xml);
						const result = await sessionRef.current.export("svg");
						if (cancelled) return;
						const src = toSvgImgSrc(result);
						if (src === void 0) throw new Error("drawio: 导出回包中没有 SVG");
						setSvgSrc(src);
						setFailed(false);
					} catch {
						if (!cancelled) setFailed(true);
					}
				});
				return () => {
					cancelled = true;
				};
			}, [xml, attempt]);
			(0, react.useEffect)(() => () => {
				sessionRef.current?.destroy();
				sessionRef.current = void 0;
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: frameStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					ref: hostRef,
					style: { display: "none" },
					"aria-hidden": true
				}), svgSrc !== void 0 && !failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
					style: imageStyle,
					src: svgSrc,
					alt
				}) : failed || snapshot.status === "failed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: hintStyle,
					children: [
						failedText,
						snapshot.failure !== void 0 ? `:${snapshot.failure.message}` : "",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: retryStyle,
							onClick: () => {
								setFailed(false);
								setAttempt((n) => n + 1);
							},
							children: retryText
						})
					]
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: hintStyle,
					children: renderingText
				})]
			});
		}
		//#endregion
		//#region client/src/editor-overlay.tsx
		/**
		* 全屏 drawio 编辑器覆盖层(React portal,不需要任何新 slot)。
		*
		* 流程:iframe(init)→ load(资源最新 xml)→ 关闭时 export('xml')
		* → saveAndPublish(写盘 + 推帧)→ onClose。编辑器内 Ctrl+S
		* ({event:'save'})走同样的保存但不关闭;{event:'exit'} 视同关闭。
		*/
		const EDITOR_URL = "/drawio/index.html?embed=1&proto=json&ui=min";
		const overlayStyle = {
			position: "fixed",
			inset: 0,
			zIndex: 1e3,
			display: "flex",
			flexDirection: "column",
			background: "var(--dsh-bg, #ffffff)"
		};
		const barStyle = {
			display: "flex",
			alignItems: "center",
			gap: "12px",
			padding: "8px 12px",
			borderBottom: "1px solid var(--dsh-border, #e0e0e0)",
			fontSize: "13px"
		};
		const titleStyle$2 = {
			fontWeight: 600,
			flex: 1,
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
		};
		const stageStyle = {
			flex: 1,
			minHeight: 0
		};
		function EditorOverlay({ sessionId, path, xml, title, savingText, closeText, onClose }) {
			const hostRef = (0, react.useRef)(null);
			const sessionRef = (0, react.useRef)();
			const savingRef = (0, react.useRef)(false);
			const aliveRef = (0, react.useRef)(true);
			const [saving, setSaving] = (0, react.useState)(false);
			/** 导出最新 xml → 写盘 + 推帧(保存失败只记日志,由用户重试)。 */
			const save = async () => {
				const session = sessionRef.current;
				if (session === void 0 || savingRef.current) return;
				savingRef.current = true;
				setSaving(true);
				try {
					const result = await session.export("xml");
					if (typeof result.xml === "string" && aliveRef.current) await saveAndPublish(sessionId, path, result.xml);
				} catch (error) {
					console.error("[dsh-drawio] 保存失败:", error);
				} finally {
					savingRef.current = false;
					if (aliveRef.current) setSaving(false);
				}
			};
			/** 关闭:先保存再退场。 */
			const close = async () => {
				await save();
				onClose();
			};
			(0, react.useEffect)(() => {
				aliveRef.current = true;
				const host = hostRef.current;
				if (host === null) return;
				const previousOverflow = document.body.style.overflow;
				document.body.style.overflow = "hidden";
				const onKeydown = (event) => {
					if (event.key === "Escape") close();
				};
				window.addEventListener("keydown", onKeydown);
				EmbedSession.open(host, EDITOR_URL).then((session) => {
					if (!aliveRef.current) {
						session.destroy();
						return;
					}
					sessionRef.current = session;
					session.load(xml);
					session.onSave(() => {
						save();
					});
					session.onExit(() => {
						close();
					});
				}).catch((error) => {
					console.error("[dsh-drawio] 编辑器初始化失败:", error);
					onClose();
				});
				return () => {
					aliveRef.current = false;
					document.body.style.overflow = previousOverflow;
					window.removeEventListener("keydown", onKeydown);
					sessionRef.current?.destroy();
					sessionRef.current = void 0;
				};
			}, []);
			return (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: overlayStyle,
				role: "dialog",
				"aria-modal": "true",
				"aria-label": title,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: barStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: titleStyle$2,
							children: title
						}),
						saving ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: savingText }) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => {
								close();
							},
							children: closeText
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					ref: hostRef,
					style: stageStyle
				})]
			}), document.body);
		}
		//#endregion
		//#region client/src/card.tsx
		/**
		* DrawioCard:`drawio_render` 工具调用的对话卡片(keyed toolview)。
		*
		* 视图模型只从持久化的调用切片派生(照 SkillRow):流式中显示"生成中",
		* 已结算 ok 显示缩略图卡片,error/stopped 显示摘要行。xml/path 取自
		* argsRaw;寻址用 sessionId(PropsRuntime 会话标准槽,host 侧观察会话解析
		* 工作区根);缩略图数据走 drawio-file 资源协议(useResource,保存后自动推帧刷新)。
		*/
		/** 与 host.mjs 的 sanitizeTitle 保持一致(默认路径推导)。 */
		function sanitizeTitle(title) {
			const cleaned = title.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
			return cleaned === "" ? "diagram" : cleaned;
		}
		/** argsRaw 可能是流式截断 JSON;尽力解析,失败回退 callId。 */
		function parseArgs(argsRaw) {
			try {
				const parsed = JSON.parse(argsRaw);
				if (typeof parsed === "object" && parsed !== null) {
					const { title, path, xml } = parsed;
					return {
						...typeof title === "string" ? { title } : {},
						...typeof path === "string" ? { path } : {},
						...typeof xml === "string" ? { xml } : {}
					};
				}
			} catch {}
			return {};
		}
		function firstLine(text) {
			const newline = text.indexOf("\n");
			return newline === -1 ? text : text.slice(0, newline);
		}
		/** 已结算结果的错误摘要(与 ui-tool 的文本契约对齐)。 */
		function resultText(block) {
			if (!("kind" in block)) return null;
			const parts = [];
			for (const item of block.content) parts.push(item.type === "text" ? item.text : JSON.stringify(item));
			return parts.join("\n") || null;
		}
		function cardModel(block, callId) {
			const settled = "kind" in block;
			const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? "";
			const args = parseArgs(argsRaw);
			const title = args.title ?? firstLine(argsRaw) ?? callId;
			const path = args.path ?? `diagrams/${sanitizeTitle(title)}.drawio`;
			const state = !settled ? "running" : block.error?.code === "interrupted" ? "stopped" : block.isError ? "error" : "ok";
			return {
				title,
				path,
				xml: args.xml,
				state,
				errorSummary: state === "error" && settled ? resultText(block) ?? block.error?.reason ?? null : null
			};
		}
		const cardStyle$1 = {
			border: "1px solid var(--dsh-border, #e0e0e0)",
			borderRadius: "8px",
			padding: "10px 12px",
			margin: "6px 0",
			display: "flex",
			flexDirection: "column",
			gap: "8px"
		};
		const headerStyle$1 = {
			display: "flex",
			alignItems: "center",
			gap: "10px",
			fontSize: "13px"
		};
		const titleStyle$1 = {
			fontWeight: 600,
			flex: 1,
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
		};
		const pathStyle$1 = {
			opacity: .65,
			fontFamily: "monospace",
			fontSize: "12px",
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			gap: "8px",
			fontSize: "13px",
			opacity: .85
		};
		function DrawioCard(props) {
			const { block, callId, sessionId, useResource, t } = props;
			const model = cardModel(block, callId);
			const [editing, setEditing] = (0, react.useState)(false);
			const snapshot = useResource(model.state === "ok" && model.path !== void 0 ? addressFor(sessionId, model.path) : "");
			const currentXml = snapshot.value?.xml ?? model.xml;
			if (model.state !== "ok") {
				const text = model.state === "running" ? t("card.generating") : model.errorSummary ?? t("card.failed");
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: rowStyle,
					"data-tool": "drawio_render",
					"data-state": model.state,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("card.title") }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: pathStyle$1,
							children: model.title
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: text })
					]
				});
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: cardStyle$1,
				"data-tool": "drawio_render",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: headerStyle$1,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: titleStyle$1,
								children: model.title
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: pathStyle$1,
								children: model.path
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => setEditing(true),
								children: t("card.edit")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Thumbnail, {
						snapshot,
						alt: model.title,
						renderingText: t("card.rendering"),
						failedText: t("card.failed"),
						retryText: t("card.retry")
					}),
					editing && currentXml !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EditorOverlay, {
						sessionId,
						path: model.path ?? "",
						xml: currentXml,
						title: model.title,
						savingText: t("card.saving"),
						closeText: t("card.close"),
						onClose: () => setEditing(false)
					}) : null
				]
			});
		}
		//#endregion
		//#region client/src/turn-drawio.ts
		/** drawio_render 的 presentationMeta 形状(与 host.mjs 的 output.presentationMeta 对齐)。 */
		function isDrawioMeta(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const { filePath, title } = value;
			return typeof filePath === "string" && filePath.trim().length > 0 && typeof title === "string";
		}
		/** Turn 本地累积器;只发布 Location 数据,不产出视图节点。 */
		const drawioDefinition = {
			kind: "drawio",
			match: (event) => {
				if (event.type === "turn/start") return {
					id: String(event.data.turn),
					role: "start"
				};
				if (event.type === "tool/call") return {
					id: String(event.data.turn),
					role: "update"
				};
				if (event.type === "tool/result" && event.surfaceOp === "append") return {
					id: String(event.data.turn),
					role: "update"
				};
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "turn/start") throw new Error("drawio start requires turn/start");
				return {
					turn: match.event.data.turn,
					calls: /* @__PURE__ */ new Set(),
					rendered: []
				};
			},
			update: (context, match) => {
				if (match.event.type === "tool/call") {
					if (match.event.data.name !== "drawio_render") return context.state;
					const callId = String(match.event.data.callId);
					if (context.state.calls.has(callId)) return context.state;
					const calls = new Set(context.state.calls);
					calls.add(callId);
					return {
						...context.state,
						calls
					};
				}
				if (match.event.type !== "tool/result") return context.state;
				const message = match.event.data.message;
				const result = message.content[0];
				if (result === void 0 || result.isError === true) return context.state;
				const callId = String(message.source.callId);
				if (!context.state.calls.has(callId)) return context.state;
				if (!isDrawioMeta(match.event.data.meta)) return context.state;
				if (context.state.rendered.some((item) => item.callId === callId)) return context.state;
				return {
					...context.state,
					rendered: [...context.state.rendered, {
						seq: match.event.seq,
						callId,
						filePath: match.event.data.meta.filePath,
						title: match.event.data.meta.title
					}]
				};
			},
			buildLocationData: (context, scope, previous) => {
				if (scope !== "turn" || context.state === void 0) return null;
				if (context.state.rendered.length === 0) return null;
				if (previous?.kind === "turn" && previous.turn === context.state.turn && previous.key === "drawio" && previous.value.rendered === context.state.rendered) return previous;
				return {
					kind: "turn",
					turn: context.state.turn,
					key: "drawio",
					value: { rendered: context.state.rendered }
				};
			}
		};
		/**
		* 只有收尾 turn 真的产出了图才认领 turn-tail 链。
		* @param owner - turn-tail 的 owner 时值;seq 为收尾助手消息序,晚到的结算不算。
		* @returns 已渲染图列表,或 null(无图,组件渲染 null)。
		*/
		function selectRenderedDiagrams(owner) {
			const data = owner.turn.data.get("drawio");
			if (data === void 0) return null;
			const rendered = data.rendered.filter((item) => item.seq <= owner.seq);
			return rendered.length === 0 ? null : rendered;
		}
		//#endregion
		//#region client/src/locales.ts
		/**
		* 本地化字典(NS = 'drawio')。按钮与状态文案全部走字典,不写死中文。
		* 形状照 packages/client/ui-skill/src/client/locales.ts。
		*/
		const NS = "drawio";
		const zh = {
			"card.title": "图表",
			"card.generating": "正在生成图表…",
			"card.edit": "编辑",
			"card.close": "关闭",
			"card.saving": "保存中…",
			"card.failed": "渲染失败",
			"card.retry": "重试",
			"card.rendering": "正在渲染缩略图…",
			"card.noWorkspace": "当前会话没有工作区,无法预览"
		};
		const en = {
			"card.title": "Diagram",
			"card.generating": "Generating diagram…",
			"card.edit": "Edit",
			"card.close": "Close",
			"card.saving": "Saving…",
			"card.failed": "Render failed",
			"card.retry": "Retry",
			"card.rendering": "Rendering thumbnail…",
			"card.noWorkspace": "No workspace in this session; preview unavailable"
		};
		//#endregion
		//#region client/src/tail.tsx
		/**
		* DrawioTail:turn 尾部的 drawio 卡片列表(conversation.chat.turnTail 槽位)。
		*
		* 与折叠区里的 toolview 卡片的差别:这里位于正式回复主流(turn-tail 在
		* TURN_PROCESS_INDEPENDENT_KINDS 白名单中),数据来自 turn-drawio.ts 从
		* tool/call + tool/result.meta 推导的 turn 数据(不依赖任何自定义会话事件)。
		* xml 事实源是 drawio-file 资源(首帧读盘,保存后推帧刷新),因此卡片始终
		* 展示文件当前内容。寻址用 props.sessionId,host 侧观察会话解析工作区根
		* (live 优先,历史会话冷读恢复),无需客户端再取 cwd。
		*/
		const cardStyle = {
			border: "1px solid var(--dsh-border, #e0e0e0)",
			borderRadius: "8px",
			padding: "10px 12px",
			margin: "6px 0",
			display: "flex",
			flexDirection: "column",
			gap: "8px"
		};
		const headerStyle = {
			display: "flex",
			alignItems: "center",
			gap: "10px",
			fontSize: "13px"
		};
		const titleStyle = {
			fontWeight: 600,
			flex: 1,
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
		};
		const pathStyle = {
			opacity: .65,
			fontFamily: "monospace",
			fontSize: "12px",
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
		};
		/** 单张图卡片(hooks 必须每卡一份,故列表项是独立组件)。 */
		function TailDiagramCard({ item, sessionId, useResource, t }) {
			const snapshot = useResource(addressFor(sessionId, item.filePath));
			const [editing, setEditing] = (0, react.useState)(false);
			const currentXml = snapshot.value?.xml;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: cardStyle,
				"data-tool": "drawio_render",
				"data-turn-tail-card": item.callId,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: headerStyle,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: titleStyle,
								children: item.title
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: pathStyle,
								children: item.filePath
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => setEditing(true),
								children: t("card.edit")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Thumbnail, {
						snapshot,
						alt: item.title,
						renderingText: t("card.rendering"),
						failedText: t("card.failed"),
						retryText: t("card.retry")
					}),
					editing && currentXml !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EditorOverlay, {
						sessionId,
						path: item.filePath,
						xml: currentXml,
						title: item.title,
						savingText: t("card.saving"),
						closeText: t("card.close"),
						onClose: () => setEditing(false)
					}) : null
				]
			});
		}
		/**
		* turn-tail 入口:本 turn 没有成功渲染的图时整体不出现(返回 null,
		* 不占用槽位布局)。
		*/
		function DrawioTail(props) {
			const rendered = selectRenderedDiagrams(props);
			if (rendered === null) return null;
			const { sessionId, useResource, t } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: rendered.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TailDiagramCard, {
				item,
				sessionId,
				useResource,
				t
			}, item.callId)) });
		}
		//#endregion
		//#region client/src/index.ts
		/** 需要的 ctx 服务(dsh.client.inject 里的包提供;与包级声明不同维度,勿混)。 */
		const inject = [
			"slots",
			"locale",
			"resources",
			"uiConversation"
		];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "drawio: dictionaries");
			ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: "drawio_render",
				locale: NS
			}, DrawioCard));
			ctx.uiConversation.events.register(drawioDefinition);
			ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
				name: "conversation.chat.turnTail",
				id: "@you/dsh-drawio-plugin",
				locale: NS
			}, DrawioTail));
			registerDrawioFileResource(ctx);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map