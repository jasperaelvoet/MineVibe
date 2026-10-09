package dev.minevibe.progression;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.bridge.protocol.Messages;
import java.util.LinkedHashMap;
import java.util.Map;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Prediction;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import org.jspecify.annotations.Nullable;

/**
 * {@code hire.pay} (PLAN 7.5 "Agent Core"): approving a hire costs the player one Agent Core. Node asks before the hire
 * arrives, whichever way the player approved (the card, G, chat); the core comes out of the local player's inventory
 * (the selected slot first), or the request fails with {@code NO_CORE} and Node keeps the card up. A {@code refund}
 * gives it back when the hire could not arrive. Creative players pay nothing. Server thread.
 *
 * <p>Both directions are idempotent per {@code pendingId}: a ledger (this server session) remembers which hires were
 * paid and whether a core was really taken. Paying again for the same card takes nothing more (a retried or repeated
 * approval), and a refund gives back only a core that was taken for that card, once (Node also sends one after a
 * {@code hire.pay} that timed out, when it cannot know whether the core was taken; a creative approval took none).
 */
public final class CorePayment {
	public static final String NO_CORE = "NO_CORE";

	/** The ledger's size bound: one hire waits at a time, so a handful of entries is plenty. */
	private static final int LEDGER_MAX = 64;

	/** pendingId to whether a core was taken for it (false: creative), oldest first. Server thread. */
	private static final Map<String, Boolean> PAID = new LinkedHashMap<>(16, 0.75F, false) {
		@Override
		protected boolean removeEldestEntry(final Map.Entry<String, Boolean> eldest) {
			return size() > LEDGER_MAX;
		}
	};

	private CorePayment() {
	}

	/** Handles one {@code hire.pay} on {@code server}: {@code ok {}}, or a {@link BridgeException}. */
	public static Map<String, ?> pay(final @Nullable MinecraftServer server, final Ui.HirePay req) throws BridgeException {
		ServerPlayer player = server != null ? localPlayer(server) : null;
		if (player == null) {
			if (req.refund() && !Boolean.TRUE.equals(PAID.get(req.pendingId()))) {
				// Nothing was taken for this card: nothing to give back, and nobody needs to be here for that.
				PAID.remove(req.pendingId());
				return Map.of();
			}
			throw new BridgeException(Messages.Codes.NOT_READY, "Nobody is in the world to pay for the hire.");
		}
		return pay(player, req);
	}

	/** Handles one {@code hire.pay} for {@code player} (GameTests call it directly). */
	public static Map<String, ?> pay(final ServerPlayer player, final Ui.HirePay req) throws BridgeException {
		if (req.refund()) {
			Boolean took = PAID.remove(req.pendingId());
			if (!Boolean.TRUE.equals(took)) {
				// Never paid (the take failed or never arrived), paid in creative, or refunded already.
				return Map.of();
			}
			ItemStack core = new ItemStack(ProgressionContent.AGENT_CORE);
			if (!player.getInventory().add(core)) {
				player.drop(core, false, Prediction.SERVER_ONLY);
			}
			player.sendSystemMessage(Component.translatable("message.minevibe.hire.refund", req.name()).withStyle(ChatFormatting.YELLOW));
			return Map.of();
		}
		if (PAID.containsKey(req.pendingId())) {
			// This card is paid for already (the same approval asked again): never twice.
			return Map.of();
		}
		boolean creative = player.hasInfiniteMaterials();
		if (!creative && !takeOne(player.getInventory())) {
			throw new BridgeException(NO_CORE, "Hiring " + req.name() + " costs 1 Agent Core, and you carry none.");
		}
		PAID.put(req.pendingId(), !creative);
		ProgressionContent.APPROVED_HIRE.trigger(player);
		player.sendOverlayMessage(Component.translatable("message.minevibe.hire.paid", req.name()));
		return Map.of();
	}

	/** Forgets the ledger (the server stopped). */
	public static void reset() {
		PAID.clear();
	}

	/** The human player of the integrated server (agents are server players too), or null. */
	static @Nullable ServerPlayer localPlayer(final MinecraftServer server) {
		for (ServerPlayer p : server.getPlayerList().getPlayers()) {
			if (!(p instanceof AgentPlayer)) {
				return p;
			}
		}
		return null;
	}

	/** Removes one Agent Core from {@code inventory}, the selected slot first; false when there is none. */
	public static boolean takeOne(final Inventory inventory) {
		int selected = inventory.getSelectedSlot();
		if (inventory.getItem(selected).is(ProgressionContent.AGENT_CORE)) {
			inventory.removeItem(selected, 1);
			return true;
		}
		for (int i = 0; i < inventory.getContainerSize(); i++) {
			if (inventory.getItem(i).is(ProgressionContent.AGENT_CORE)) {
				inventory.removeItem(i, 1);
				return true;
			}
		}
		return false;
	}
}
