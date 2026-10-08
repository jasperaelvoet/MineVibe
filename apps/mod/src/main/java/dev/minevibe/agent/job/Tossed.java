package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentPlayer;
import java.util.Collections;
import java.util.Map;
import java.util.UUID;
import java.util.WeakHashMap;
import net.minecraft.util.Prediction;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.ItemStack;
import org.jspecify.annotations.Nullable;

/**
 * Items an agent throws to someone (give, feeding the player, sharing food). The item entity is marked so only the
 * receiver can pick it up ({@code ItemEntity#setTarget}); vanilla has no getter for that mark, so the receivers are
 * remembered here, and pickup logic leaves other people's items alone.
 */
public final class Tossed {
	private static final Map<ItemEntity, UUID> TARGETS = Collections.synchronizedMap(new WeakHashMap<>());

	private Tossed() {
	}

	/** Throws {@code stack} from the agent's hand toward {@code to} (looking at it first); only {@code to} may pick it up. */
	public static @Nullable ItemEntity toss(final AgentPlayer from, final ItemStack stack, final @Nullable Entity to) {
		if (to != null) {
			// A level throw from about two blocks away lands at the receiver's feet.
			from.controls().lookAt(new net.minecraft.world.phys.Vec3(to.getX(), from.getEyeY(), to.getZ()));
		}
		ItemEntity item = from.drop(stack, true, Prediction.SERVER_ONLY);
		if (item != null) {
			item.setPickUpDelay(10);
			if (to != null) {
				item.setTarget(to.getUUID());
				TARGETS.put(item, to.getUUID());
			}
		}
		return item;
	}

	public static @Nullable UUID target(final ItemEntity item) {
		return TARGETS.get(item);
	}

	/** False for an item thrown to somebody else. */
	public static boolean pickableBy(final ItemEntity item, final Entity who) {
		UUID t = TARGETS.get(item);
		return t == null || t.equals(who.getUUID());
	}
}
