package dev.minevibe.agent.skill;

import dev.minevibe.agent.AgentEvents;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.world.provenance.Protection;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import net.fabricmc.fabric.api.event.player.PlayerBlockBreakEvents;
import net.fabricmc.fabric.api.event.player.UseBlockCallback;
import net.fabricmc.fabric.api.event.player.UseItemCallback;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import org.jspecify.annotations.Nullable;

/**
 * The backstop behind {@link Protection} (W1): whatever code drives an agent's hands (a job, a reflex, a future skill),
 * the vanilla actions themselves refuse to change protected blocks. Jobs check first and fail with {@code PROTECTED};
 * this only catches what slipped past them, and remembers the refusal ({@link #lastRefusal}) so the job can report it.
 *
 * <ul>
 *   <li>Breaking a block ({@code PlayerBlockBreakEvents.BEFORE}, from {@code ServerPlayerGameMode#destroyBlock}).</li>
 *   <li>Using an item on a block ({@code UseBlockCallback}, from {@code ServerPlayerGameMode#useItemOn}): tools that
 *       change the block, fire and lava near a protected block, buckets in front of it, block items replacing a
 *       protected plant or snow layer, and right-clicks that take from or retune a protected block (flower pot,
 *       lectern, repeater...).</li>
 *   <li>Using an item in the air ({@code UseItemCallback}): buckets and fire charges aimed at a protected block.</li>
 * </ul>
 * Attacks on decoration (item frames, paintings, armor stands) are refused in {@code AgentControls#attack}'s callers
 * (the attack job), since agents attack entities directly rather than through the network handler.
 */
public final class ProtectionGuard {
	private static final Map<String, Protection.Verdict> LAST = new ConcurrentHashMap<>();

	private ProtectionGuard() {
	}

	public static void register() {
		PlayerBlockBreakEvents.BEFORE.register((level, player, pos, state, blockEntity) -> {
			if (player instanceof AgentPlayer agent && level instanceof ServerLevel serverLevel) {
				Protection.Verdict v = Protection.check(serverLevel, pos, agent.agentId());
				if (v != null) {
					refused(agent, v, "break");
					return false;
				}
			}
			return true;
		});
		UseBlockCallback.EVENT.register((player, level, hand, hit) -> {
			if (player instanceof AgentPlayer agent && level instanceof ServerLevel serverLevel) {
				Protection.Verdict v = Protection.checkUse(serverLevel, hit.getBlockPos(), hit.getDirection(), player.getItemInHand(hand), agent.agentId());
				if (v == null) {
					// Taking the flower from the player's pot, the book from their lectern, retuning their repeaters.
					v = Protection.checkInteract(serverLevel, hit.getBlockPos(), agent.agentId());
				}
				if (v != null) {
					refused(agent, v, "use");
					return InteractionResult.FAIL;
				}
			}
			return InteractionResult.PASS;
		});
		UseItemCallback.EVENT.register((player, level, hand) -> {
			if (player instanceof AgentPlayer agent && level instanceof ServerLevel serverLevel) {
				ItemStack stack = player.getItemInHand(hand);
				if (Protection.changesBlocks(stack)) {
					HitResult hit = player.pick(player.blockInteractionRange(), 1.0F, true);
					if (hit instanceof BlockHitResult b && hit.getType() == HitResult.Type.BLOCK) {
						Protection.Verdict v = Protection.checkUse(serverLevel, b.getBlockPos(), b.getDirection(), stack, agent.agentId());
						if (v != null) {
							refused(agent, v, "use");
							return InteractionResult.FAIL;
						}
					}
				}
			}
			return InteractionResult.PASS;
		});
	}

	private static void refused(final AgentPlayer agent, final Protection.Verdict v, final String action) {
		LAST.put(agent.agentId(), v);
		AgentEvents.emit(agent, "protected", Map.of(
			"action", action,
			"what", v.what().wire,
			"owner", v.owner(),
			"block", v.block(),
			"pos", v.pos().toShortString()));
	}

	/** The last refusal for {@code agentId}, taken (null when there was none since the last call). */
	public static Protection.@Nullable Verdict takeRefusal(final String agentId) {
		return LAST.remove(agentId);
	}

	/** The last refusal for {@code agentId}, kept. */
	public static Protection.@Nullable Verdict lastRefusal(final String agentId) {
		return LAST.get(agentId);
	}

	public static void clear() {
		LAST.clear();
	}
}
