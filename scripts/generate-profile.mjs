import { deflateRawSync, inflateRawSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_UUID = "com.codexdeck";
const PLUGIN_NAME = "Codex Deck";
const PLUGIN_VERSION = "1.0.0";
/** Build language: "zh" (default) or "en". Affects page name and nav labels. */
const BUILD_LANG = process.env.CODEXDECK_LANG === "en" ? "en" : "zh";
const PAGE1_NAME = BUILD_LANG === "en" ? "Codex Console" : "Codex 控制台";
const PREV_CHAT_LABEL = BUILD_LANG === "en" ? "Previous Chat" : "上个对话";
const NEXT_CHAT_LABEL = BUILD_LANG === "en" ? "Next Chat" : "下个对话";

const COLORS = {
	agentBg: "#1e222b",
	accept: "#1b9e5a",
	reject: "#d64545",
	send: "#2d7ff9",
	newchat: "#7c5cff",
	reasoning: "#e8890c",
	ptt: "#0fa3a3",
	nav: "#171a20"
};

// ---------------------------------------------------------------------------
// SVG helpers (144 x 144, matching MK.2 key resolution).
// ---------------------------------------------------------------------------

function svgIcon(bg, inner) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
		`<rect width="144" height="144" fill="${bg}"/>${inner}</svg>`;
}

const GLYPHS = {
	accept: `<polyline points="30,76 58,104 114,42" fill="none" stroke="#ffffff" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>`,
	reject: `<path d="M44 44 L100 100 M100 44 L44 100" stroke="#ffffff" stroke-width="12" stroke-linecap="round"/>`,
	send: `<path d="M36 30 L112 72 L36 114 L54 72 Z" fill="#ffffff"/>`,
	newchat: `<path d="M62 30 h20 v24 h24 v20 h-24 v24 h-20 v-24 h-24 v-20 h24 Z" fill="#ffffff"/>`,
	reasoning: `<path d="M36 84 a36 36 0 0 1 72 0" fill="none" stroke="#ffffff" stroke-width="12" stroke-linecap="round"/>` +
		`<line x1="72" y1="84" x2="72" y2="50" stroke="#ffffff" stroke-width="8" stroke-linecap="round"/>`,
	ptt: `<path d="M56 26 h32 v36 a16 16 0 0 1 -32 0 Z" fill="#ffffff"/>` +
		`<path d="M44 66 a28 28 0 0 0 56 0" fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round"/>` +
		`<line x1="72" y1="94" x2="72" y2="114" stroke="#ffffff" stroke-width="8" stroke-linecap="round"/>` +
		`<line x1="52" y1="114" x2="92" y2="114" stroke="#ffffff" stroke-width="8" stroke-linecap="round"/>`,
	prev: `<path d="M80 36 L44 72 L80 108 L70 108 L34 72 L70 36 Z" fill="#ffffff"/>`,
	next: `<path d="M64 36 L100 72 L64 108 L74 108 L110 72 L74 36 Z" fill="#ffffff"/>`
};

function agentGlyph(n) {
	return `<circle cx="72" cy="72" r="46" fill="none" stroke="#ffffff" stroke-width="10"/>` +
		`<text x="72" y="90" font-family="Arial, Helvetica, sans-serif" font-size="52" font-weight="bold" fill="#ffffff" text-anchor="middle">${n}</text>`;
}

// ---------------------------------------------------------------------------
// Action definitions.
// ---------------------------------------------------------------------------

// Plugin-driven keys must NOT carry a custom Image/Title in the profile:
// Stream Deck treats an explicitly-set image/title as user-customized and then
// blocks the plugin's setImage/setTitle calls. Empty strings are exactly what
// the app writes when an action is dragged from the plugin panel, so the
// plugin keeps full control of the key rendering.
function actionDef(actionUuid, pluginUuid, pluginName, settings, label) {
	return {
		ActionID: randomUUID(),
		LinkedTitle: true,
		Name: label,
		Plugin: { Name: pluginName, UUID: pluginUuid, Version: PLUGIN_VERSION },
		Resources: null,
		Settings: settings,
		State: 0,
		States: [
			{
				FontFamily: "",
				FontSize: 9,
				FontStyle: "",
				FontUnderline: false,
				Image: "",
				OutlineThickness: 2,
				ShowTitle: true,
				Title: "",
				TitleAlignment: "bottom",
				TitleColor: "#ffffff"
			}
		],
		UUID: actionUuid
	};
}

