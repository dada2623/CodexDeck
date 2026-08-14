import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { WebSocket } from "ws";

const DEFAULT_CODE_HOME = join(homedir(), ".codex");
const DEFAULT_CLI_PATH = "/Applications/ChatGPT.app/Contents/Resources/codex";

export type ThreadStatusType = "notLoaded" | "idle" | "active" | "systemError";

export interface CodexThread {
	id: string;
	preview: string;
	createdAt: number;
	updatedAt: number;
	status: ThreadStatusType;
	cwd?: string;
	/** Path to the thread's session file on disk (used to infer live status). */
	path?: string | null;
	/** User-visible thread title (may be absent; fall back to the preview). */
	name?: string | null;
}

export interface ApprovalRequest {
	requestId: number;
	method: string;
	threadId: string;
	turnId?: string;
	itemId: string;
	kind: "command" | "fileChange" | "permissions";
	command?: string;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
}

interface CodexClientOptions {
	codeHome?: string;
	codexCliPath?: string;
}

/**
 * Minimal JSON-RPC 2.0 client for the Codex app-server control socket.
 *
 * Wire format: newline-delimited JSON without the "jsonrpc" header, exactly as
 * documented in the openai/codex app-server README.
 */
export class CodexClient extends EventEmitter {
	readonly socketPath: string;
	readonly codexCliPath: string;

	private ws: WebSocket | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private approvals = new Map<number, ApprovalRequest>();
	private approvalsByThread = new Map<string, ApprovalRequest>();
	private connectedFlag = false;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private stopped = false;

	constructor(options: CodexClientOptions = {}) {
		super();
		const codeHome = options.codeHome ?? process.env.CODEX_HOME ?? DEFAULT_CODE_HOME;
		this.socketPath = join(codeHome, "app-server-control", "app-server-control.sock");
		this.codexCliPath = options.codexCliPath ?? process.env.CODEX_CLI_PATH ?? (existsSync(DEFAULT_CLI_PATH) ? DEFAULT_CLI_PATH : "codex");
	}

	get connected(): boolean {
		return this.connectedFlag;
	}

