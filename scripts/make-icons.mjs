import { copyFileSync, deflateSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "com.codexdeck.sdPlugin", "imgs");

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA, 8-bit) — pure Node.js.
// ---------------------------------------------------------------------------

function crc32(buf) {
	let crc = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		crc ^= buf[i];
		for (let k = 0; k < 8; k++) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, "ascii");
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size, rgba) {
	const stride = size * 4 + 1;
	const raw = Buffer.alloc(stride * size);
	for (let y = 0; y < size; y++) {
		raw[y * stride] = 0;
		rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0))
	]);
}

// ---------------------------------------------------------------------------
// Supersampled rasterizer. draw(u, v) returns [r,g,b,a] (a in 0..255) or null.
// ---------------------------------------------------------------------------

const SS = 3;

function rasterize(size, draw) {
	const rgba = Buffer.alloc(size * size * 4);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			let r = 0, g = 0, b = 0, a = 0;
			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) {
					const u = (x + (sx + 0.5) / SS) / size;
					const v = (y + (sy + 0.5) / SS) / size;
					const c = draw(u, v);
					if (c) {
						r += c[0] * c[3];
						g += c[1] * c[3];
						b += c[2] * c[3];
						a += c[3];
					}
				}
			}
			const n = SS * SS;
			const i = (y * size + x) * 4;
			rgba[i] = Math.round(r / n);
			rgba[i + 1] = Math.round(g / n);
			rgba[i + 2] = Math.round(b / n);
			rgba[i + 3] = Math.round(a / n);
		}
	}
	return encodePng(size, rgba);
}

// ---------------------------------------------------------------------------
// Shape helpers (u/v in 0..1, sizes normalized to 1).
// ---------------------------------------------------------------------------

function distToSegment(px, py, ax, ay, bx, by) {
	const dx = bx - ax, dy = by - ay;
	const len2 = dx * dx + dy * dy;
	let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
	t = Math.max(0, Math.min(1, t));
	const cx = ax + t * dx, cy = ay + t * dy;
	return Math.hypot(px - cx, py - cy);
}

function inPolygon(px, py, pts) {
	let inside = false;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const [xi, yi] = pts[i];
		const [xj, yj] = pts[j];
		if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}

const WHITE = [255, 255, 255, 255];

function ring(u, v, cx = 0.5, cy = 0.5, ro = 0.42, rw = 0.09) {
	const d = Math.hypot(u - cx, v - cy);
	return Math.abs(d - ro) <= rw / 2 ? WHITE : null;
}

function polyline(u, v, pts, t) {
	for (let i = 0; i < pts.length - 1; i++) {
		if (distToSegment(u, v, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) <= t) {
			return WHITE;
		}
	}
	return null;
}

function cross(u, v, t = 0.07) {
	return (
		polyline(u, v, [[0.32, 0.32], [0.68, 0.68]], t) ??
		polyline(u, v, [[0.68, 0.32], [0.32, 0.68]], t)
	);
}

function plus(u, v, t = 0.07) {
	const vertical = Math.abs(u - 0.5) <= t && v >= 0.24 && v <= 0.76;
	const horizontal = Math.abs(v - 0.5) <= t && u >= 0.24 && u <= 0.76;
	return vertical || horizontal ? WHITE : null;
}

function check(u, v, t = 0.07) {
	return polyline(u, v, [[0.22, 0.54], [0.43, 0.74], [0.8, 0.3]], t);
}

function send(u, v) {
	const body = inPolygon(u, v, [[0.2, 0.2], [0.82, 0.5], [0.2, 0.8], [0.42, 0.5]]);
	return body ? WHITE : null;
}

function chevronLeft(u, v) {
	return inPolygon(u, v, [[0.66, 0.16], [0.3, 0.5], [0.66, 0.84], [0.58, 0.84], [0.22, 0.5], [0.58, 0.16]]) ? WHITE : null;
}

function chevronRight(u, v) {
	return inPolygon(u, v, [[0.34, 0.16], [0.7, 0.5], [0.34, 0.84], [0.42, 0.84], [0.78, 0.5], [0.42, 0.16]]) ? WHITE : null;
}

function gauge(u, v) {
	const cx = 0.5, cy = 0.62, ro = 0.34, rw = 0.07;
	const d = Math.hypot(u - cx, v - cy);
	const angle = (Math.atan2(v - cy, u - cx) * 180) / Math.PI;
	const onArc = Math.abs(d - ro) <= rw / 2 && angle >= 15 && angle <= 165;
	const needle = distToSegment(u, v, cx, cy, cx, cy - ro - 0.06) <= 0.035;
	return onArc || needle ? WHITE : null;
}

