import net from "node:net";
import { WebSocket } from "ws";

const SOCK = process.env.CODEX_SMOKE_SOCK ?? "/Users/hu/.codex/app-server-control/app-server-control.sock";

const ws = new WebSocket("ws://localhost", {
	createConnection: () => net.createConnection(SOCK),
	perMessageDeflate: false
});

let id = 0;
const pending = new Map();

function request(method, params) {
	const rid = ++id;
	ws.send(JSON.stringify({ id: rid, method, params }));
	return new Promise((resolve, reject) => pending.set(rid, { resolve, reject }));
}

ws.on("message", (data) => {
	const msg = JSON.parse(data.toString());
	if (typeof msg.id === "number" && pending.has(msg.id)) {
		const p = pending.get(msg.id);
		pending.delete(msg.id);
		if (msg.error) p.reject(new Error(msg.error.message));
		else p.resolve(msg.result);
	}
});

ws.on("open", async () => {
	try {
		await request("initialize", {
			clientInfo: { name: "codex_smoke", title: "Smoke", version: "0.0.1" },
			capabilities: { experimentalApi: true }
		});
		ws.send(JSON.stringify({ method: "initialized" }));

		const list = await request("thread/list", {
			limit: 20,
			sortKey: "recency_at",
			sortDirection: "desc",
			useStateDbOnly: true
		});
		for (const t of list.data ?? []) {
			console.log(
				JSON.stringify({
					id: t.id,
					name: t.name ?? "",
					preview: (t.preview ?? "").slice(0, 40),
					status: t.status?.type,
					source: t.source,
					cwd: t.cwd,
					updatedAt: t.updatedAt
				})
			);
		}
		const loaded = await request("thread/loaded/list", {});
		console.log("--- loaded ---", JSON.stringify(loaded));
		process.exit(0);
	} catch (err) {
		console.error("FAIL:", err.message);
		process.exit(1);
	}
});

setTimeout(() => process.exit(1), 10000);
