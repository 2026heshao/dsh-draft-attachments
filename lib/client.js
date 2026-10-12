/**
 * dsh-draft-attachments — 浏览器半。
 *
 * 让输入框的草稿附件（图片/文件）像文字草稿一样**跨挂载存活**：
 *
 *  官方行为（为什么图片会丢）
 *  ─────────────────────────
 *  · 文字草稿：Conversation store（`dsh.conversation.<sessionId>`）persist 到
 *    localStorage，composer 重新挂载时 seed 回来 → 文字不丢。
 *  · 草稿附件：`ConversationController.draftAttachments`（Map）与各会话
 *    `SessionInputShell.attachmentIds`（数组）都是内存态；视图卸载时
 *    `shell.dispose()` 返回全部草稿 id，InputHub 逐个 `releaseDraftAttachment`
 *    （revoke objectURL + 从 Map 删除）→ 图片消失。
 *
 *  本插件的做法（全部走官方通道，不 patch 任何官方函数）
 *  ──────────────────────────────────────────────────
 *  · 捕获：注册一个 `conversation.input.dock`（list, session scope）条目。
 *    该 dock 在 composer 栈内、对 hero（空白会话）与 composer（进行中会话）
 *    两种变体都渲染，随会话输入区挂载/卸载；组件经标准 kit 的 `useSession`/
 *    `useInput` 拿到当前会话输入态，`attachmentIds` 每次变化就把草稿附件的
 *    File 字节 + 元数据写入 IndexedDB（key = sessionId，300ms 去抖；卸载或
 *    切换会话时立即冲刷）。
 *  · 恢复：条目挂载时读回 IndexedDB；若当前输入态没有附件而磁盘有记录
 *    （典型场景：视图重挂载、附件已被 release），用 `conversation.createDrafts`
 *    （官方 intake 通道，与「添加附件」同一条路径）重建草稿，再
 *    `inputActions.addAttachments` 回填输入态 → 缩略图 rail 原样重现。
 *  · 清空同步：发送成功（commit-draft 摘除附件）或手动删除后 `attachmentIds`
 *    变化 → 捕获写入同样的集合（空集合 = 清除记录），不会复活已发送的图片。
 *
 *  失败策略：所有 IndexedDB 与服务调用都包 try/catch，失败只 console.warn，
 *  最坏退化为官方原行为（附件照旧丢失），绝不影响正常输入。
 */