function pluginAction(uuid, settings, label) {
	return actionDef(uuid, PLUGIN_UUID, PLUGIN_NAME, settings, label);
}

// Built-in Hotkey action: Cmd+N on macOS (NativeCode/VKeyCode = macOS virtual
// keycode 45 = kVK_ANSI_N, QTKeyCode = Qt::Key_N = 78, Cmd modifier bit = 8).
const CMD_N_HOTKEY = {
	KeyCmd: true,
	KeyCtrl: false,
	KeyModifiers: 8,
	KeyOption: false,
	KeyShift: false,
	NativeCode: 45,
	QTKeyCode: 78,
	VKeyCode: 45
};
// Cmd+Option+A / R / S (macOS kVK: A=0, R=15, S=1; Qt codes: A=65, R=82, S=83;
// Cmd=8 + Option=4 => KeyModifiers=12). Match these in the desktop app under
// Settings -> Keyboard shortcuts: Approve request / Decline request / Send message.
const CMD_OPT_A_HOTKEY = {
	KeyCmd: true,
	KeyCtrl: false,
	KeyModifiers: 12,
	KeyOption: true,
	KeyShift: false,
	NativeCode: 0,
	QTKeyCode: 65,
	VKeyCode: 0
};
const CMD_OPT_R_HOTKEY = {
	KeyCmd: true,
	KeyCtrl: false,
	KeyModifiers: 12,
	KeyOption: true,
	KeyShift: false,
	NativeCode: 15,
	QTKeyCode: 82,
	VKeyCode: 15
};
const CMD_OPT_S_HOTKEY = {
	KeyCmd: true,
	KeyCtrl: false,
	KeyModifiers: 12,
	KeyOption: true,
	KeyShift: false,
	NativeCode: 1,
	QTKeyCode: 83,
	VKeyCode: 1
};
// Option+Space (macOS kVK_Space = 49, Qt::Key_Space = 32; Option bit = 4).
const CMD_OPT_SPACE_HOTKEY = {
	KeyCmd: false,
	KeyCtrl: false,
	KeyModifiers: 4,
	KeyOption: true,
	KeyShift: false,
	NativeCode: 49,
	QTKeyCode: 32,
	VKeyCode: 49
};
// Cmd+Shift+[ / Cmd+Shift+] — the desktop app's default Previous/Next chat
// shortcuts (previousThread / nextThread). kVK: LeftBracket=33, RightBracket=30;
// Qt codes: 91 / 93; Cmd(8)+Shift(1)=9.
const CMD_SHIFT_LBRACKET_HOTKEY = {
	KeyCmd: true,
	KeyCtrl: false,
	KeyModifiers: 9,
	KeyOption: false,
	KeyShift: true,
	NativeCode: 33,
	QTKeyCode: 91,
	VKeyCode: 33
};
const CMD_SHIFT_RBRACKET_HOTKEY = {
	KeyCmd: true,
	KeyCtrl: false,
	KeyModifiers: 9,
	KeyOption: false,
	KeyShift: true,
	NativeCode: 30,
	QTKeyCode: 93,
	VKeyCode: 30
};
const EMPTY_HOTKEY = {
	KeyCmd: false,
	KeyCtrl: false,
	KeyModifiers: 0,
	KeyOption: false,
	KeyShift: false,
	NativeCode: -1,
	QTKeyCode: 33554431,
	VKeyCode: -1
};

function systemHotkeyAction(label, image, key) {
	return {
		ActionID: randomUUID(),
		LinkedTitle: true,
		Name: "Hotkey",
		Resources: null,
		Settings: {
			Coalesce: true,
			Hotkeys: [key, EMPTY_HOTKEY, EMPTY_HOTKEY, EMPTY_HOTKEY]
		},
		State: 0,
		States: [
			{
				FontFamily: "",
				FontSize: 9,
				FontStyle: "",
				FontUnderline: false,
				Image: image,
				OutlineThickness: 2,
				ShowTitle: false,
				Title: "",
				TitleAlignment: "bottom",
				TitleColor: "#ffffff"
			}
		],
		UUID: "com.elgato.streamdeck.system.hotkey"
	};
}

