/**
 * One-shot setup for the Codex app-server daemon on macOS.
 *
 * The daemon requires a "standalone" Codex binary at
 * ~/.codex/packages/standalone/current/codex. This script creates that path
 * pointing at the Codex binary bundled with the ChatGPT desktop app, then
 * starts the daemon. Run with Node.js 24+:
 *
 *   node scripts/setup-daemon.mjs
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const codeHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const bundledCli = "/Applications/ChatGPT.app/Contents/Resources/codex";
const currentDir = join(codeHome, "packages", "standalone", "current");
const target = join(currentDir, "codex");

if (!existsSync(bundledCli)) {
	console.error(`未找到 ChatGPT 桌面版捆绑的 codex：${bundledCli}`);
	process.exit(1);
}

mkdirSync(currentDir, { recursive: true });
if (existsSync(target)) {
	rmSync(target);
}
symlinkSync(bundledCli, target);
console.log(`standalone codex -> ${bundledCli}`);

const result = spawnSync("codex", ["app-server", "daemon", "start"], { stdio: "inherit" });
process.exit(result.status ?? 1);
