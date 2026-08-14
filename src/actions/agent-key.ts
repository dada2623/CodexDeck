import { action, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { codex, type KeyRenderable } from "../codex/service";
import streamDeck from "@elgato/streamdeck";

type AgentKeySettings = {
	slot?: number;
	/** Display-only test mode: forces a fixed status for showcase purposes. */
	demo?: boolean;
};

/**
 * One of the 5 agent keys. Shows live thread status via the key image/title and
 * selects that thread as the context for the command keys when pressed.
 */
@action({ UUID: "com.codexdeck.agent" })
export class AgentKeyAction extends SingletonAction<AgentKeySettings> {
	override onWillAppear(ev: WillAppearEvent<AgentKeySettings>): void {
		codex.attach(this.slotOf(ev.payload.settings.slot), ev.action, ev.payload.settings.demo === true);
	}

	override onWillDisappear(ev: WillDisappearEvent<AgentKeySettings>): void {
		codex.detach(ev.action as unknown as KeyRenderable);
	}

	override onKeyDown(ev: KeyDownEvent<AgentKeySettings>): void {
		const slot = this.slotOf(ev.payload.settings.slot);
		if (ev.payload.settings.demo === true) {
			// Display-only showcase key: fully inert, must not touch real
			// thread state (no selection, no unread clearing, no jump).
			return;
		}
		codex.select(slot);
		const thread = codex.threads[slot];
		if (thread?.id) {
			void codex.jumpToThread(thread.id).then((ok) => {
				streamDeck.logger.info(`Session ${slot + 1} 跳转${ok ? "成功" : "失败"}: ${thread.id}`);
			});
		}
	}

	private slotOf(value: number | undefined): number {
		return Math.min(codex.slotCount - 1, Math.max(0, value ?? 0));
	}
}