// Built-in "Open Application" action targeting the Codex desktop app
// (com.openai.codex), exactly as configured on the device.
function systemOpenAppAction(image) {
	return {
		ActionID: randomUUID(),
		LinkedTitle: true,
		Name: "Open Application",
		Plugin: { Name: "Open Application", UUID: "com.elgato.streamdeck.system.openapp", Version: "1.0" },
		Resources: null,
		Settings: {
			app_name: "ChatGPT",
			args: "",
			bring_to_front: true,
			bundle_id: "com.openai.codex",
			bundle_path: "/Applications/ChatGPT.app",
			exec: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
			is_bundle: true,
			long_press: "quit",
			source: "/Applications/ChatGPT.app"
		},
		State: 0,
		States: [
			{
				FontFamily: "",
				FontSize: 12,
				FontStyle: "",
				FontUnderline: false,
				Image: image,
				OutlineThickness: 2,
				ShowTitle: false,
				TitleAlignment: "bottom",
				TitleColor: "#ffffff"
			}
		],
		UUID: "com.elgato.streamdeck.system.openapp"
	};
}

// Built-in "Switch Profile" (rotate) action for the (2,2) key.
function systemProfileRotateAction(image) {
	return {
		ActionID: randomUUID(),
		LinkedTitle: true,
		Name: "Switch Profile",
		Plugin: { Name: "Switch Profile", UUID: "com.elgato.streamdeck.profile.rotate", Version: "1.0" },
		Resources: null,
		Settings: { DeviceUUID: "", PageIndex: 1, ProfileUUID: "" },
		State: 0,
		States: [{ Image: image }],
		UUID: "com.elgato.streamdeck.profile.rotate"
	};
}

// ---------------------------------------------------------------------------
// ZIP writer (deflate, no external deps).
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

function writeZip(files) {
	const local = [];
	const central = [];
	let offset = 0;
	for (const file of files) {
		const name = Buffer.from(file.path, "utf8");
		const data = file.data;
		const compressed = deflateRawSync(data);
		const crc = crc32(data);
		const method = 8;

		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);
		lh.writeUInt16LE(20, 4);
		lh.writeUInt16LE(0x0800, 6); // UTF-8 flag
		lh.writeUInt16LE(method, 8);
		lh.writeUInt16LE(0, 10);
		lh.writeUInt16LE(0, 12);
		lh.writeUInt32LE(crc, 14);
		lh.writeUInt32LE(compressed.length, 18);
		lh.writeUInt32LE(data.length, 22);
		lh.writeUInt16LE(name.length, 26);
		lh.writeUInt16LE(0, 28);
		local.push(lh, name, compressed);

		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0);
		ch.writeUInt16LE(20, 4);
		ch.writeUInt16LE(20, 6);
		ch.writeUInt16LE(0x0800, 8);
		ch.writeUInt16LE(method, 10);
		ch.writeUInt16LE(0, 12);
		ch.writeUInt16LE(0, 14);
		ch.writeUInt32LE(crc, 16);
		ch.writeUInt32LE(compressed.length, 20);
		ch.writeUInt32LE(data.length, 24);
		ch.writeUInt16LE(name.length, 28);
		ch.writeUInt16LE(0, 30);
		ch.writeUInt16LE(0, 32);
		ch.writeUInt16LE(0, 34);
		ch.writeUInt16LE(0, 36);
		ch.writeUInt32LE(0, 38);
		ch.writeUInt32LE(offset, 42);
		central.push(ch, name);

		offset += lh.length + name.length + compressed.length;
	}

	const centralStart = offset;
	const centralSize = central.reduce((sum, b) => sum + b.length, 0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(centralSize, 12);
	eocd.writeUInt32LE(centralStart, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...local, ...central, eocd]);
}

// ---------------------------------------------------------------------------
// Profile assembly.
// ---------------------------------------------------------------------------

const PROFILE_UUID = randomUUID().toUpperCase();
const PAGE1_UUID = randomUUID().toUpperCase();
const PAGE2_UUID = randomUUID().toUpperCase();
const PAGE3_UUID = randomUUID().toUpperCase();
const IMG = (name) => `Images/${name}.svg`;

function pageManifest(name, actions) {
	return {
		Controllers: [{ Actions: actions, Type: "Keypad" }],
		Icon: "",
		Name: name
	};
}

