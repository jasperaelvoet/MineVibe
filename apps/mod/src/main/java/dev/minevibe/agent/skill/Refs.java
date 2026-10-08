package dev.minevibe.agent.skill;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentService;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.protocol.Messages.Codes;
import java.util.Locale;
import java.util.UUID;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.TagKey;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import org.jspecify.annotations.Nullable;

/**
 * Resolves the protocol's references (protocol §7.1): {@code ItemId} ({@code oak_log}, {@code minecraft:oak_log},
 * {@code #minecraft:logs}), block ids and tags, and {@code EntityRef} ({@code player}, an agent id, an entity UUID, or
 * an entity type id meaning the nearest of that type). Unknown references throw {@code BAD_ARGS}.
 */
public final class Refs {
	private Refs() {
	}

	/** {@code minecraft:oak_log} for {@code oak_log}; null when it is not a valid identifier. */
	public static @Nullable Identifier id(final String ref) {
		String s = ref.startsWith("#") ? ref.substring(1) : ref;
		return Identifier.tryParse(s.toLowerCase(Locale.ROOT));
	}

	public static String itemId(final Item item) {
		return BuiltInRegistries.ITEM.getKey(item).toString();
	}

	public static String itemId(final ItemStack stack) {
		return itemId(stack.getItem());
	}

	public static String blockId(final Block block) {
		return BuiltInRegistries.BLOCK.getKey(block).toString();
	}

	public static String entityTypeId(final Entity entity) {
		return BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
	}

	/** An item or an item tag. */
	public record ItemMatcher(String ref, @Nullable Item item, @Nullable TagKey<Item> tag) implements Predicate<ItemStack> {
		@Override
		public boolean test(final ItemStack stack) {
			if (stack.isEmpty()) {
				return false;
			}
			return this.item != null ? stack.is(this.item) : stack.is(this.tag);
		}

		/** The block this reference places or names: the item's block, or a block tag of the same name. */
		public @Nullable BlockMatcher asBlock() {
			if (this.item != null) {
				if (this.item instanceof BlockItem blockItem) {
					return new BlockMatcher(this.ref, blockItem.getBlock(), null);
				}
				return null;
			}
			TagKey<Block> blockTag = TagKey.create(Registries.BLOCK, this.tag.location());
			return BuiltInRegistries.BLOCK.get(blockTag).isPresent() ? new BlockMatcher(this.ref, null, blockTag) : null;
		}
	}

	/** A block or a block tag. */
	public record BlockMatcher(String ref, @Nullable Block block, @Nullable TagKey<Block> tag) implements Predicate<BlockState> {
		@Override
		public boolean test(final BlockState state) {
			return this.block != null ? state.is(this.block) : state.is(this.tag);
		}
	}

	public static ItemMatcher item(final String ref) {
		Identifier id = id(ref);
		if (id == null) {
			throw badArgs("not an item id: " + ref);
		}
		if (ref.startsWith("#")) {
			TagKey<Item> tag = TagKey.create(Registries.ITEM, id);
			if (BuiltInRegistries.ITEM.get(tag).isEmpty()) {
				throw badArgs("unknown item tag: " + ref);
			}
			return new ItemMatcher(ref, null, tag);
		}
		if (!BuiltInRegistries.ITEM.containsKey(id)) {
			throw badArgs("unknown item: " + ref);
		}
		Item item = BuiltInRegistries.ITEM.getValue(id);
		if (item == Items.AIR) {
			throw badArgs("not an item: " + ref);
		}
		return new ItemMatcher(ref, item, null);
	}

	public static BlockMatcher block(final String ref) {
		Identifier id = id(ref);
		if (id == null) {
			throw badArgs("not a block id: " + ref);
		}
		if (ref.startsWith("#")) {
			TagKey<Block> tag = TagKey.create(Registries.BLOCK, id);
			if (BuiltInRegistries.BLOCK.get(tag).isEmpty()) {
				throw badArgs("unknown block tag: " + ref);
			}
			return new BlockMatcher(ref, null, tag);
		}
		if (!BuiltInRegistries.BLOCK.containsKey(id) || BuiltInRegistries.BLOCK.getValue(id) == Blocks.AIR) {
			throw badArgs("unknown block: " + ref);
		}
		return new BlockMatcher(ref, BuiltInRegistries.BLOCK.getValue(id), null);
	}

	public static @Nullable EntityType<?> entityType(final String ref) {
		Identifier id = id(ref);
		if (id == null || !BuiltInRegistries.ENTITY_TYPE.containsKey(id)) {
			return null;
		}
		return BuiltInRegistries.ENTITY_TYPE.getValue(id);
	}

	/** The human player an agent serves: its follow target, else the nearest non-agent player in its level. */
	public static @Nullable ServerPlayer player(final AgentPlayer agent) {
		ServerPlayer target = agent.brain().followTarget();
		if (target != null) {
			return target;
		}
		ServerPlayer best = null;
		double bestSq = Double.MAX_VALUE;
		for (ServerPlayer p : agent.level().players()) {
			if (p instanceof AgentPlayer || !p.isAlive() || p.isSpectator()) {
				continue;
			}
			double d = p.distanceToSqr(agent);
			if (d < bestSq) {
				bestSq = d;
				best = p;
			}
		}
		return best;
	}

	/**
	 * The entity an {@code EntityRef} names, as seen from {@code agent}, or null when it is not (or no longer) around.
	 * An entity type id picks the nearest living one within {@code radius} blocks.
	 */
	public static @Nullable Entity entity(final AgentPlayer agent, final String ref, final double radius) {
		ServerLevel level = agent.level();
		if ("player".equalsIgnoreCase(ref)) {
			return player(agent);
		}
		AgentPlayer other = AgentService.get(level.getServer()).agent(ref.toLowerCase(Locale.ROOT));
		if (other != null) {
			return other;
		}
		UUID uuid = parseUuid(ref);
		if (uuid != null) {
			Entity e = level.getEntity(uuid);
			return e != null && !e.isRemoved() ? e : null;
		}
		EntityType<?> type = entityType(ref);
		if (type == null) {
			throw badArgs("unknown entity: " + ref);
		}
		return nearestOfType(agent, type, radius, e -> true);
	}

	public static @Nullable Entity nearestOfType(final AgentPlayer agent, final EntityType<?> type, final double radius, final Predicate<Entity> filter) {
		Entity best = null;
		double bestSq = radius * radius;
		for (Entity e : agent.level().getEntities(agent, new AABB(agent.blockPosition()).inflate(radius), e -> e.getType() == type && e.isAlive())) {
			if (e instanceof LivingEntity living && living.isDeadOrDying() || !filter.test(e)) {
				continue;
			}
			double d = e.distanceToSqr(agent);
			if (d < bestSq) {
				bestSq = d;
				best = e;
			}
		}
		return best;
	}

	public static @Nullable UUID parseUuid(final String s) {
		if (s.length() != 36 || s.charAt(8) != '-') {
			return null;
		}
		try {
			return UUID.fromString(s);
		} catch (IllegalArgumentException e) {
			return null;
		}
	}

	public static BlockPos pos(final dev.minevibe.bridge.protocol.Messages.BlockPos p) {
		return new BlockPos(p.x(), p.y(), p.z());
	}

	public static dev.minevibe.bridge.protocol.Messages.BlockPos wire(final BlockPos p) {
		return new dev.minevibe.bridge.protocol.Messages.BlockPos(p.getX(), p.getY(), p.getZ());
	}

	public static BridgeException badArgs(final String msg) {
		return new BridgeException(Codes.BAD_ARGS, msg);
	}
}