window.__ModuleLoader__.load({
	id: "dsh-draft-attachments",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");

		const PLUGIN_ID = "dsh-draft-attachments";
		/** dock 是 list 型 slot（session scope，hero/composer 变体都渲染）：
		 *  条目 id 去重，order 排在官方 todo(0)/queue(20) 之后。 */
		const DOCK_SLOT = "conversation.input.dock";
		const DOCK_ID = "draft-attachments-persistence";
		const DOCK_ORDER = 900;

		// ── IndexedDB 最小封装 ────────────────────────────────────────────
		const DB_NAME = "dsh-draft-attachments";
		const STORE = "drafts";
		/** 体积护栏：单个附件与单会话合计上限（与官方图片上限同量级）。 */
		const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
		const MAX_SESSION_TOTAL_BYTES = 120 * 1024 * 1024;

		let dbPromise = null;
		/** 打开（或创建）持久化库；失败返回 null（调用方退化为 no-op）。 */
		function openDb() {
			if (typeof indexedDB === "undefined") return Promise.resolve(null);
			if (dbPromise !== null) return dbPromise;
			dbPromise = new Promise((resolve) => {
				try {
					const request = indexedDB.open(DB_NAME, 1);
					request.onupgradeneeded = () => {
						const db = request.result;
						if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
					};
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => resolve(null);
					request.onblocked = () => resolve(null);
				} catch {
					resolve(null);
				}
			});
			return dbPromise;
		}
		/** 读一个会话的草稿附件记录；无记录或失败返回 null。 */
		async function loadDraft(sessionId) {
			const db = await openDb();
			if (db === null) return null;
			return await new Promise((resolve) => {
				try {
					const tx = db.transaction(STORE, "readonly");
					const request = tx.objectStore(STORE).get(sessionId);
					request.onsuccess = () => resolve(request.result ?? null);
					request.onerror = () => resolve(null);
				} catch {
					resolve(null);
				}
			});
		}
		/** 写一个会话的草稿附件记录（空数组 = 清除该会话记录）。 */
		async function saveDraft(sessionId, records) {
			const db = await openDb();
			if (db === null) return;
			await new Promise((resolve) => {
				try {
					const tx = db.transaction(STORE, "readwrite");
					const store = tx.objectStore(STORE);
					if (records.length === 0) store.delete(sessionId);
					else store.put(records, sessionId);
					tx.oncomplete = () => resolve();
					tx.onerror = () => resolve();
					tx.onabort = () => resolve();
				} catch {
					resolve();
				}
			});
		}

		// ── 序列化/还原 ──────────────────────────────────────────────────
		/** 把一个草稿附件序列化成可存记录（超限/异常返回 undefined）。 */
		async function captureOne(attachment) {
			const file = attachment?.file;
			if (!(file instanceof Blob)) return undefined;
			if (file.size > MAX_ATTACHMENT_BYTES) return undefined;
			return {
				name: file.name || "image",
				type: file.type || "application/octet-stream",
				size: file.size,
				bytes: new Uint8Array(await file.arrayBuffer())
			};
		}
		/** 把一条记录还原成 File（官方 createDrafts 只吃 File/Blob）。 */
		function recordToFiles(record) {
			try {
				if (typeof record?.name !== "string" || !(record.bytes instanceof Uint8Array)) return [];
				const buffer = record.bytes.buffer.slice(
					record.bytes.byteOffset,
					record.bytes.byteOffset + record.bytes.byteLength
				);
				return [new File([buffer], record.name, { type: record.type })];
			} catch {
				return [];
			}
		}

		// ── dock 条目组件 ────────────────────────────────────────────────
		/**
		 * 不可见的持久化哨兵：跟随会话输入区挂载，捕获并恢复草稿附件。
		 *
		 * 标准 kit 提供（ui-renderer standardKit + ui-conversation uiSession.provide）：
		 * `useSession`（会话快照，含 sessionId）、`useInput`（输入态快照，含
		 * `attachmentIds`）、`inputActions`（含 `addAttachments`）。
		 * `conversationFace` 是本插件 inject 注入的惰性解析器（root 单例
		 * conversation 服务：createDrafts / resolveDraftAttachments /
		 * releaseDraftAttachment 只触碰根注册表，无 scope 依赖）。
		 */
		function DraftAttachmentsSentinel(props) {
			const { useEffect, useRef } = React;
			const session = props.useSession((s) => s);
			const input = props.useInput((s) => s);
			const sessionId = session?.sessionId;
			const attachmentIds = input?.attachmentIds;
			const conversationFace = props.conversationFace;

			/** 每挂载一份的持久状态（条目随会话代际重挂载而天然重置）。 */
			const stRef = useRef(null);
			if (stRef.current === null) {
				stRef.current = { timer: null, pendingIds: null, restored: false, lastSignature: "", cache: new Map() };
			}
			const st = stRef.current;
			/** 最新输入态快照（供恢复时判断，避免闭包旧值）。 */
			const liveInputRef = useRef(input);
			liveInputRef.current = input;

			/**
			 * 捕获：把当前有序附件写盘。immediate=true 跳过去抖与签名检查
			 * （卸载/切换会话时的冲刷路径）。
			 */
			const captureRef = useRef(null);
			captureRef.current = async (ids, immediate) => {
				if (sessionId === undefined || sessionId === null) return;
				const ordered = Array.isArray(ids) ? ids : [];
				const signature = ordered.join("\n");
				if (!immediate && signature === st.lastSignature) return;
				st.lastSignature = signature;
				// 淘汰已消失 id 的字节缓存。
				for (const id of [...st.cache.keys()]) {
					if (!ordered.includes(id)) st.cache.delete(id);
				}
				if (st.timer !== null) {
					clearTimeout(st.timer);
					st.timer = null;
				}
				const run = async () => {
					st.timer = null;
					try {
						if (ordered.length === 0) {
							await saveDraft(sessionId, []);
							return;
						}
						const conversation = conversationFace?.();
						const resolveFace = conversation?.resolveDraftAttachments?.bind(conversation);
						if (typeof resolveFace !== "function") return;
						const attachments = resolveFace(ordered);
						// 数量不一致 → 有 id 已失效（正在释放），跳过本轮（等下一轮变化）。
						if (attachments.length !== ordered.length) return;
						for (let index = 0; index < ordered.length; index++) {
							if (st.cache.has(ordered[index])) continue;
							const record = await captureOne(attachments[index]);
							if (record !== undefined) st.cache.set(ordered[index], record);
						}
						const records = ordered
							.map((id) => st.cache.get(id))
							.filter((record) => record !== undefined);
						if (records.length === ordered.length) await saveDraft(sessionId, records);
					} catch (error) {
						console.warn(`[${PLUGIN_ID}] 捕获失败:`, error);
					}
				};
				if (immediate) {
					run();
					return;
				}
				st.pendingIds = ordered;
				st.timer = setTimeout(run, 300);
			};

			// 恢复：挂载后读盘回填（仅当输入态当前没有附件；每会话代际一次）。
			useEffect(() => {
				if (sessionId === undefined || sessionId === null) return undefined;
				let cancelled = false;
				(async () => {
					try {
						if (st.restored) return;
						st.restored = true;
						const records = await loadDraft(sessionId);
						if (cancelled) return;
						if (records === null || records.length === 0) return;
						// 最新快照里已经有附件（时序竞争）→ 不重复注入。
						if ((liveInputRef.current?.attachmentIds?.length ?? 0) > 0) return;
						const conversation = conversationFace?.();
						const actions = props.inputActions;
						if (conversation === undefined || actions === undefined) {
							console.warn(`[${PLUGIN_ID}] 恢复跳过：conversation/inputActions 不可用`);
							return;
						}
						const files = [];
						for (const record of records) files.push(...recordToFiles(record));
						if (files.length === 0) return;
						// 官方 intake 通道：图片建 objectURL 预览，文件走后台上传。
						const drafts = conversation.createDrafts(sessionId, files);
						const ids = drafts.map((draft) => draft.id);
						if (ids.length === 0) return;
						if (!actions.addAttachments(ids)) {
							// 回填被拒（admission 锁定）→ 释放刚建的草稿，避免泄漏。
							for (const draft of drafts) {
								try { conversation.releaseDraftAttachment(draft.id); } catch { /* 忽略 */ }
							}
						}
					} catch (error) {
						console.warn(`[${PLUGIN_ID}] 恢复失败:`, error);
					}
				})();
				return () => {
					cancelled = true;
				};
				// eslint-disable-next-line react-hooks/exhaustive-deps -- 每会话代际执行一次
			}, [sessionId]);

			// 捕获：attachmentIds 变化（增/删/发送清空）→ 去抖落盘；
			// 卸载或会话切换 → 立即冲刷未落盘的变化。
			useEffect(() => {
				if (sessionId === undefined || sessionId === null) return undefined;
				captureRef.current?.(attachmentIds ?? [], false);
				return () => {
					if (st.timer !== null) {
						clearTimeout(st.timer);
						st.timer = null;
						const pending = st.pendingIds;
						if (Array.isArray(pending)) captureRef.current?.(pending, true);
					}
				};
			}, [sessionId, attachmentIds]);

			return null;
		}

		/**
		 * 插件客户端入口。
		 * @param ctx - 浏览器半的 Cordis 上下文。
		 */
		async function apply(ctx) {
			/** 惰性解析 root 单例的 conversation 服务（scope-addressed face）。 */
			const conversationFace = () => {
				try {
					const service = typeof ctx.get === "function" ? ctx.get("conversation") : undefined;
					if (service !== undefined && typeof service.createDrafts === "function") return service;
				} catch { /* 服务未就绪 */ }
				return undefined;
			};
			ctx.slots.inject(DOCK_SLOT, () =>
				ctx.slots.register({
					name: DOCK_SLOT,
					id: DOCK_ID,
					order: DOCK_ORDER,
					inject: () => ({ conversationFace })
				}, DraftAttachmentsSentinel)
			);
		}

		const inject = ["slots"];

		exports.apply = apply;
		exports.inject = inject;

		return module.exports;
	}
});