function buildMainPage() {
	const actions = {};

	// Row 0: five agent keys.
	for (let i = 0; i < 5; i++) {
		actions[`${i},0`] = pluginAction(`${PLUGIN_UUID}.agent`, { slot: i }, `Session ${i + 1}`);
	}

	// Row 1: Accept / Reject / Codex app / New Chat / Reasoning.
	actions["0,1"] = systemHotkeyAction("Accept", "Images/accept.png", CMD_OPT_A_HOTKEY);
	actions["1,1"] = systemHotkeyAction("Reject", "Images/reject.png", CMD_OPT_R_HOTKEY);
	actions["2,1"] = systemOpenAppAction("Images/chatgpt.png");
	actions["3,1"] = systemHotkeyAction("New Chat", "Images/newchat.png", CMD_N_HOTKEY);
	actions["4,1"] = pluginAction(`${PLUGIN_UUID}.reasoning`, {}, "Reasoning");

	// Row 2: PTT / Send / switch profile / previous / next.
	actions["0,2"] = pluginAction(`${PLUGIN_UUID}.ptt`, {}, "PTT");
	actions["1,2"] = systemHotkeyAction("Send", "Images/send.png", CMD_OPT_S_HOTKEY);
	actions["2,2"] = systemProfileRotateAction("Images/profile-switch.png");
	actions["3,2"] = systemHotkeyAction(PREV_CHAT_LABEL, "Images/chevronLeft.png", CMD_SHIFT_LBRACKET_HOTKEY);
	actions["4,2"] = systemHotkeyAction(NEXT_CHAT_LABEL, "Images/chevronRight.png", CMD_SHIFT_RBRACKET_HOTKEY);

	return { actions };
}

const mainPage = buildMainPage();
const HOTKEY_PNG = (name) =>
	readFileSync(join(ROOT, "com.codexdeck.sdPlugin", "imgs", "actions", name, "key.png"));

// The physical Stream Deck 2 device UUID, as stored in the installed profile.
const DEVICE_UUID = "@(1)[4057/128/A73NA3262ILTT8]";

const files = [
	{
		path: `${PROFILE_UUID}.sdProfile/manifest.json`,
		data: Buffer.from(JSON.stringify({
			AppIdentifier: "/Applications/ChatGPT.app",
			Device: { Model: "20GBA9901", UUID: DEVICE_UUID },
			Name: "Codex Micro",
			Pages: {
				Current: "00000000-0000-0000-0000-000000000000",
				Default: PAGE1_UUID,
				Pages: [PAGE2_UUID, PAGE3_UUID]
			},
			Version: "3.0"
		}, null, 2))
	},
	{
		path: `${PROFILE_UUID}.sdProfile/Profiles/${PAGE1_UUID}/manifest.json`,
		data: Buffer.from(JSON.stringify(pageManifest(PAGE1_NAME, mainPage.actions), null, 2))
	},
	{
		path: `${PROFILE_UUID}.sdProfile/Profiles/${PAGE2_UUID}/manifest.json`,
		data: Buffer.from(JSON.stringify(pageManifest("Page 2", {}), null, 2))
	},
	{
		path: `${PROFILE_UUID}.sdProfile/Profiles/${PAGE3_UUID}/manifest.json`,
		data: Buffer.from(JSON.stringify(pageManifest("Page 3", {}), null, 2))
	}
];

for (const name of ["accept", "reject", "send", "newchat", "chevronLeft", "chevronRight"]) {
	files.push({
		path: `${PROFILE_UUID}.sdProfile/Profiles/${PAGE1_UUID}/Images/${name}.png`,
		data: HOTKEY_PNG(name)
	});
}
files.push({
	path: `${PROFILE_UUID}.sdProfile/Profiles/${PAGE1_UUID}/Images/chatgpt.png`,
	data: readFileSync(join(ROOT, "extracted-icons", "chatgpt-key-144.png"))
});
files.push({
	path: `${PROFILE_UUID}.sdProfile/Profiles/${PAGE1_UUID}/Images/profile-switch.png`,
	data: readFileSync(join(ROOT, "extracted-icons", "profile-switch-144.png"))
});

const zip = writeZip(files);

const bundledPath = join(ROOT, "com.codexdeck.sdPlugin", "profiles", "codex-micro.streamDeckProfile");
const standalonePath = join(ROOT, "profiles", "Codex Micro.streamDeckProfile");
mkdirSync(dirname(bundledPath), { recursive: true });
mkdirSync(dirname(standalonePath), { recursive: true });
writeFileSync(bundledPath, zip);
writeFileSync(standalonePath, zip);

console.log(`profile generated: ${bundledPath} (${zip.length} bytes)`);
console.log(`standalone copy: ${standalonePath}`);
