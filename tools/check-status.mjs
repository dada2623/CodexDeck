import net from "node:net";
import { WebSocket } from "ws";
import { homedir } from "node:os";
import { join } from "node:path";

const socketPath = join(homedir(), ".codex", "app-server-control", "app-server-control.sock");
const TARGET = "019fdbde-1e76-7d32-8b42-ee04730cb420";

const ws = new WebSocket("ws://localhost", {
  createConnection: () => net.createConnection(socketPath),
  perMessageDeflate: false,
  maxPayload: 64 * 1024 * 1024,
});

let nextId = 1;
const pending = new Map();

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.method === "thread/status/changed") {
    console.log("NOTIFY thread/status/changed:", JSON.stringify(msg.params));
    return;
  }
  if (msg.method === "remoteControl/status/changed") {
    console.log("NOTIFY remoteControl/status/changed:", JSON.stringify(msg.params).slice(0, 300));
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
});

ws.on("open", async () => {
  try {
    await request("initialize", {
      clientInfo: { name: "status-probe", title: "Status Probe", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    console.log("== thread/read target (includeTurns) ==");
    const read = await request("thread/read", { threadId: TARGET, includeTurns: true });
    const t = read.thread;
    console.log("status:", JSON.stringify(t.status));
    console.log("turns:", t.turns?.length);
    const last = t.turns?.at(-1);
    if (last) {
      console.log("last turn id:", last.id, "status:", last.status);
      console.log("last turn raw:", JSON.stringify(last).slice(0, 1200));
      const items = last.items ?? [];
      console.log("last turn items:", items.length);
      for (const it of items.slice(-8)) {
        console.log("  item:", it.type, "status=", it.status ?? "", "name=", it.name ?? "", "call_id=", it.callId ?? "");
        if (it.type === "functionCall" && it.arguments) {
          console.log("    args:", String(it.arguments).slice(0, 200));
        }
      }
    }

    console.log("== thread/list (first 12) ==");
    const list = await request("thread/list", {
      limit: 12,
      sortKey: "recency_at",
      sortDirection: "desc",
    });
    for (const t of list.data) {
      console.log(t.id, t.name ?? "", JSON.stringify(t.status), t.updatedAt, t.source);
    }

    console.log("== thread/loaded/list ==");
    const loaded = await request("thread/loaded/list", {});
    console.log(JSON.stringify(loaded));
  } catch (err) {
    console.error("ERROR", err.message);
  }
  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 1500);
});

ws.on("error", (err) => {
  console.error("WS ERROR", err.message);
  process.exit(1);
});
