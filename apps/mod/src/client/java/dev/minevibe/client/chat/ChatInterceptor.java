package dev.minevibe.client.chat;

import dev.minevibe.client.ui.UiActions;
import dev.minevibe.client.ui.UiState;
import dev.minevibe.client.ui.UiTransport;
import dev.minevibe.client.ui.mixin.ChatScreenAccessor;
import net.minecraft.ChatFormatting;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Chat interception (PLAN §6.5): with MineVibe running, the player's chat lines never reach the server as chat.
 * {@code ClientSendMessageEvents.ALLOW_CHAT} cancels every line and sends it to Node as {@code chat.send{to:"all"}}
 * instead; Node routes the leading {@code @mentions}, answers cards, and replies with the echo.
 *
 * <ul>
 *   <li><b>Echo.</b> Only the player's own line appears in the chat log, as Node read it ("You → Ada: Q1 = 2
 *       (Spruce)"). Agent replies stay in bubbles.</li>
 *   <li><b>Inline hints.</b> A line {@link MentionCheck} refuses (unknown or ambiguous name, invalid answer, ...) is not
 *       sent: the chat box stays open with the text and the hint under it ({@code ChatScreenMixin} keeps it open).
 *       A refusal from Node arrives a moment later and reopens the box with the text and Node's hint.</li>
 *   <li><b>Offline.</b> When Node is not connected nothing is sent, and the text stays in the box.</li>
 *   <li>{@code /} commands are untouched (dev worlds only).</li>
 * </ul>
 * Lines may be up to 2000 characters on this path ({@code ChatScreenMixin} raises the box and trim limits).
 */
public final class ChatInterceptor {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/Chat");

	private ChatInterceptor() {}

	public static final int MAX_LENGTH = MentionCheck.MAX_LENGTH;

	/** Set when this tick's submit was refused locally; the chat screen then stays open. */
	private static boolean keepOpen;

	/** MineVibe routes chat (the game runs with a bridge). */
	public static boolean active() {
		return UiTransport.current().configured();
	}

	/** {@code ALLOW_CHAT}: returns false (cancel) for every line while MineVibe routes chat. */
	public static boolean onAllowChat(String message) {
		if (!active()) return true;
		String text = message.trim();
		if (text.isEmpty()) return false;
		String hint = MentionCheck.check(text, UiState.get().agents());
		if (hint == null && !UiTransport.current().connected()) hint = "MineVibe is offline: nothing was sent";
		if (hint != null) {
			ChatHint.show(text, hint);
			keepOpen = true;
			return false;
		}
		ChatHint.clear();
		UiActions.chatLine(text).whenComplete((echo, err) -> {
			if (err == null) {
				echo(echo.isEmpty() ? "You: " + text : echo);
			} else {
				String why = UiActions.errorText(err);
				LOG.debug("chat.send refused: {}", why);
				reopen(text, why);
			}
		});
		return false;
	}

	/** True once after a locally refused submit (the chat box must stay open). */
	public static boolean consumeKeepOpen() {
		boolean keep = keepOpen;
		keepOpen = false;
		return keep;
	}

	/** Adds the player's echo line to the chat log. */
	public static void echo(String line) {
		Minecraft mc = Minecraft.getInstance();
		mc.gui.hud.getChat().addClientSystemMessage(Component.literal(line).withStyle(ChatFormatting.GRAY));
	}

	/** Node refused a line: put it back in the chat box with the hint (unless the player is busy elsewhere). */
	static void reopen(String text, String hint) {
		Minecraft mc = Minecraft.getInstance();
		Screen screen = mc.gui.screen();
		ChatHint.show(text, hint);
		if (mc.level == null) return;
		if (screen == null) {
			mc.gui.setScreen(new ChatScreen(text, false));
		} else if (screen instanceof ChatScreen chat && ((ChatScreenAccessor) chat).minevibe$input().getValue().isBlank()) {
			((ChatScreenAccessor) chat).minevibe$input().setValue(text);
		} else {
			// Another screen is open: do not steal focus, but keep the hint visible as a chat line.
			echo("Not sent: " + hint);
		}
	}
}
