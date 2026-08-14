import net from "node:net";
import { WebSocket } from "ws";

const SOCK = process.env.CODEX_SMOKE_SOCK ?? "/tmp/codex-smoke.sock";

const ws = new WebSocket("ws://localhost", {
	createConnection: () => net.createConnection(SOCK),
	perMessageDeflate: false
});

let nextId = 0;
const pending = new Map();

function request(method, params) {
	const id = ++nextId;
	const payload = { id, method };
	if (params !== undefined) payload.params = params;
	ws.send(JSON.stringify(payload));
	return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

ws.on("message", (data) => {
	const msg = JSON.parse(data.toString());
	if (typeof msg.id === "number" && pending.has(msg.id)) {
		const p = pending.get(msg.id);
		pending.delete(msg.id);
		if (msg.error) p.reject(new Error(msg.error.message ?? "rpc error"));
		else p.resolve(msg.result);
	} else if (typeof msg.method === "string") {
		console.log("notification:", msg.method, JSON.stringify(msg.params ?? {}).slice(0, 160));
	}
});

ws.on("error", (err) => {
	console.error("websocket error:", err.message);
	process.exit(1);
});

ws.on("open", async () => {
	try {
		const init = await request("initialize", {
			clientInfo: { name: "codex_smoke", title: "Smoke Test", version: "0.0.1" },
			capabilities: { experimentalApi: true }
		});
		console.log("initialize ok:", JSON.stringify(init).slice(0, 220));
		ws.send(JSON.stringify({ method: "initialized" }));

		const list = await request("thread/list", {
			limit: 10,
			sortKey: "recency_at",
			sortDirection: "desc",
			useStateDbOnly: true
		});
		console.log("thread/list ok:", JSON.stringify(list).slice(0, 800));
		const loaded = await request("thread/loaded/list", {});
		console.log("thread/loaded/list ok:", JSON.stringify(loaded).slice(0, 300));
		process.exit(0);
	} catch (err) {
		console.error("FAIL:", err.message);
		process.exit(1);
	}
});

setTimeout(() => {
	console.error("timeout waiting for app-server");
	process.exit(1);
}, 15000);
