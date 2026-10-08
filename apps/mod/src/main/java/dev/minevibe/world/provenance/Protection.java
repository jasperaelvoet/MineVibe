package dev.minevibe.world.provenance;

import dev.minevibe.agent.AgentPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.decoration.ArmorStand;
import net.minecraft.world.entity.decoration.BlockAttachedEntity;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.BrushItem;
import net.minecraft.world.item.BucketItem;
import net.minecraft.world.item.FireChargeItem;
import net.minecraft.world.item.FlintAndSteelItem;
import net.minecraft.world.item.HoneycombItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.ShearsItem;
import net.minecraft.world.item.SolidBucketItem;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.level.block.BeehiveBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.BrushableBlock;
import net.minecraft.world.level.block.CampfireBlock;
import net.minecraft.world.level.block.CandleBlock;
import net.minecraft.world.level.block.PumpkinBlock;
import net.minecraft.world.level.block.SignBlock;
import net.minecraft.world.level.block.TntBlock;
import net.minecraft.world.level.block.WeatheringCopper;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * What agents may change (W1). Agents never break, replace, till, strip, burn or flood a block that a player placed
 * ({@code player-built}) or that belongs to a protected zone such as the Base ({@code base}), never knock down item
 * frames, paintings or armor stands, and never take from a chest the player placed, unless the player agreed for that
 * very job ({@link Consents}). Blocks agents placed themselves are theirs to change; natural blocks are free.
 *
 * <p>Jobs ask {@link #check} before they touch a block and fail with {@code PROTECTED}; the agent skill layer also
 * refuses the vanilla actions themselves (block breaking, item use on blocks) as a backstop, whatever code asked.
 */
public final class Protection {
	private Protection() {
	}

	public enum What {
		PLAYER_BUILT("player-built"),
		BASE("base");

		public final String wire;

		What(final String wire) {
			this.wire = wire;
		}
	}

	/**
	 * A refusal: {@code what} kind of protected thing is at {@code pos}, whose it is ({@code owner}, a player name), the
	 * block (or entity type) id, and the zone it lies in.
	 */
	public record Verdict(BlockPos pos, What what, String owner, String block, @Nullable String zone) {
		/** The teaching line: "That's part of Steve's base — ask Steve before changing it." */
		public String hint() {
			String thing = this.what == What.BASE
				? "part of " + this.owner + "'s " + (this.zone == null || Zones.BASE.equals(this.zone) ? "base" : this.zone)
				: "part of " + this.owner + "'s build";
			return "That's " + thing + " — ask " + this.owner + " before changing it.";
		}

		/** {@code hint} plus what and where: "… (stripped_spruce_log at 3 64 5)". */
		public String message() {
			return this.hint() + " (" + this.block.replace("minecraft:", "") + " at " + this.pos.getX() + " " + this.pos.getY() + " " + this.pos.getZ() + ")";
		}
	}

	/**
	 * Why {@code agentId} (null: anyone, as perception sees it) may not change the block at {@code pos}, or null when it
	 * may: air, a natural block, a block an agent placed, or a block covered by the agent's active consent.
	 */
	public static @Nullable Verdict check(final ServerLevel level, final BlockPos pos, final @Nullable String agentId) {
		BlockState state = level.getBlockState(pos);
		if (state.isAir()) {
			return null;
		}
		Owner owner = Provenance.ownerAt(level, pos);
		if (owner != null && owner.isAgent()) {
			return null;
		}
		Zones.Zone zone = owner == null || owner.isBase() ? Zones.at(level, pos) : null;
		if (owner == null && zone == null) {
			return null;
		}
		if (agentId != null && Consents.covers(agentId, level.dimension(), pos)) {
			return null;
		}
		String block = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
		if (owner != null && owner.isPlayer()) {
			Zones.Zone in = Zones.at(level, pos);
			return new Verdict(pos.immutable(), What.PLAYER_BUILT, owner.name(), block, in == null ? null : in.name());
		}
		String zoneName = zone != null ? zone.name() : owner.id();
		String zoneOwner = zone != null && zone.owner() != null ? zone.owner() : playerName(level.getServer());
		return new Verdict(pos.immutable(), What.BASE, zoneOwner, block, zoneName);
	}

	/** True when the block at {@code pos} is player-built or in a protected zone (agents' blocks are not). */
	public static boolean isProtected(final ServerLevel level, final BlockPos pos) {
		return check(level, pos, null) != null;
	}

	/** Item frames, glow item frames, paintings, leash knots and armor stands: decoration agents leave alone. */
	public static boolean isDecoration(final Entity e) {
		return e instanceof BlockAttachedEntity || e instanceof ArmorStand;
	}

	/** Why an agent may not attack (break) the decoration {@code e}, or null for anything else. */
	public static @Nullable Verdict checkEntity(final ServerLevel level, final Entity e, final @Nullable String agentId) {
		if (!isDecoration(e)) {
			return null;
		}
		BlockPos pos = e.blockPosition();
		if (agentId != null && Consents.covers(agentId, level.dimension(), pos)) {
			return null;
		}
		Zones.Zone zone = Zones.at(level, pos);
		String owner = zone != null && zone.owner() != null ? zone.owner() : playerName(level.getServer());
		String type = BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString();
		return new Verdict(pos, zone != null ? What.BASE : What.PLAYER_BUILT, owner, type, zone == null ? null : zone.name());
	}

	/**
	 * Items whose use changes the block clicked or the one in front of it: hoes (till), axes (strip, scrape), shovels
	 * (paths), shears, honeycomb, brushes, flint and steel, fire charges, buckets.
	 */
	public static boolean changesBlocks(final ItemStack stack) {
		return stack.is(ItemTags.HOES) || stack.is(ItemTags.AXES) || stack.is(ItemTags.SHOVELS)
			|| stack.getItem() instanceof ShearsItem || stack.getItem() instanceof HoneycombItem || stack.getItem() instanceof BrushItem
			|| stack.getItem() instanceof FlintAndSteelItem || stack.getItem() instanceof FireChargeItem
			|| stack.getItem() instanceof BucketItem || stack.getItem() instanceof SolidBucketItem;
	}

	/**
	 * Why using {@code stack} on face {@code face} of {@code target} would change a protected block: the target itself
	 * for tools, the block in front of the face for fire and buckets, and a protected replaceable block (snow, a flower)
	 * a block item would replace. Null when the use changes nothing protected.
	 */
	public static @Nullable Verdict checkUse(
		final ServerLevel level, final BlockPos target, final Direction face, final ItemStack stack, final @Nullable String agentId
	) {
		if (changesBlocks(stack)) {
			BlockState state = level.getBlockState(target);
			if (transforms(stack, state)) {
				Verdict v = check(level, target, agentId);
				if (v != null) {
					return v;
				}
			}
			if (placesInFront(stack)) {
				BlockPos front = target.relative(face);
				if (!level.getBlockState(front).isAir()) {
					return check(level, front, agentId);
				}
			}
			return null;
		}
		if (stack.getItem() instanceof BlockItem) {
			BlockState here = level.getBlockState(target);
			BlockPos into = here.canBeReplaced() ? target : target.relative(face);
			BlockState there = level.getBlockState(into);
			if (!there.isAir() && there.canBeReplaced()) {
				return check(level, into, agentId);
			}
		}
		return null;
	}

	/**
	 * True when using {@code stack} on {@code state} changes that block (tilling dirt, stripping a log, flattening grass,
	 * carving a pumpkin, waxing copper, brushing suspicious sand, lighting a candle or TNT, scooping a fluid). Doors,
	 * levers and chests clicked with a tool in hand only open, so they do not count.
	 */
	static boolean transforms(final ItemStack stack, final BlockState state) {
		Block b = state.getBlock();
		if (stack.is(ItemTags.HOES)) {
			return state.is(Blocks.DIRT) || state.is(Blocks.GRASS_BLOCK) || state.is(Blocks.DIRT_PATH) || state.is(Blocks.COARSE_DIRT) || state.is(Blocks.ROOTED_DIRT);
		}
		if (stack.is(ItemTags.SHOVELS)) {
			return state.is(Blocks.DIRT) || state.is(Blocks.GRASS_BLOCK) || state.is(Blocks.PODZOL) || state.is(Blocks.MYCELIUM)
				|| state.is(Blocks.COARSE_DIRT) || state.is(Blocks.ROOTED_DIRT) || b instanceof CampfireBlock;
		}
		if (stack.is(ItemTags.AXES) || stack.getItem() instanceof HoneycombItem) {
			return state.is(BlockTags.LOGS) || state.is(Blocks.BAMBOO_BLOCK) || b instanceof WeatheringCopper || b instanceof SignBlock
				|| BuiltInRegistries.BLOCK.getKey(b).getPath().contains("copper");
		}
		if (stack.getItem() instanceof ShearsItem) {
			return b instanceof PumpkinBlock || b instanceof BeehiveBlock;
		}
		if (stack.getItem() instanceof BrushItem) {
			return b instanceof BrushableBlock;
		}
		if (stack.getItem() instanceof FlintAndSteelItem || stack.getItem() instanceof FireChargeItem) {
			return b instanceof CandleBlock || b instanceof CampfireBlock || b instanceof TntBlock;
		}
		return !state.getFluidState().isEmpty();
	}

	/** Fire and buckets put something into the cell in front of the clicked face. */
	static boolean placesInFront(final ItemStack stack) {
		return stack.getItem() instanceof FlintAndSteelItem || stack.getItem() instanceof FireChargeItem
			|| stack.getItem() instanceof BucketItem || stack.getItem() instanceof SolidBucketItem;
	}

	/** The name of the world's human player (the one online, else "the player"). */
	public static String playerName(final MinecraftServer server) {
		for (ServerPlayer p : server.getPlayerList().getPlayers()) {
			if (!(p instanceof AgentPlayer)) {
				return p.getGameProfile().name();
			}
		}
		return "the player";
	}
}
