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
import net.minecraft.world.item.Items;
import net.minecraft.world.item.ShearsItem;
import net.minecraft.world.item.SolidBucketItem;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.entity.OwnableEntity;
import net.minecraft.world.level.block.AbstractCandleBlock;
import net.minecraft.world.level.block.BannerBlock;
import net.minecraft.world.level.block.BaseRailBlock;
import net.minecraft.world.level.block.BasePressurePlateBlock;
import net.minecraft.world.level.block.BaseTorchBlock;
import net.minecraft.world.level.block.BeehiveBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.BrushableBlock;
import net.minecraft.world.level.block.CakeBlock;
import net.minecraft.world.level.block.CampfireBlock;
import net.minecraft.world.level.block.CandleBlock;
import net.minecraft.world.level.block.CarpetBlock;
import net.minecraft.world.level.block.CeilingHangingSignBlock;
import net.minecraft.world.level.block.ChestBlock;
import net.minecraft.world.level.block.ChiseledBookShelfBlock;
import net.minecraft.world.level.block.ComparatorBlock;
import net.minecraft.world.level.block.DaylightDetectorBlock;
import net.minecraft.world.level.block.DecoratedPotBlock;
import net.minecraft.world.level.block.DiodeBlock;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.FaceAttachedHorizontalDirectionalBlock;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.FlowerPotBlock;
import net.minecraft.world.level.block.JukeboxBlock;
import net.minecraft.world.level.block.LadderBlock;
import net.minecraft.world.level.block.LanternBlock;
import net.minecraft.world.level.block.LecternBlock;
import net.minecraft.world.level.block.NoteBlock;
import net.minecraft.world.level.block.PumpkinBlock;
import net.minecraft.world.level.block.RedstoneWallTorchBlock;
import net.minecraft.world.level.block.RedstoneWireBlock;
import net.minecraft.world.level.block.RespawnAnchorBlock;
import net.minecraft.world.level.block.ShelfBlock;
import net.minecraft.world.level.block.SignBlock;
import net.minecraft.world.level.block.SnowLayerBlock;
import net.minecraft.world.level.block.StandingSignBlock;
import net.minecraft.world.level.block.TntBlock;
import net.minecraft.world.level.block.TripWireHookBlock;
import net.minecraft.world.level.block.VegetationBlock;
import net.minecraft.world.level.block.WallBannerBlock;
import net.minecraft.world.level.block.WallSignBlock;
import net.minecraft.world.level.block.WallTorchBlock;
import net.minecraft.world.level.block.WeatheringCopper;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.AttachFace;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.ChestType;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import java.util.ArrayList;
import java.util.List;
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
	 * block (or entity type) id, and the zone it lies in. {@code lead}, when set, says why changing something else
	 * touches it, with {@code %s} for "part of Steve's build": a natural block that holds it up ("That holds up %s
	 * (ladder at 3 64 5)") or lies under its roof, fire, lava or TNT that would reach it, a blueprint built inside a
	 * zone.
	 */
	public record Verdict(BlockPos pos, What what, String owner, String block, @Nullable String zone, @Nullable String lead) {
		public Verdict(final BlockPos pos, final What what, final String owner, final String block, final @Nullable String zone) {
			this(pos, what, owner, block, zone, null);
		}

		/** The teaching line: "That's part of Steve's base — ask Steve before changing it." */
		public String hint() {
			String thing = this.what == What.BASE
				? "part of " + this.owner + "'s " + (this.zone == null || Zones.BASE.equals(this.zone) ? "base" : this.zone)
				: "part of " + this.owner + "'s build";
			String head = this.lead == null ? "That's " + thing : this.lead.replace("%s", thing);
			return head + " — ask " + this.owner + " before changing it.";
		}

		/** {@code hint} plus what and where: "… (stripped_spruce_log at 3 64 5)". */
		public String message() {
			return this.hint() + " (" + this.block.replace("minecraft:", "") + " at " + this.pos.getX() + " " + this.pos.getY() + " " + this.pos.getZ() + ")";
		}

		Verdict withLead(final String newLead) {
			return new Verdict(this.pos, this.what, this.owner, this.block, this.zone, newLead);
		}
	}

	/**
	 * Why {@code agentId} (null: anyone, as perception sees it) may not change the block at {@code pos}, or null when it
	 * may: air, a natural block, a block an agent placed, or a block covered by the agent's active consent. A natural
	 * block that holds up a protected one (the stone behind the player's ladder, the dirt under their torch, door, sand
	 * or wall) or that is the floor under their roof is protected too: breaking it would break or open up theirs.
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
		Verdict support = null;
		if (owner == null && zone == null) {
			support = holdsUp(level, pos, state);
			if (support == null) {
				support = underRoof(level, pos, state);
			}
			if (support == null) {
				return null;
			}
		}
		if (agentId != null && Consents.covers(agentId, level.dimension(), pos)) {
			return null;
		}
		if (support != null) {
			return support;
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

	/**
	 * The natural block {@code pos} ({@code state}) seen as the support of a protected neighbour (player-built, or the
	 * Base's): a verdict naming that neighbour, or null when no protected block depends on it.
	 */
	private static @Nullable Verdict holdsUp(final ServerLevel level, final BlockPos pos, final BlockState state) {
		for (Direction d : Direction.values()) {
			BlockPos n = pos.relative(d);
			BlockState ns = level.getBlockState(n);
			if (ns.isAir() || !dependsOn(ns, d)) {
				continue;
			}
			Owner o = Provenance.ownerAt(level, n);
			if (o != null && o.isAgent()) {
				continue;
			}
			Zones.Zone z = o == null || o.isBase() ? Zones.at(level, n) : null;
			if (o == null && z == null) {
				continue;
			}
			String block = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
			String lead = "That holds up %s (" + BuiltInRegistries.BLOCK.getKey(ns.getBlock()).getPath() + " at " + n.getX() + " " + n.getY() + " " + n.getZ() + ")";
			if (o != null && o.isPlayer()) {
				return new Verdict(pos.immutable(), What.PLAYER_BUILT, o.name(), block, null, lead);
			}
			String zoneOwner = z != null && z.owner() != null ? z.owner() : playerName(level.getServer());
			return new Verdict(pos.immutable(), What.BASE, zoneOwner, block, z != null ? z.name() : o.id(), lead);
		}
		return null;
	}

	/** How far up {@link #underRoof} looks for a player's roof. */
	static final int ROOF_SCAN = 6;

	/**
	 * The natural block {@code pos} as the ground of a player's building: the first solid block above it, at most
	 * {@value #ROOF_SCAN} up with only air, carpets, torches and the like in between, is player-built or the Base's.
	 * Right on top, that is the foundation under their wall or road; higher up, the floor of their house (or the ground
	 * under their porch or bridge). Theirs to keep, not a dirt mine. Null otherwise.
	 */
	private static @Nullable Verdict underRoof(final ServerLevel level, final BlockPos pos, final BlockState state) {
		BlockPos.MutableBlockPos q = pos.mutable();
		for (int dy = 1; dy <= ROOF_SCAN; dy++) {
			q.move(Direction.UP);
			BlockState qs = level.getBlockState(q);
			if (qs.isAir() || qs.getCollisionShape(level, q).isEmpty()) {
				continue;
			}
			Owner o = Provenance.ownerAt(level, q);
			if (o == null || o.isAgent()) {
				return null;
			}
			String block = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
			String what = BuiltInRegistries.BLOCK.getKey(qs.getBlock()).getPath() + " at " + q.getX() + " " + q.getY() + " " + q.getZ();
			String lead = dy == 1 ? "That holds up %s (" + what + ")" : "That's inside %s, under its roof (" + what + ")";
			if (o.isPlayer()) {
				return new Verdict(pos.immutable(), What.PLAYER_BUILT, o.name(), block, null, lead);
			}
			Zones.Zone z = Zones.at(level, q);
			String zoneOwner = z != null && z.owner() != null ? z.owner() : playerName(level.getServer());
			return new Verdict(pos.immutable(), What.BASE, zoneOwner, block, z != null ? z.name() : o.id(), lead);
		}
		return null;
	}

	/**
	 * True when {@code dependent}, the neighbour of a block in direction {@code supportToDependent}, needs that block to
	 * stay where it is: sand, gravel and anvils on top of it; torches, doors, rails, carpets, pressure plates, signs,
	 * banners, redstone, candles, cakes, snow layers, flowers and floor buttons standing on it; wall torches, ladders,
	 * wall signs and banners, tripwire hooks and wall buttons fixed to its side; lanterns, hanging signs and ceiling
	 * buttons hanging under it.
	 */
	static boolean dependsOn(final BlockState dependent, final Direction supportToDependent) {
		Block b = dependent.getBlock();
		if (supportToDependent == Direction.UP) {
			if (b instanceof FaceAttachedHorizontalDirectionalBlock) {
				return dependent.getValue(FaceAttachedHorizontalDirectionalBlock.FACE) == AttachFace.FLOOR;
			}
			if (b instanceof LanternBlock) {
				return !dependent.getValue(LanternBlock.HANGING);
			}
			if (b instanceof BaseTorchBlock) {
				return !(b instanceof WallTorchBlock || b instanceof RedstoneWallTorchBlock);
			}
			return b instanceof FallingBlock || b instanceof DoorBlock || b instanceof BaseRailBlock || b instanceof CarpetBlock
				|| b instanceof BasePressurePlateBlock || b instanceof StandingSignBlock || b instanceof BannerBlock || b instanceof DiodeBlock
				|| b instanceof RedstoneWireBlock || b instanceof AbstractCandleBlock || b instanceof CakeBlock || b instanceof SnowLayerBlock
				|| b instanceof VegetationBlock;
		}
		if (supportToDependent == Direction.DOWN) {
			if (b instanceof FaceAttachedHorizontalDirectionalBlock) {
				return dependent.getValue(FaceAttachedHorizontalDirectionalBlock.FACE) == AttachFace.CEILING;
			}
			if (b instanceof LanternBlock) {
				return dependent.getValue(LanternBlock.HANGING);
			}
			return b instanceof CeilingHangingSignBlock;
		}
		// Fixed to a wall: these face away from the block they hang on.
		if (b instanceof FaceAttachedHorizontalDirectionalBlock) {
			return dependent.getValue(FaceAttachedHorizontalDirectionalBlock.FACE) == AttachFace.WALL
				&& dependent.getValue(BlockStateProperties.HORIZONTAL_FACING) == supportToDependent;
		}
		if (b instanceof WallTorchBlock || b instanceof RedstoneWallTorchBlock || b instanceof LadderBlock || b instanceof WallSignBlock
			|| b instanceof WallBannerBlock || b instanceof TripWireHookBlock) {
			return dependent.getValue(BlockStateProperties.HORIZONTAL_FACING) == supportToDependent;
		}
		return false;
	}

	/**
	 * Why {@code agentId} may not build into the cell {@code pos} (air or not) because it lies in a protected zone such as
	 * the Base, or null outside zones (or with the agent's consent for it). Blueprints use it: a shelter or wall built
	 * inside the Base fills the player's rooms and doorways.
	 */
	public static @Nullable Verdict checkZoneCell(final ServerLevel level, final BlockPos pos, final @Nullable String agentId) {
		Zones.Zone zone = Zones.at(level, pos);
		if (zone == null || agentId != null && Consents.covers(agentId, level.dimension(), pos)) {
			return null;
		}
		String owner = zone.owner() != null ? zone.owner() : playerName(level.getServer());
		String block = BuiltInRegistries.BLOCK.getKey(level.getBlockState(pos).getBlock()).toString();
		return new Verdict(pos.immutable(), What.BASE, owner, block, zone.name(), "Building there changes %s");
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
	 * Tamed animals (any owner), animals with a name tag, and golems a player built: the player's pets, named livestock
	 * and guards. Agents never hunt or attack them.
	 */
	public static boolean isPetOrNamed(final Entity e) {
		return e instanceof OwnableEntity o && o.getOwnerReference() != null || e.hasCustomName()
			|| e instanceof net.minecraft.world.entity.animal.golem.IronGolem g && g.isPlayerCreated()
			|| e instanceof net.minecraft.world.entity.animal.golem.SnowGolem;
	}

	/**
	 * Why right-clicking the block at {@code pos} (with any item, or none) would take from or reconfigure a protected
	 * block: a flower pot, lectern, chiseled bookshelf, shelf, jukebox, decorated pot, cake, repeater, comparator,
	 * daylight detector, note block or respawn anchor of the player's. Null for everything else (doors, levers, chests
	 * and workstations are used as usual).
	 */
	public static @Nullable Verdict checkInteract(final ServerLevel level, final BlockPos pos, final @Nullable String agentId) {
		Block b = level.getBlockState(pos).getBlock();
		boolean takesOrTunes = b instanceof FlowerPotBlock || b instanceof LecternBlock || b instanceof ChiseledBookShelfBlock || b instanceof ShelfBlock
			|| b instanceof JukeboxBlock || b instanceof DecoratedPotBlock || b instanceof CakeBlock || b instanceof AbstractCandleBlock
			|| b instanceof DiodeBlock || b instanceof DaylightDetectorBlock || b instanceof NoteBlock || b instanceof RespawnAnchorBlock;
		return takesOrTunes ? check(level, pos, agentId) : null;
	}

	/**
	 * Why taking from the container at {@code pos} is refused: a chest (barrel, shulker box...) the player placed, or
	 * the other half of a double chest the player placed. The Base's own chests are the crew's supply and stay open.
	 */
	public static @Nullable Verdict checkContainer(final ServerLevel level, final BlockPos pos, final @Nullable String agentId) {
		Verdict v = check(level, pos, agentId);
		if (v != null && v.what() == What.PLAYER_BUILT) {
			return v;
		}
		BlockState state = level.getBlockState(pos);
		if (state.getBlock() instanceof ChestBlock && state.getValue(ChestBlock.TYPE) != ChestType.SINGLE) {
			BlockPos other = pos.relative(ChestBlock.getConnectedDirection(state));
			Verdict w = check(level, other, agentId);
			if (w != null && w.what() == What.PLAYER_BUILT) {
				return w;
			}
		}
		return null;
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
		if (startsFire(stack)) {
			// Fire and lava spread: refuse them anywhere near the player's builds (TNT lit next to a house included).
			Verdict near = protectedNear(level, target.relative(face), FIRE_RADIUS, agentId);
			if (near != null) {
				return near.withLead("Fire or lava there could reach %s");
			}
		}
		if (stack.is(Items.TNT)) {
			BlockPos into = level.getBlockState(target).canBeReplaced() ? target : target.relative(face);
			Verdict near = checkPlacement(level, into, stack, agentId);
			if (near != null) {
				return near;
			}
		}
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

	/**
	 * Why placing {@code stack} at {@code into} is refused although the cell itself is free: TNT within
	 * {@value #FIRE_RADIUS} blocks of a protected block (a redstone torch next to it is enough to set it off). Null
	 * otherwise.
	 */
	public static @Nullable Verdict checkPlacement(final ServerLevel level, final BlockPos into, final ItemStack stack, final @Nullable String agentId) {
		if (!stack.is(Items.TNT)) {
			return null;
		}
		Verdict near = protectedNear(level, into, FIRE_RADIUS, agentId);
		return near == null ? null : near.withLead("An explosion there could reach %s");
	}

	/** How far from a protected block an agent may not light fire, pour lava or place TNT. */
	public static final int FIRE_RADIUS = 5;

	/** Flint and steel, fire charges and lava buckets: what sets things alight. */
	public static boolean startsFire(final ItemStack stack) {
		return stack.getItem() instanceof FlintAndSteelItem || stack.getItem() instanceof FireChargeItem || stack.is(Items.LAVA_BUCKET);
	}

	/**
	 * The nearest block within {@code radius} (a cube) of {@code center} that {@code agentId} may not change, or null.
	 * Reads each block once; only placed blocks and blocks in a zone get a full {@link #check}.
	 */
	public static @Nullable Verdict protectedNear(final ServerLevel level, final BlockPos center, final int radius, final @Nullable String agentId) {
		BoundingBox cube = new BoundingBox(center).inflatedBy(radius);
		List<Zones.Zone> zones = new ArrayList<>();
		for (Zones.Zone z : Zones.all(level.getServer())) {
			if (z.dim() == level.dimension() && z.box().intersects(cube)) {
				zones.add(z);
			}
		}
		Verdict best = null;
		long bestD = Long.MAX_VALUE;
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		for (int x = cube.minX(); x <= cube.maxX(); x++) {
			for (int y = cube.minY(); y <= cube.maxY(); y++) {
				for (int z = cube.minZ(); z <= cube.maxZ(); z++) {
					p.set(x, y, z);
					long d = (long)(x - center.getX()) * (x - center.getX()) + (long)(y - center.getY()) * (y - center.getY())
						+ (long)(z - center.getZ()) * (z - center.getZ());
					if (d >= bestD || level.getBlockState(p).isAir()) {
						continue;
					}
					Owner o = Provenance.ownerAt(level, p);
					boolean candidate = o != null ? !o.isAgent() : zones.stream().anyMatch(zone -> zone.box().isInside(p));
					if (!candidate) {
						continue;
					}
					Verdict v = check(level, p, agentId);
					if (v != null) {
						best = v;
						bestD = d;
					}
				}
			}
		}
		return best;
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
