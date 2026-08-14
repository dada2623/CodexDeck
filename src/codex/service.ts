import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, fstatSync, openSync, readFileSync, readSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import streamDeck from "@elgato/streamdeck";
import { CodexClient, type ApprovalRequest, type CodexThread } from "./client";

/** Minimal surface shared by KeyAction and DialAction. */
export interface KeyRenderable {
	setImage(image?: string): Promise<void>;
	setTitle(title?: string): Promise<void>;
}

export type AgentStatus = "offline" | "idle" | "unread" | "running" | "waiting" | "error";

export const STATUS_TEXT: Record<AgentStatus, string> = {
	offline: "未连接",
	idle: "空闲",
	unread: "未读",
	running: "思考中…",
	waiting: "等待确认",
	error: "错误"
};

/**
 * Fixed statuses used by the display-only test profile (slot -> status).
 * The test profile forces these states for showcase purposes while still
 * showing the real thread titles read from `thread/list`.
 */
const DEMO_STATUSES: AgentStatus[] = ["running", "unread", "waiting", "error", "idle"];

const STATUS_TEXT_EN: Record<AgentStatus, string> = {
	offline: "Offline",
	idle: "Idle",
	unread: "Unread",
	running: "Thinking",
	waiting: "Waiting",
	error: "Error"
};

/**
 * Session key language mode:
 * - "zh": 纯中文（「最新对话 1」+ 中文状态）
 * - "en": 纯英文（"Session 1" + English statuses）
 * - "zh-en": 中英双语（「最新对话 1」+ 小字 "Session 1"，状态如「空闲 · Idle」）
 *
 * The value is replaced at build time: `CODEXDECK_LANG=zh|en` bakes the chosen
 * language into the bundle (rollup replaces the sentinel below).
 */
const SESSION_LANG: "zh" | "en" | "zh-en" = "__CODEXDECK_LANG__" as "zh";

/** Key background colors per agent status: base color and the flash variant. */
const STATUS_COLOR: Record<AgentStatus, { base: string; flash: string }> = {
	offline: { base: "#c9c9c9", flash: "#c9c9c9" },
	idle: { base: "#e4e4e4", flash: "#e4e4e4" },
	unread: { base: "#a4e898", flash: "#7fbf74" },
	running: { base: "#94c8f8", flash: "#4a7da8" },
	waiting: { base: "#f6d2bc", flash: "#d99b74" },
	error: { base: "#e86860", flash: "#b04038" }
};

/**
 * Reasoning effort values persisted by the desktop app per thread
 * (state_5.sqlite -> threads.reasoning_effort), mapped to the labels shown in
 * the composer's reasoning picker.
 */
export const REASONING_LABEL: Record<string, string> = {
	none: "无",
	minimal: "极低",
	low: "轻度",
	medium: "中",
	high: "高",
	xhigh: "极高",
	max: "最高",
	ultra: "极致"
};

/** English labels for the reasoning effort picker (EN build). */
export const REASONING_LABEL_EN: Record<string, string> = {
	none: "None",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Very High",
	max: "Max",
	ultra: "Ultra"
};

const SLOT_COUNT = 5;
const POLL_INTERVAL_MS = 5000;
const REASONING_POLL_INTERVAL_MS = 2000;
const BREATH_INTERVAL_MS = 120; // ~8 fps key image updates
const BREATH_PERIOD_MS = 2400; // one full breathe (dim -> bright -> dim)
/**
 * Desktop app's persisted unread-thread state. The Electron app keeps the set
 * of thread IDs with unread activity under
 * `electron-persisted-atom-state.unread-thread-ids-by-host-v1` (keyed by host,
 * e.g. "local") — the same data the official UI's unread badge is built from.
 */
const GLOBAL_STATE_PATH = join(homedir(), ".codex", ".codex-global-state.json");
/**
 * Small persistence file for error acknowledgements (thread id -> updatedAt).
 * Lives inside the plugin's logs dir, which deployments leave untouched, so an
 * error the user already opened stays cleared across plugin restarts.
 */
const ACK_ERRORS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "logs", "acknowledged-errors.json");
/** Compiled from tools/ptt-helper.c: posts Option-down -> Space -> Option-up at
 * the HID event tap, mimicking the user's physical hold-Option-tap-Space. */
const PTT_HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), "ptt-helper");

function truncatePreview(preview: string, max = 12): string {
	const cleaned = preview.replace(/\s+/g, " ").trim();
	return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/** Reads only the tail of a (potentially large) session JSONL file. */
function readTail(path: string, bytes = 1048576): string {
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - bytes);
		const buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, buf.length, start);
		return buf.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/**
 * Tool names that block the agent until the user confirms or answers
 * (mirrors AgentMicro's CodexToolCallClassifier, plus request_permissions which
 * is how the desktop app asks to grant sandbox/permission changes).
 */
