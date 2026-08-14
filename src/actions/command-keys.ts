import streamDeck, {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
	type KeyAction
} from "@elgato/streamdeck";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codex, type KeyRenderable } from "../codex/service";

/**
 * 144x144 key icons shipped with the plugin (dark background + white glyph,
 * matching the Codex Micro render). The image is loaded from the plugin bundle
 * and passed as a base64 data URL. Key images/titles must NOT be set in the
 * profile, otherwise Stream Deck treats them as user-customized and blocks the
 * plugin's setImage/setTitle calls.
 */
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function pngDataUrl(relPath: string): string {
	return `data:image/png;base64,${readFileSync(join(PLUGIN_ROOT, relPath)).toString("base64")}`;
}

const REASONING_IMAGE = pngDataUrl("imgs/actions/reasoning/key.png");
const PTT_IMAGE = pngDataUrl("imgs/actions/ptt/key.png");

const DEFAULT_TITLES: Record<string, string> = {
	accept: "Accept",
	reject: "Reject",
	send: "Send",
	newchat: "New Chat",
	reasoning: "Reasoning",
	ptt: "PTT"
};

type SimpleSettings = {
	prompt?: string;
};

function flash(action: KeyAction, title: string, restoreTo: string): void {
	void action.setTitle(title);
	setTimeout(() => void action.setTitle(restoreTo), 1200);
}

/** Approves the pending command/file-change request of the selected thread. */
@action({ UUID: "com.codexdeck.accept" })
export class AcceptAction extends SingletonAction {
	override onKeyDown(ev: KeyDownEvent): void {
		flash(ev.action, codex.acceptPending() ? "✓ 已接受" : "无待审批", DEFAULT_TITLES.accept);
	}
}

/** Declines the pending command/file-change request of the selected thread. */
@action({ UUID: "com.codexdeck.reject" })
export class RejectAction extends SingletonAction {
	override onKeyDown(ev: KeyDownEvent): void {
		flash(ev.action, codex.rejectPending() ? "✗ 已拒绝" : "无待审批", DEFAULT_TITLES.reject);
	}
}

/** Sends a prompt to the selected thread (default: "继续"). */
@action({ UUID: "com.codexdeck.send" })
export class SendAction extends SingletonAction<SimpleSettings> {
	override onKeyDown(ev: KeyDownEvent<SimpleSettings>): void {
		const prompt = ev.payload.settings.prompt?.trim() || "继续";
		void codex.sendText(prompt).then((ok) => {
			const text = ok === "sent" ? "✓ 已发送" : ok === "noThread" ? "✗ 无对话" : "✗ 发送失败";
			flash(ev.action, text, DEFAULT_TITLES.send);
		});
	}
}

/** Starts a brand new Codex thread. */
@action({ UUID: "com.codexdeck.newchat" })
export class NewChatAction extends SingletonAction {
	override onKeyDown(ev: KeyDownEvent): void {
		void codex.newChat().then((ok) => {
			const text =
				ok === "created" ? "✓ 已新建\n按 Send 开始" : ok === "draft" ? "已有草稿\n按 Send" : "✗ 失败";
			flash(ev.action, text, DEFAULT_TITLES.newchat);
		});
	}
}

/**
 * Shows the desktop app's live reasoning effort (read from the app's own
 * persisted state) and cycles it via the app's ⌘⌥E shortcut when pressed.
 */
@action({ UUID: "com.codexdeck.reasoning" })
export class ReasoningAction extends SingletonAction {
	private static instances = new Set<KeyRenderable>();
	private listening = false;

	private onReasoning = (): void => {
		streamDeck.logger.info(`推理等级更新: ${codex.reasoningLabel}`);
		for (const action of ReasoningAction.instances) {
			void action.setTitle(this.title(codex.reasoningLabel));
		}
	};

	override onWillAppear(ev: WillAppearEvent): void {
		ReasoningAction.instances.add(ev.action);
		if (!this.listening) {
			codex.on("reasoning", this.onReasoning);
			this.listening = true;
		}
		streamDeck.logger.info(`Reasoning 键已挂载，当前等级: ${codex.reasoningLabel}`);
		void ev.action.setImage(REASONING_IMAGE);
		void ev.action.setTitle(this.title(codex.reasoningLabel));
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		ReasoningAction.instances.delete(ev.action as unknown as KeyRenderable);
		if (ReasoningAction.instances.size === 0 && this.listening) {
			codex.off("reasoning", this.onReasoning);
			this.listening = false;
		}
	}

	override onKeyDown(ev: KeyDownEvent): void {
		codex.cycleReasoning();
		void ev.action.setTitle("⟳ …");
		setTimeout(() => {
			for (const action of ReasoningAction.instances) {
				void action.setTitle(this.title(codex.reasoningLabel));
			}
		}, 2000);
	}

	private title(label: string): string {
		return label;
	}
}

/** Push-to-talk: sends Option+Space to the frontmost app (the user's external
 * PTT tool). Implemented in the plugin because Stream Deck's built-in hotkey
 * drops the Option modifier for the ⌥Space combination. */
@action({ UUID: "com.codexdeck.ptt" })
export class PttAction extends SingletonAction {
	override onWillAppear(ev: WillAppearEvent): void {
		void ev.action.setImage(PTT_IMAGE);
		void ev.action.setTitle("");
	}

	override onKeyDown(ev: KeyDownEvent): void {
		codex.pushToTalk();
	}
}
