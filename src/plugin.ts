import streamDeck from "@elgato/streamdeck";
import { codex } from "./codex/service";
import { AgentKeyAction } from "./actions/agent-key";
import { AcceptAction, NewChatAction, PttAction, ReasoningAction, RejectAction, SendAction } from "./actions/command-keys";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new AgentKeyAction());
streamDeck.actions.registerAction(new AcceptAction());
streamDeck.actions.registerAction(new RejectAction());
streamDeck.actions.registerAction(new SendAction());
streamDeck.actions.registerAction(new NewChatAction());
streamDeck.actions.registerAction(new ReasoningAction());
streamDeck.actions.registerAction(new PttAction());

streamDeck.connect().then(() => {
	void codex.start();
});