function toolRequiresInput(name: string): boolean {
	const value = name.trim().toLowerCase().replace(/-/g, "_");
	return (
		value.includes("request_permissions") ||
		value.includes("request_user_input") ||
		value.includes("requestuserinput") ||
		value.includes("ask_user") ||
		value.includes("askuserquestion") ||
		value.includes("elicitation_request")
	);
}

/**
 * Whether an open tool call is blocked on the user. Besides input-requiring
 * tool names, exec commands whose arguments explicitly request escalated
 * sandbox permissions (`"sandbox_permissions": "require_escalated"`) go
 * through an approval round-trip before they run — while unclosed, the thread
 * is waiting for that approval.
 */
function callRequiresApproval(name: string, argumentsText: string): boolean {
	if (toolRequiresInput(name)) {
		return true;
	}
	return (
		/"sandbox_permissions"\s*:\s*"require_escalated"/.test(argumentsText) ||
		/"sandbox_approval"/.test(argumentsText)
	);
}

/**
 * Detects agent messages that hand control back to the user ("请确认…",
 * "Do you want me to…"), mirroring AgentMicro's
 * CodexUserActionRequestClassifier. Returns true when the newest agent message
 * is a request for user action rather than a final answer.
 */
function messageRequestsAction(text: string): boolean {
	const sentences = (text.match(/[^.!?。！？;\n]+[.!?。！？;\n]?/g) ?? [])
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	const negative = ["不要", "不用", "无需", "不需要", "请勿", "do not", "don't", "no need to", "please avoid"];
	const zhRequest = ["请", "麻烦", "需要你", "需要您", "等你", "等待你", "等待您", "轮到你", "轮到您", "完成后", "操作后", "然后告诉我", "再告诉我", "回复我"];
	const zhAction = ["输入", "填写", "登录", "登陆", "确认", "批准", "授权", "验证", "完成", "点击", "选择", "操作", "接管", "提交", "回复", "告诉"];
	const enRequest = ["please", "need you to", "waiting for you to", "wait for you to", "your action is required", "requires your action", "when you are done", "when you're done", "once you have completed", "then let me know", "reply when"];
	const enAction = ["enter", "fill", "log in", "login", "sign in", "confirm", "approve", "authorize", "verify", "complete", "click", "select", "take over", "submit", "reply", "let me know"];
	const zhQuestion = ["你", "您", "吗", "能否", "可否", "要不要", "需不需要", "哪一个", "哪个", "哪种", "是否允许", "是否同意"];
	const enQuestion = ["you", "your", "would you", "could you", "can you", "do you", "which option"];

	return sentences.some((sentence) => {
		if (negative.some((m) => sentence.includes(m))) {
			return false;
		}
		if (sentence.includes("?") || sentence.includes("？")) {
			if (zhQuestion.some((m) => sentence.includes(m)) || enQuestion.some((m) => sentence.includes(m))) {
				return true;
			}
		}
		const zhReq = zhRequest.some((m) => sentence.includes(m));
		const zhAct = zhAction.some((m) => sentence.includes(m));
		if (zhReq && zhAct) {
			return true;
		}
		const enReq = enRequest.some((m) => sentence.includes(m));
		const enAct = enAction.some((m) => sentence.includes(m));
		return enReq && enAct;
	});
}

/**
 * Infers the thread's live state by scanning the session file tail:
 * - "idle": newest boundary is task_complete / turn_aborted;
 * - "waiting": the turn is active and either an input-requiring tool call is
 *   still open (request_permissions / request_user_input / …) or the newest
 *   agent message asks the user to act — the desktop app's persisted state
 *   does not expose this, so the transcript is the source of truth
 *   (same approach as AgentMicro);
 * - "running": the turn is active with no pending user interaction.
 */