function mic(u, v) {
	const capsule =
		u >= 0.32 && u <= 0.68 &&
		v >= 0.16 && v <= 0.56 &&
		!(u < 0.42 && v < 0.26) && !(u > 0.58 && v < 0.26);
	const dome = Math.hypot(u - 0.5, v - 0.56) <= 0.18 && v >= 0.56;
	const stem = Math.abs(u - 0.5) <= 0.045 && v >= 0.56 && v <= 0.72;
	const base = Math.abs(u - 0.5) <= 0.16 && v >= 0.72 && v <= 0.82;
	return capsule || dome || stem || base ? WHITE : null;
}

// ---------------------------------------------------------------------------
// Composition helpers.
// ---------------------------------------------------------------------------

function onColor(shape, color) {
	return (u, v) => (shape(u, v) ? [color[0], color[1], color[2], 255] : null);
}

function onBg(shape, bg) {
	return (u, v) => (shape(u, v) ?? [bg[0], bg[1], bg[2], 255]);
}

function writePng(relPath, size, draw) {
	const png = rasterize(size, draw);
	const full = join(OUT, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, png);
}

// ---------------------------------------------------------------------------
// Palette.
// ---------------------------------------------------------------------------

const C = {
	pluginBg: [16, 18, 22],
	agentBg: [30, 34, 43],
	accept: [27, 158, 90],
	reject: [214, 69, 69],
	send: [45, 127, 249],
	newchat: [124, 92, 255],
	reasoning: [232, 137, 12],
	ptt: [15, 163, 163],
	chevronLeft: [23, 26, 32],
	chevronRight: [23, 26, 32],
	status: {
		offline: [58, 63, 71],
		unloaded: [85, 91, 102],
		idle: [32, 148, 88],
		running: [45, 127, 249],
		waiting: [232, 137, 12],
		error: [214, 69, 69]
	}
};

const GLYPHS = {
	accept: check,
	reject: cross,
	send,
	newchat: plus,
	reasoning: gauge,
	ptt: mic,
	agent: (u, v) => ring(u, v, 0.5, 0.5, 0.4, 0.11),
	chevronLeft,
	chevronRight
};

// Plugin icon: dark square + white ring + center dot.
writePng("plugin/marketplace.png", 256, (u, v) =>
	ring(u, v, 0.5, 0.5, 0.4, 0.09) ?? ring(u, v, 0.5, 0.5, 0.13, 0.07) ?? [C.pluginBg[0], C.pluginBg[1], C.pluginBg[2], 255]
);
writePng("plugin/marketplace@2x.png", 512, (u, v) =>
	ring(u, v, 0.5, 0.5, 0.4, 0.09) ?? ring(u, v, 0.5, 0.5, 0.13, 0.07) ?? [C.pluginBg[0], C.pluginBg[1], C.pluginBg[2], 255]
);

// Category icon: monochrome white ring on transparent.
writePng("plugin/category-icon.png", 28, (u, v) => ring(u, v, 0.5, 0.5, 0.38, 0.14));
writePng("plugin/category-icon@2x.png", 56, (u, v) => ring(u, v, 0.5, 0.5, 0.38, 0.14));

// Action icons (monochrome white on transparent) + key state images (colored).
for (const [name, glyph] of Object.entries(GLYPHS)) {
	writePng(`actions/${name}/icon.png`, 20, (u, v) => (glyph(u, v) ?? null));
	writePng(`actions/${name}/icon@2x.png`, 40, (u, v) => (glyph(u, v) ?? null));
	const color = name === "agent" ? C.agentBg : C[name];
	writePng(`actions/${name}/key.png`, 144, onBg(glyph, color));
	writePng(`actions/${name}/key@2x.png`, 288, onBg(glyph, color));
}

// Agent status lights (runtime setImage targets).
for (const [status, color] of Object.entries(C.status)) {
	writePng(`status/${status}.png`, 288, onBg((u, v) => ring(u, v, 0.5, 0.5, 0.38, 0.1), color));
}

// ---------------------------------------------------------------------------
// Fluent UI System Icons (czottmann/streamdeck-iconpack-fluentui-system-icons)
// replace the hand-drawn glyphs above. The pre-composited PNGs live in
// assets/fluent-keys/ (white glyph on the pure black key background, plus
// transparent palette icons); regenerate with scripts/fluent-keys.py if needed.
// ---------------------------------------------------------------------------
const FLUENT_ACTIONS = [
	"accept",
	"reject",
	"send",
	"newchat",
	"reasoning",
	"ptt",
	"chevronLeft",
	"chevronRight"
];
for (const name of FLUENT_ACTIONS) {
	const srcDir = join(ROOT, "assets", "fluent-keys", name);
	const dstDir = join(OUT, "actions", name);
	for (const file of ["key.png", "key@2x.png", "icon.png", "icon@2x.png"]) {
		copyFileSync(join(srcDir, file), join(dstDir, file));
	}
}

console.log("icons generated ->", OUT);