	async connect(): Promise<void> {
		if (this.ws) {
			return;
		}

		try {
			if (!existsSync(this.socketPath)) {
				await this.ensureDaemon();
			}

			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const ws = new WebSocket("ws://localhost", {
					createConnection: () => net.createConnection(this.socketPath),
					perMessageDeflate: false,
					maxPayload: 64 * 1024 * 1024
				});
				this.ws = ws;

				ws.on("open", () => {
					void this.initialize().then(() => {
						if (!settled) {
							settled = true;
							resolve();
						}
					}, (err: unknown) => {
						if (!settled) {
							settled = true;
							reject(err instanceof Error ? err : new Error(String(err)));
						}
					});
				});
				ws.on("message", (data) => {
					this.onMessage(data.toString());
				});
				ws.on("close", () => {
					this.onClosed();
				});
				ws.on("error", (err) => {
					if (!settled) {
						settled = true;
						reject(err);
					}
				});
			});
		} catch (err) {
			try {
				// After a reboot the old socket file can linger even though no
				// daemon is listening on it. Only a socket that is old enough to
				// be stale is removed — a freshly created one probably belongs
				// to a daemon that is still starting up.
				if (this.isStaleSocket()) {
					unlinkSync(this.socketPath);
				}
				if (!existsSync(this.socketPath)) {
					await this.ensureDaemon();
				}
			} catch {
				// Cleanup / daemon start is best-effort; the next retry repeats it.
			}
			this.scheduleReconnect();
			throw err;
		}
	}

	/** True when the control socket exists but has not been touched for 10s
	 * (i.e. it was left behind by a daemon that is no longer running). */
	private isStaleSocket(): boolean {
		try {
			return existsSync(this.socketPath) && Date.now() - statSync(this.socketPath).mtimeMs > 10_000;
		} catch {
			return false;
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.ws?.close();
		this.ws = null;
	}

	request(method: string, params?: unknown): Promise<unknown> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("Codex app-server 未连接"));
		}
		const id = this.nextId++;
		const payload: Record<string, unknown> = { id, method };
		if (params !== undefined) {
			payload.params = params;
		}
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws!.send(JSON.stringify(payload));
		});
	}

	respond(id: number, result: unknown): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return;
		}
		this.ws.send(JSON.stringify({ id, result }));
	}

	/**
	 * Responds to the most recent pending approval for the given thread (or any
	 * thread when none is given) with the specified decision.
	 */
	resolveApproval(decision: "accept" | "acceptForSession" | "decline" | "cancel", threadId?: string): ApprovalRequest | null {
		const approval = threadId ? this.approvalsByThread.get(threadId) : this.mostRecentApproval();
		if (!approval) {
			return null;
		}
		this.respond(approval.requestId, { decision });
		this.approvals.delete(approval.requestId);
		this.approvalsByThread.delete(approval.threadId);
		this.emit("approvalResolved", approval);
		return approval;
	}

	private mostRecentApproval(): ApprovalRequest | null {
		let latest: ApprovalRequest | null = null;
		for (const approval of this.approvals.values()) {
			if (!latest || approval.requestId > latest.requestId) {
				latest = approval;
			}
		}
		return latest;
	}

	private ensureDaemon(): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn(this.codexCliPath, ["app-server", "daemon", "start"], {
				stdio: "ignore"
			});
			child.on("error", reject);
			child.on("exit", (code) => {
				if (code !== 0) {
					reject(new Error(`codex app-server daemon start 退出码 ${code}`));
					return;
				}
				const deadline = Date.now() + 15000;
				const poll = (): void => {
					if (existsSync(this.socketPath)) {
						resolve();
						return;
					}
					if (Date.now() > deadline) {
						reject(new Error("等待 app-server 控制 socket 超时"));
						return;
					}
					setTimeout(poll, 300);
				};
				poll();
			});
		});
	}

	private async initialize(): Promise<void> {
		await this.request("initialize", {
			clientInfo: {
				name: "codex_micro_deck",
				title: "Codex Micro Deck",
				version: "1.0.0"
			},
			capabilities: {
				experimentalApi: true
			}
		});
		this.notify("initialized");
		this.connectedFlag = true;
		this.emit("connected");
	}

	private notify(method: string, params?: unknown): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return;
		}
		const payload: Record<string, unknown> = { method };
		if (params !== undefined) {
			payload.params = params;
		}
		this.ws.send(JSON.stringify(payload));
	}

	private onMessage(raw: string): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (msg === null || typeof msg !== "object") {
			return;
		}

		const method = typeof msg.method === "string" ? msg.method : undefined;
		const id = typeof msg.id === "number" ? msg.id : undefined;
		const params = (msg.params ?? {}) as Record<string, unknown>;

		// Server-initiated request that expects a response.
		if (method && id !== undefined && msg.result === undefined && msg.error === undefined) {
			this.onServerRequest(id, method, params);
			return;
		}

		// Response to one of our requests.
		if (id !== undefined) {
			const pending = this.pending.get(id);
			if (!pending) {
				return;
			}
			this.pending.delete(id);
			if (msg.error) {
				const errObj = msg.error as { message?: string };
				pending.reject(new Error(errObj.message ?? "JSON-RPC 错误"));
			} else {
				pending.resolve(msg.result);
			}
			return;
		}

		// Notification.
		if (method) {
			this.onNotification(method, params);
		}
	}

	private onServerRequest(id: number, method: string, params: Record<string, unknown>): void {
		// All decision-based approval requests the app-server can send. These
		// only reach the client that drives the turn (the desktop app's own
		// approvals are not broadcast), so the JSONL scan in service.ts is the
		// primary source for desktop-driven waits; this covers plugin-driven
		// turns for every flavor.
		const approvalMethods: Record<string, ApprovalRequest["kind"]> = {
			"item/commandExecution/requestApproval": "command",
			"item/fileChange/requestApproval": "fileChange",
			"item/permissions/requestApproval": "permissions",
			"applyPatchApproval": "fileChange",
			"execCommandApproval": "command"
		};
		const kind = approvalMethods[method];
		if (!kind) {
			return;
		}
		const approval: ApprovalRequest = {
			requestId: id,
			method,
			threadId: String(params.threadId ?? ""),
			turnId: params.turnId !== undefined ? String(params.turnId) : undefined,
			itemId: String(params.itemId ?? ""),
			kind,
			command: typeof params.command === "string" ? params.command : undefined
		};
		this.approvals.set(id, approval);
		this.approvalsByThread.set(approval.threadId, approval);
		this.emit("approval", approval);
	}

	private onNotification(method: string, params: Record<string, unknown>): void {
		switch (method) {
			case "thread/status/changed": {
				const threadId = String(params.threadId ?? "");
				const status = params.status as { type?: string } | undefined;
				if (threadId && status?.type) {
					this.emit("threadStatus", threadId, status.type);
				}
				break;
			}
			case "thread/started":
			case "thread/archived":
			case "thread/deleted":
			case "thread/unarchived":
			case "serverRequest/resolved":
				this.emit(method, params);
				break;
			default:
				break;
		}
	}

	private onClosed(): void {
		this.connectedFlag = false;
		this.ws = null;
		this.pending.forEach((pending) => pending.reject(new Error("Codex app-server 连接已关闭")));
		this.pending.clear();
		this.emit("disconnected");

		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer) {
			return;
		}
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (!this.stopped) {
				void this.connect().catch(() => {
					// connect() already schedules the next retry.
				});
			}
		}, 3000);
	}
}