function sessionState(path: string | null): "waiting" | "running" | "idle" | "error" {
	if (!path) {
		return "idle";
	}
	try {
		const lines = readTail(path).split("\n");
		const closedCalls = new Set<string>();
		const openCalls: { name: string; args: string }[] = [];
		let newestAgentMessage: string | null = null;
		let sawTurnStart = false;
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (!line) {
				continue;
			}
			try {
				const obj = JSON.parse(line);
				const payload = obj?.payload;
				const type = payload?.type;
				if (
					obj?.type === "error" ||
					obj?.type === "fatal_error" ||
					obj?.type === "stream_error" ||
					obj?.type === "task_failed" ||
					obj?.type === "turn_failed" ||
					type === "error" ||
					type === "fatal_error" ||
					type === "stream_error" ||
					type === "task_failed" ||
					type === "turn_failed"
				) {
					return "error";
				}
				if (type === "task_complete" || type === "turn_aborted") {
					if (!sawTurnStart) {
						return "idle";
					}
					continue;
				}
				if (type === "task_started" || type === "user_message") {
					sawTurnStart = true;
					break;
				}
				if (type === "function_call" || type === "custom_tool_call") {
					const callId = String(payload?.call_id ?? payload?.id ?? "");
					if (callId && !closedCalls.has(callId)) {
						openCalls.push({
							name: String(payload?.name ?? ""),
							args: typeof payload?.arguments === "string"
								? payload.arguments
								: typeof payload?.input === "string"
									? payload.input
									: ""
						});
					}
					continue;
				}
				if (type === "function_call_output" || type === "custom_tool_call_output") {
					const callId = String(payload?.call_id ?? payload?.id ?? "");
					if (callId) {
						closedCalls.add(callId);
					}
					continue;
				}
				if (type === "agent_message") {
					const message = String(payload?.message ?? "");
					if (message) {
						newestAgentMessage ??= message;
					}
					continue;
				}
				if (type === "message" && payload?.role === "assistant") {
					const content = Array.isArray(payload?.content)
						? payload.content
								.map((c: { type?: string; text?: string }) =>
									c?.type === "text" || c?.type === "output_text" ? c.text ?? "" : ""
								)
								.join(" ")
						: String(payload?.content ?? "");
					if (content) {
						newestAgentMessage ??= content;
					}
				}
			} catch {
				// Partial JSON at the tail boundary; keep scanning.
			}
		}
		if (!sawTurnStart) {
			return "idle";
		}
		if (openCalls.some((call) => callRequiresApproval(call.name, call.args))) {
			return "waiting";
		}
		if (newestAgentMessage && messageRequestsAction(newestAgentMessage)) {
			return "waiting";
		}
		return "running";
	} catch {
		return "idle";
	}
}

function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** Interpolates between two #rrggbb colors by t (0..1). */
function lerpColor(a: string, b: string, t: number): string {
	const pa = parseInt(a.slice(1), 16);
	const pb = parseInt(b.slice(1), 16);
	const r = Math.round(((pa >> 16) & 0xff) + (((pb >> 16) & 0xff) - ((pa >> 16) & 0xff)) * t);
	const g = Math.round(((pa >> 8) & 0xff) + (((pb >> 8) & 0xff) - ((pa >> 8) & 0xff)) * t);
	const bl = Math.round((pa & 0xff) + ((pb & 0xff) - (pa & 0xff)) * t);
	return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

/**
 * Renders a colored agent key as an SVG data URL (144x144, MK.2 resolution).
 * `phase` is 0..1: for the running state it drives a big blue background with
 * a white solid ring in the middle of the key that breathes in size
 * (small -> large -> small, via sin(pi*phase)) and repeats; for waiting/error
 * it smoothly breathes between the dark flash color and the bright base color.
 */
function agentKeyImage(slot: number, status: AgentStatus, title: string, phase: number, selected: boolean): string {
	const color = STATUS_COLOR[status];
	let bg = color.base;
	if (status === "running" || status === "unread" || status === "waiting" || status === "error") {
		// Smooth pulse: dim -> bright -> dim over one full cycle. Running,
		// unread, waiting and error share the same timing and amplitude.
		const breathe = (Math.sin(phase * Math.PI * 2) + 1) / 2;
		bg = lerpColor(color.flash, color.base, breathe);
	}
	// Dark solid ring in the middle of the key: radius breathes with phase
	// (outer edge 0 -> max -> 0, via sin(pi*phase)) at 60% opacity, repeating.
	// The -8 offset cancels half the 16px stroke so the ring's outer edge
	// starts at exactly 0; a negative radius is not rendered by SVG.
	const pulse = status === "running" ? Math.max(0, Math.sin(Math.PI * phase)) : 0;
	const ringRadius = status === "running" ? 64 * pulse - 8 : 0;
	const bilingual = SESSION_LANG === "zh-en";
	const english = SESSION_LANG === "en";
	const statusText = bilingual
		? `${STATUS_TEXT[status]} · ${STATUS_TEXT_EN[status]}`
		: english
			? STATUS_TEXT_EN[status]
			: STATUS_TEXT[status];
	const titleText = escapeXml(title ? truncatePreview(title, 10) : english ? "Untitled" : "无标题");
	const sessionText = `${selected ? "▸ " : ""}${english ? "Session" : "最新对话"} ${slot + 1}`;
	const sessionSub = bilingual ? `Session ${slot + 1}` : "";
	const topY = bilingual ? 34 : 38;
	const topSize = bilingual ? 19 : 24;
	const statusY = bilingual ? 86 : 76;
	const statusSize = bilingual ? 21 : 26;
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
		`<rect width="144" height="144" rx="18" fill="${bg}"/>` +
		(ringRadius > 0.02
			? `<circle cx="72" cy="72" r="${ringRadius.toFixed(1)}" fill="none" stroke="#1c4fbd" stroke-width="16" opacity="0.6"/>`
			: "") +
		`<text x="72" y="${topY}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${topSize}" font-weight="bold" fill="#1a1a1a">${sessionText}</text>` +
		(bilingual
			? `<text x="72" y="55" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="13" fill="#1a1a1a" opacity="0.75">${sessionSub}</text>`
			: "") +
		`<text x="72" y="${statusY}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${statusSize}" font-weight="bold" fill="#1a1a1a">${statusText}</text>` +
		`<text x="72" y="118" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="15" fill="#1a1a1a" opacity="0.75">${titleText}</text>` +
		`</svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

class CodexService extends EventEmitter {
	readonly client = new CodexClient();
	readonly slotCount = SLOT_COUNT;

	threads: (CodexThread | null)[] = Array<CodexThread | null>(SLOT_COUNT).fill(null);
	statuses: AgentStatus[] = Array<AgentStatus>(SLOT_COUNT).fill("offline");
	selectedSlot = 0;
	/** Reasoning effort of the most recently active thread, read from the app's own state. */
	reasoningEffort: string | null = null;
	private reasoningDb: DatabaseSync | null = null;
	private reasoningTimer: NodeJS.Timeout | null = null;

	get reasoningLabel(): string {
		if (!this.reasoningEffort) {
			return "—";
		}
		const labels = SESSION_LANG === "en" ? REASONING_LABEL_EN : REASONING_LABEL;
		return labels[this.reasoningEffort] ?? this.reasoningEffort;
	}

	private readonly actionsBySlot = new Map<number, KeyRenderable[]>();
	/** Breathing timers/phases are tracked per key instance (per profile), so a
	 * demo key can never change how a real key on the same slot renders. */
	private readonly breathTimers = new Map<KeyRenderable, NodeJS.Timeout>();
	private readonly breathPhase = new Map<KeyRenderable, number>();
	private pollTimer: NodeJS.Timeout | null = null;
	private pendingApprovals = new Set<string>();
	private draftThreadId: string | null = null;
	private readonly demoActions = new Set<KeyRenderable>();
	/** Authoritative unread thread IDs, read from the desktop app's own state. */
	private unreadThreads = new Set<string>();
	/** Threads whose most recent turn failed — the desktop app does not persist
	 * an error badge anywhere, so this is read from thread/turns/list. */
	private failedThreads = new Set<string>();
	/** Cache: thread id -> updatedAt at which we last verified turn state. */
	private failedCheckAt = new Map<string, number>();
	/** Errors the user already opened/acknowledged: thread id -> updatedAt. */
	private acknowledgedErrors = new Map<string, number>();
	/** Threads the user opened through a session key; suppresses persisted unread
	 * until the app catches up (it clears the entry when the thread opens). */
	private readonly locallyReadThreads = new Set<string>();
	private unreadWatcher: ReturnType<typeof watch> | null = null;
	private unreadWatchTimer: NodeJS.Timeout | null = null;

	attach(slot: number, action: KeyRenderable, demo = false): void {
		const list = this.actionsBySlot.get(slot) ?? [];
		if (!list.includes(action)) {
			list.push(action);
			this.actionsBySlot.set(slot, list);
		}
		if (demo) {
			this.demoActions.add(action);
		} else {
			this.demoActions.delete(action);
		}
		streamDeck.logger.info(
			`Agent 键挂载 slot ${slot}${demo ? " (demo)" : ""}，槽内 ${list.length} 个实例`
		);
		this.updateSlot(slot);
	}

	detach(action: KeyRenderable): void {
		this.demoActions.delete(action);
		const breath = this.breathTimers.get(action);
		if (breath) {
			clearInterval(breath);
			this.breathTimers.delete(action);
		}
		this.breathPhase.delete(action);
		for (const [slot, list] of this.actionsBySlot) {
			const idx = list.indexOf(action);
			if (idx >= 0) {
				list.splice(idx, 1);
				streamDeck.logger.info(`Agent 键卸载 slot ${slot}，槽内剩余 ${list.length} 个实例`);
				if (list.length === 0) {
					this.actionsBySlot.delete(slot);
				} else {
					// Re-render the remaining instance with its own status so a
					// profile switch never leaves stale images behind.
					for (const remaining of list) {
						this.renderAction(remaining, slot);
					}
				}
				return;
			}
		}
	}

	async start(): Promise<void> {
		this.client.on("connected", () => {
			streamDeck.logger.info("已连接 Codex app-server");
			void this.refresh();
			this.pollTimer ??= setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
			this.reasoningTimer ??= setInterval(() => this.refreshReasoning(), REASONING_POLL_INTERVAL_MS);
			this.refreshReasoning();
		});
		this.client.on("disconnected", () => {
			streamDeck.logger.warn("Codex app-server 连接断开");
			this.statuses = Array<AgentStatus>(SLOT_COUNT).fill("offline");
			this.renderAll();
		});
		this.client.on("threadStatus", (threadId: string, type: string) => {
			const slot = this.threads.findIndex((t) => t?.id === threadId);
			if (slot >= 0 && this.threads[slot]) {
				this.threads[slot] = { ...this.threads[slot]!, status: type as CodexThread["status"] };
				this.updateSlot(slot);
			}
		});
		this.client.on("approval", (approval: ApprovalRequest) => {
			this.pendingApprovals.add(approval.threadId);
			const slot = this.threads.findIndex((t) => t?.id === approval.threadId);
			if (slot >= 0) {
				this.updateSlot(slot);
			}
		});
		this.client.on("approvalResolved", (approval: ApprovalRequest) => {
			this.pendingApprovals.delete(approval.threadId);
			const slot = this.threads.findIndex((t) => t?.id === approval.threadId);
			if (slot >= 0) {
				this.updateSlot(slot);
			}
		});
		this.client.on("thread/started", () => void this.refresh());
		this.client.on("thread/archived", () => void this.refresh());
		this.client.on("thread/deleted", () => void this.refresh());
		this.client.on("thread/unarchived", () => void this.refresh());
		this.startUnreadWatcher();
		this.loadAcknowledgedErrors();

		try {
			await this.client.connect();
		} catch (err) {
			streamDeck.logger.error(`连接 Codex app-server 失败: ${err instanceof Error ? err.message : String(err)}`);
			this.statuses = Array<AgentStatus>(SLOT_COUNT).fill("offline");
			this.renderAll();
			this.emit("error", err);
		}
	}

	async stop(): Promise<void> {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.reasoningTimer) {
			clearInterval(this.reasoningTimer);
			this.reasoningTimer = null;
		}
		if (this.unreadWatchTimer) {
			clearTimeout(this.unreadWatchTimer);
			this.unreadWatchTimer = null;
		}
		this.unreadWatcher?.close();
		this.unreadWatcher = null;
		this.reasoningDb?.close();
		this.reasoningDb = null;
		for (const timer of this.breathTimers.values()) {
			clearInterval(timer);
		}
		this.breathTimers.clear();
		this.breathPhase.clear();
		await this.client.stop();
	}

	select(slot: number): void {
		this.selectedSlot = slot;
		const thread = this.threads[slot];
		if (thread?.id) {
			this.unreadThreads.delete(thread.id);
			this.locallyReadThreads.add(thread.id);
			// Opening the thread counts as acknowledging its error (same idea
			// as unread clearing on open). Persisted so restarts don't bring
			// the stale error back.
			this.acknowledgedErrors.set(thread.id, thread.updatedAt);
			this.failedThreads.delete(thread.id);
			this.persistAcknowledgedErrors();
			this.updateSlot(slot);
		}
		this.renderAll();
	}

	/**
	 * Switches the desktop Codex app to the given thread via its deep link
	 * (codex://threads/<threadId>, handled by the ChatGPT app). Returns whether
	 * `open` accepted the URL.
	 */
	jumpToThread(threadId: string | undefined): Promise<boolean> {
		if (!threadId) {
			return Promise.resolve(false);
		}
		const child = spawn("/usr/bin/open", [`codex://threads/${threadId}`], { stdio: "ignore" });
		return new Promise<boolean>((resolve) => {
			child.on("error", () => resolve(false));
			child.on("exit", (code) => resolve(code === 0));
		});
	}

	async refresh(): Promise<void> {
		try {
			const result = (await this.client.request("thread/list", {
				limit: 50,
				sortKey: "recency_at",
				sortDirection: "desc"
			})) as { data?: CodexThread[] };
			this.unreadThreads = this.readUnreadThreads();
			const threads = (result.data ?? []).sort((a, b) => {
				const aActive = a.status === "active" || a.status === "systemError" ? 0 : 1;
				const bActive = b.status === "active" || b.status === "systemError" ? 0 : 1;
				return aActive - bActive || b.updatedAt - a.updatedAt;
			});
			for (let i = 0; i < SLOT_COUNT; i++) {
				this.threads[i] = threads[i] ?? null;
			}
			// The desktop app does not persist an error badge; the only place a
			// failed turn is visible is thread/turns/list. Refresh those flags
			// before re-rendering so a failed thread shows 错误, not 未读.
			await Promise.all(
				threads.slice(0, SLOT_COUNT).map((thread) => this.refreshFailedState(thread))
			);
			for (let i = 0; i < SLOT_COUNT; i++) {
				this.updateSlot(i);
			}
			const loaded = threads.filter((t) => t !== null).length;
			streamDeck.logger.info(`刷新对话列表：共 ${loaded} 个可见对话`);
		} catch (err) {
			// Keep the previous state; next poll will retry.
			streamDeck.logger.warn(`刷新对话列表失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Checks whether the thread's most recent turn failed, using the app-server
	 * `thread/turns/list` endpoint. Cached per updatedAt so we only re-query
	 * when the thread actually changed.
	 */
	private async refreshFailedState(thread: CodexThread | null): Promise<void> {
		if (!thread?.id) {
			return;
		}
		if (this.failedCheckAt.get(thread.id) === thread.updatedAt) {
			return;
		}
		try {
			const result = (await this.client.request("thread/turns/list", {
				threadId: thread.id,
				limit: 1
			})) as { data?: { status?: string }[] };
			const newest = result.data?.[0];
			if (newest?.status === "failed") {
				// An error the user already opened stays cleared (it only
				// reappears if a NEWER turn fails, which changes updatedAt).
				if (this.acknowledgedErrors.get(thread.id) !== thread.updatedAt) {
					this.failedThreads.add(thread.id);
					streamDeck.logger.info(`对话 turn 失败: ${thread.id}`);
				} else {
					this.failedThreads.delete(thread.id);
				}
			} else {
				this.failedThreads.delete(thread.id);
			}
			this.failedCheckAt.set(thread.id, thread.updatedAt);
		} catch {
			// Keep the previous flag; next poll retries.
		}
	}

	/** Loads persisted error acknowledgements from the plugin's logs dir. */
	private loadAcknowledgedErrors(): void {
		try {
			const state = JSON.parse(readFileSync(ACK_ERRORS_PATH, "utf8")) as Record<string, number>;
			this.acknowledgedErrors = new Map(Object.entries(state));
		} catch {
			this.acknowledgedErrors = new Map();
		}
	}

	private persistAcknowledgedErrors(): void {
		try {
			writeFileSync(
				ACK_ERRORS_PATH,
				JSON.stringify(Object.fromEntries(this.acknowledgedErrors), null, 2),
				"utf8"
			);
		} catch (err) {
			streamDeck.logger.warn(
				`保存已确认错误状态失败: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	/**
	 * Reads the unread thread IDs the desktop app itself persists. Returns the
	 * previous set on read/parse failure so a transient write does not flip
	 * every key to idle; the next poll (or watch event) retries.
	 */
	private readUnreadThreads(): Set<string> {
		try {
			const state = JSON.parse(readFileSync(GLOBAL_STATE_PATH, "utf8")) as {
				"electron-persisted-atom-state"?: {
					"unread-thread-ids-by-host-v1"?: Record<string, string[]>;
				};
			};
			const byHost =
				state["electron-persisted-atom-state"]?.["unread-thread-ids-by-host-v1"];
			return new Set(Object.values(byHost ?? {}).flat());
		} catch (err) {
			streamDeck.logger.warn(
				`读取未读状态失败: ${err instanceof Error ? err.message : String(err)}`
			);
			return this.unreadThreads;
		}
	}

	/**
	 * Watches the desktop app's global-state file so a thread that just gained
	 * (or lost) unread activity switches to the green 未读 key within ~250ms
	 * instead of waiting for the next 5s poll.
	 */
	private startUnreadWatcher(): void {
		try {
			this.unreadWatcher?.close();
			// Watch the .codex directory (not the file itself): the Electron app
			// atomically replaces the global-state file on write, which can make
			// a file watcher go stale. Directory FSEvents survive renames.
			this.unreadWatcher = watch(dirname(GLOBAL_STATE_PATH), { persistent: false }, (_event, filename) => {
				if (filename !== basename(GLOBAL_STATE_PATH)) {
					return;
				}
				if (this.unreadWatchTimer) {
					clearTimeout(this.unreadWatchTimer);
				}
				this.unreadWatchTimer = setTimeout(() => {
					this.unreadWatchTimer = null;
					this.unreadThreads = this.readUnreadThreads();
					for (let slot = 0; slot < SLOT_COUNT; slot++) {
						this.updateSlot(slot);
					}
				}, 250);
			});
			streamDeck.logger.info("已监听 Codex 未读状态文件");
		} catch (err) {
			streamDeck.logger.warn(
				`监听未读状态文件失败: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	/**
	 * Sends a prompt to the draft thread created by New Chat (if any), otherwise
	 * to the selected thread. Sending to the draft is what materializes it on
	 * disk so it becomes visible in the desktop app and in our own thread list.
	 */
	async sendText(text: string): Promise<"sent" | "noThread" | "failed"> {
		const threadId = this.draftThreadId ?? this.threads[this.selectedSlot]?.id;
		if (!threadId) {
			return "noThread";
		}
		try {
			await this.client.request("turn/start", {
				threadId,
				input: [{ type: "text", text }],
				effort: this.reasoningEffort ?? undefined
			});
			const wasDraft = this.draftThreadId !== null;
			this.draftThreadId = null;
			if (wasDraft) {
				await this.refresh();
				this.selectedSlot = 0;
				this.renderAll();
			}
			return "sent";
		} catch {
			return "failed";
		}
	}

	/**
	 * Creates a draft thread in the daemon. The thread stays in-memory until the
	 * first turn is sent (Send key), which persists it and makes it visible in
	 * the desktop app and in our list. Uses the selected thread's workspace so
	 * the new conversation starts in the same project.
	 */
	async newChat(): Promise<"created" | "draft" | "failed"> {
		if (this.draftThreadId) {
			return "draft";
		}
		const cwd = this.threads[this.selectedSlot]?.cwd;
		try {
			const result = (await this.client.request("thread/start", {
				...(cwd ? { cwd } : {}),
				// Desktop-created threads carry thread_source "user"; without it the
				// desktop app's conversation list may hide the new thread.
				threadSource: "user"
			})) as {
				thread?: { id?: string };
			};
			const id = result.thread?.id;
			if (!id) {
				return "failed";
			}
			try {
				const time = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
				await this.client.request("thread/name/set", { threadId: id, name: `新对话 ${time}` });
			} catch {
				// Naming is best-effort; the thread is still usable without it.
			}
			this.draftThreadId = id;
			return "created";
		} catch {
			return "failed";
		}
	}

	acceptPending(): boolean {
		const thread = this.threads[this.selectedSlot];
		return this.client.resolveApproval("accept", thread?.id) !== null;
	}

	rejectPending(): boolean {
		const thread = this.threads[this.selectedSlot];
		return this.client.resolveApproval("decline", thread?.id) !== null;
	}

	/**
	 * Reads the reasoning effort the desktop app persisted for the most recently
	 * active thread. This is what keeps the key in sync with the app's real state.
	 */
	private refreshReasoning(): void {
		try {
			if (!this.reasoningDb) {
				this.reasoningDb = new DatabaseSync(join(homedir(), ".codex", "state_5.sqlite"), { readOnly: true });
			}
			const row = this.reasoningDb
				.prepare(
					"SELECT reasoning_effort FROM threads WHERE archived = 0 ORDER BY updated_at_ms DESC LIMIT 1"
				)
				.get() as { reasoning_effort: string | null } | undefined;
			const value = row?.reasoning_effort ?? null;
			if (value !== this.reasoningEffort) {
				this.reasoningEffort = value;
				streamDeck.logger.info(`推理等级已更新: ${this.reasoningLabel} (${value ?? "null"})`);
				this.emit("reasoning", this.reasoningLabel);
			}
		} catch (err) {
			streamDeck.logger.warn(`读取推理等级失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Push-to-talk: holds Option, taps Space, then releases Option — exactly the
	 * user's manual sequence. A tiny C helper posts these events at the HID
	 * event tap (closest to real hardware input, so global-hotkey listeners
	 * fire); if that binary is missing, an AppleScript key-down/key-up sequence
	 * is used as a fallback. Unlike cycleReasoning this deliberately does NOT
	 * activate Codex — the shortcut belongs to the user's external PTT tool.
	 */
	pushToTalk(): void {
		const child = spawn(PTT_HELPER_PATH, [], { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (err) => {
			streamDeck.logger.error(`PTT 辅助程序启动失败: ${err.message}，改用 AppleScript`);
			this.pushToTalkAppleScript();
		});
		child.on("exit", (code) => {
			if (code === 0) {
				streamDeck.logger.info("已发送 PTT (按住 Option → 空格)");
			} else {
				streamDeck.logger.error(`PTT 辅助程序退出码 ${code}: ${stderr.trim()}`);
			}
		});
	}

	private pushToTalkAppleScript(): void {
		const script = [
			'tell application "System Events"',
			'key down option',
			'delay 0.2',
			'key code 49',
			'key up option',
			'end tell'
		].join("\n");
		const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (err) => {
			streamDeck.logger.error(`PTT (AppleScript) 启动失败: ${err.message}`);
		});
		child.on("exit", (code) => {
			if (code === 0) {
				streamDeck.logger.info("已发送 PTT (AppleScript 按住 Option → 空格)");
			} else {
				streamDeck.logger.error(`PTT (AppleScript) 退出码 ${code}: ${stderr.trim()}`);
			}
		});
	}

	/**
	 * Triggers the desktop app's "Cycle reasoning effort" command through its
	 * ⌘⌥E shortcut (must match what is configured in the app's Keyboard
	 * shortcuts for "Cycle reasoning effort"). The Codex window is activated
	 * first so the keystroke cannot land in another app that happens to be
	 * frontmost. This child osascript runs under Stream Deck, which already
	 * holds the Accessibility permission used by its built-in hotkeys.
	 */
	cycleReasoning(): void {
		const script = [
			'tell application "System Events"',
			// Report which app was frontmost, for diagnostics.
			'set f to name of first application process whose frontmost is true',
			// Make sure the shortcut lands in the Codex desktop app (bundle com.openai.codex).
			'set frontmost of (first application process whose bundle identifier is "com.openai.codex") to true',
			'delay 0.2',
			// kVK_ANSI_E = 14; Cmd(8) + Option(4).
			'key code 14 using {command down, option down}',
			'return f',
			'end tell'
		].join("\n");
		const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (err) => {
			streamDeck.logger.error(`触发推理等级循环失败: ${err.message}`);
		});
		child.on("exit", (code) => {
			if (code === 0) {
				streamDeck.logger.info(`已触发推理等级循环 (⌘⌥E)，此前前台应用: ${stdout.trim() || "未知"}`);
				setTimeout(() => this.refreshReasoning(), 1000);
			} else {
				streamDeck.logger.error(`触发推理等级循环失败 (osascript 退出码 ${code}): ${stderr.trim()}`);
			}
		});
	}

	private updateSlot(slot: number): void {
		const thread = this.threads[slot];
		const prev = this.statuses[slot];
		let status: AgentStatus;
		if (!thread) {
			status = "idle";
		} else {
			const live = sessionState(thread.path ?? null);
			if (this.pendingApprovals.has(thread.id) || live === "waiting") {
				status = "waiting";
			} else if (thread.status === "active" || live === "running") {
				status = "running";
			} else if (thread.status === "systemError" || live === "error" || this.failedThreads.has(thread.id)) {
				status = "error";
			} else {
				// The persisted unread set is authoritative; a thread the user
				// already opened via our key stays idle while the app catches up.
				status =
					this.unreadThreads.has(thread.id) && !this.locallyReadThreads.has(thread.id)
						? "unread"
						: "idle";
			}
		}
		// A turn that just finished (was running, now done) becomes "unread"
		// right away, filling the gap until the desktop app persists the entry
		// (the next poll's persisted set replaces any heuristic-only entry).
		if (
			thread &&
			prev === "running" &&
			status === "idle" &&
			!this.locallyReadThreads.has(thread.id)
		) {
			this.unreadThreads.add(thread.id);
			status = "unread";
		}
		if (thread && status === "running") {
			this.unreadThreads.delete(thread.id);
			this.locallyReadThreads.delete(thread.id);
		}
		this.statuses[slot] = status;
		// Per-instance rendering: demo keys keep their fixed showcase status,
		// real keys use the live status computed above. One profile can never
		// leak its demo state into the other, even if both happen to be mounted.
		for (const action of this.actionsBySlot.get(slot) ?? []) {
			this.setAnimation(action, this.statusFor(action, slot));
			this.renderAction(action, slot);
		}
	}

	/**
	 * Effective status for one key instance: demo keys force the fixed
	 * showcase status; real keys use the live thread status for the slot.
	 */
	private statusFor(action: KeyRenderable, slot: number): AgentStatus {
		if (this.demoActions.has(action)) {
			return DEMO_STATUSES[slot] ?? "idle";
		}
		return this.statuses[slot];
	}

	/**
	 * Drives the per-instance breathing animation:
	 * - running / unread / waiting / error: smooth breathing (brightness
	 *   oscillates dim -> bright -> dim over one BREATH_PERIOD_MS cycle);
	 * - everything else: static.
	 */
	private setAnimation(action: KeyRenderable, status: AgentStatus): void {
		const breath = this.breathTimers.get(action);
		if (breath) {
			clearInterval(breath);
			this.breathTimers.delete(action);
		}
		this.breathPhase.delete(action);

		if (
			status === "running" ||
			status === "unread" ||
			status === "waiting" ||
			status === "error"
		) {
			this.breathPhase.set(action, 0);
			this.breathTimers.set(
				action,
				setInterval(() => {
					const phase =
						(this.breathPhase.get(action) ?? 0) + BREATH_INTERVAL_MS / BREATH_PERIOD_MS;
					this.breathPhase.set(action, phase % 1);
					const slot = this.slotOfAction(action);
					if (slot >= 0) {
						this.renderAction(action, slot);
					}
				}, BREATH_INTERVAL_MS)
			);
		}
	}

	private slotOfAction(action: KeyRenderable): number {
		for (const [slot, list] of this.actionsBySlot) {
			if (list.includes(action)) {
				return slot;
			}
		}
		return -1;
	}

	private renderAll(): void {
		for (let slot = 0; slot < SLOT_COUNT; slot++) {
			this.render(slot);
		}
	}

	private render(slot: number): void {
		for (const action of this.actionsBySlot.get(slot) ?? []) {
			this.renderAction(action, slot);
		}
	}

	private renderAction(action: KeyRenderable, slot: number): void {
		const thread = this.threads[slot];
		const status = this.statusFor(action, slot);
		const selected = slot === this.selectedSlot;
		const title = thread?.name ?? thread?.preview ?? "";
		const phase = this.breathPhase.get(action) ?? 0;
		const image = agentKeyImage(slot, status, title, phase, selected);

		void action.setImage(image);
		void action.setTitle("");
	}
}

export const codex = new CodexService();
