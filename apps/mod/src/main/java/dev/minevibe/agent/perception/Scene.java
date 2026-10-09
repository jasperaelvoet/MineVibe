package dev.minevibe.agent.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentService;
import dev.minevibe.agent.job.BlockScan;
import dev.minevibe.agent.job.SkillJob;
import dev.minevibe.agent.skill.Refs;
import dev.minevibe.agent.skill.StatusFooter;
import dev.minevibe.agent.skill.WorldClock;
import dev.minevibe.world.provenance.ChunkMarks;
import dev.minevibe.world.provenance.Owner;
import dev.minevibe.world.provenance.Protection;
import dev.minevibe.world.provenance.Provenance;
import dev.minevibe.world.provenance.Zones;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.SectionPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.FluidTags;
import net.minecraft.tags.TagKey;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.animal.Animal;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CropBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * {@code obs.query look_around} (W1): a compact scene the agent can act on, instead of raw block hits. Lines, most
 * important first: where the agent is (and whether that is inside the Base), hazards, natural trees by species with
 * trunk position, distance, compass direction and whether the agent can walk there, what players and agents built
 * nearby, who is around (players with whether they stand in a protected zone and under a roof), water, ores and crops,
 * and the lie of the land. {@code brief} stays under
 * {@value #BRIEF_CHARS} characters, {@code full} under {@value #FULL_CHARS}; lower lines are dropped first.
 *
 * <p>The result also carries {@code zone} and {@code trees} as data, for programs.
 */
public final class Scene {
	public static final int BRIEF_CHARS = 900;
	public static final int FULL_CHARS = 2500;

	private Scene() {
	}

	private record Line(String text) {
	}

	/** The look_around result. {@code radius} 1-32 (entities and blocks), trees and buildings are looked for a bit farther. */
	public static JsonObject lookAround(final AgentPlayer agent, final int radius, final boolean full) {
		ServerLevel level = agent.level();
		BlockPos here = agent.blockPosition();
		int far = Math.max(radius, full ? 40 : 32);
		List<Line> lines = new ArrayList<>();
		JsonObject out = new JsonObject();

		lines.add(new Line(here(agent, full)));

		Zones.Zone zone = Zones.nearest(level, here);
		String player = Protection.playerName(level.getServer());
		if (zone != null) {
			String owner = zone.owner() != null ? zone.owner() : player;
			boolean inside = zone.contains(level.dimension(), here);
			int dist = (int)Math.round(zone.horizontalDistance(here));
			JsonObject z = new JsonObject();
			z.addProperty("name", zone.name());
			z.addProperty("inside", inside);
			z.addProperty("distance", inside ? 0 : dist);
			z.addProperty("owner", owner);
			out.add("zone", z);
			String label = Zones.BASE.equals(zone.name()) ? owner + "'s base" : zone.name() + ", " + owner + "'s";
			if (inside) {
				lines.add(new Line("Inside " + zone.name() + " (" + label + ", " + zone.describeBox() + "): never break or change its blocks."));
			} else if (dist <= 96 || full) {
				lines.add(new Line(zone.name() + " (" + label + ") " + dist + "m " + Compass.dir(here, zone.center()) + ": its blocks are protected."));
			}
		}

		String hazards = hazards(agent, radius, full);
		lines.add(new Line(hazards));

		List<Trees.Tree> trees = nearbyTrees(level, here, far, full ? 6 : 4);
		JsonArray treeFacts = new JsonArray();
		StringBuilder t = new StringBuilder();
		int checks = 0;
		for (Trees.Tree tree : trees) {
			Reach.Result r = checks++ < (full ? 5 : 3) ? Reach.walkTo(agent, tree.base()) : Reach.Result.UNKNOWN;
			JsonObject f = new JsonObject();
			f.addProperty("species", tree.species());
			f.add("trunk", SkillJob.pos(tree.base()));
			f.addProperty("distance", Compass.distance(here, tree.base()));
			f.addProperty("dir", Compass.dir(here, tree.base()));
			f.addProperty("reachable", r.word());
			f.addProperty("logs", tree.logs().size());
			treeFacts.add(f);
			t.append(t.isEmpty() ? "" : "; ").append(tree.species()).append(' ').append(Compass.where(here, tree.base()))
				.append(" at ").append(Compass.xyz(tree.base())).append(", ").append(r.word());
			if (full) {
				t.append(", ").append(tree.logs().size()).append(" logs");
			}
		}
		out.add("trees", treeFacts);
		lines.add(new Line(trees.isEmpty()
			? "Trees: no natural tree within " + far + "m (logs in buildings are not trees)."
			: "Trees (natural): " + t + "."));

		String built = built(agent, far, zone, full);
		if (!built.isEmpty()) {
			lines.add(new Line(built));
		}
		String people = people(agent, full);
		if (!people.isEmpty()) {
			lines.add(new Line(people));
		}
		String resources = resources(agent, radius, full);
		if (!resources.isEmpty()) {
			lines.add(new Line(resources));
		}
		lines.add(new Line(ground(agent, radius, full)));
		if (full) {
			String extra = extras(agent, radius);
			if (!extra.isEmpty()) {
				lines.add(new Line(extra));
			}
		}

		int budget = full ? FULL_CHARS : BRIEF_CHARS;
		StringBuilder scene = new StringBuilder();
		for (Line line : lines) {
			String text = line.text();
			int need = (scene.isEmpty() ? 0 : 1) + text.length();
			if (scene.length() + need > budget) {
				int room = budget - scene.length() - (scene.isEmpty() ? 0 : 1);
				if (room > 40) {
					scene.append(scene.isEmpty() ? "" : "\n").append(text, 0, room - 1).append('…');
				}
				break;
			}
			scene.append(scene.isEmpty() ? "" : "\n").append(text);
		}
		JsonObject result = new JsonObject();
		result.addProperty("scene", scene.toString());
		result.addProperty("detail", full ? "full" : "brief");
		for (String key : out.keySet()) {
			result.add(key, out.get(key));
		}
		return result;
	}

	// ---------------------------------------------------------------- lines

	private static String here(final AgentPlayer agent, final boolean full) {
		ServerLevel level = agent.level();
		BlockPos feet = agent.blockPosition();
		StringBuilder sb = new StringBuilder("Here: ").append(Compass.xyz(feet)).append(' ').append(level.dimension().identifier().getPath());
		level.getBiome(feet).unwrapKey().ifPresent(k -> sb.append(", ").append(k.identifier().getPath().replace('_', ' ')));
		sb.append(", ").append(WorldClock.dayAndTime(level.getOverworldClockTime()));
		// The heightmap, not the sky light: light lags a tick behind blocks that were just placed.
		boolean sky = level.getHeight(Heightmap.Types.MOTION_BLOCKING, feet.getX(), feet.getZ()) <= feet.getY() + 1;
		sb.append(level.isDarkOutside() ? " (night" : " (day");
		sb.append(", light ").append(level.getMaxLocalRawBrightness(feet)).append(sky ? ", open sky)" : ", under cover)");
		if (level.isThundering()) {
			sb.append(", thunder");
		} else if (level.isRaining()) {
			sb.append(", rain");
		}
		if (full) {
			sb.append(". ").append(StatusFooter.activity(agent));
		}
		return sb.append('.').toString();
	}

	private static String hazards(final AgentPlayer agent, final int radius, final boolean full) {
		ServerLevel level = agent.level();
		BlockPos here = agent.blockPosition();
		List<String> out = new ArrayList<>();
		List<Entity> hostiles = new ArrayList<>(level.getEntities(agent, agent.getBoundingBox().inflate(Math.max(radius, 24)),
			e -> e.isAlive() && e instanceof Enemy));
		hostiles.sort(Comparator.comparingDouble(e -> e.distanceToSqr(agent)));
		for (Entity e : hostiles.subList(0, Math.min(full ? 5 : 3, hostiles.size()))) {
			out.add(Refs.entityTypeId(e).replace("minecraft:", "") + " " + Compass.where(here, e.blockPosition()));
		}
		if (hostiles.size() > (full ? 5 : 3)) {
			out.add("+" + (hostiles.size() - (full ? 5 : 3)) + " more hostiles");
		}
		List<BlockPos> lava = BlockScan.nearest(level, here, Math.min(Math.max(radius, 12), 24), s -> s.getFluidState().is(FluidTags.LAVA), p -> true, 1);
		if (!lava.isEmpty()) {
			out.add("lava " + Compass.where(here, lava.getFirst()));
		}
		String drop = drop(agent);
		if (drop != null) {
			out.add(drop);
		}
		if (agent.isInWater() && agent.getAirSupply() < agent.getMaxAirSupply()) {
			out.add("under water (air " + agent.getAirSupply() * 10 / Math.max(1, agent.getMaxAirSupply()) + "/10)");
		}
		return out.isEmpty() ? "Hazards: none seen." : "Hazards: " + String.join(", ", out) + ".";
	}

	/** The nearest sheer drop of 4+ blocks within 4 blocks, e.g. "drop 6 deep 2m E". */
	private static @org.jspecify.annotations.Nullable String drop(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		BlockPos feet = agent.blockPosition();
		int[][] dirs = {{0, -1}, {1, -1}, {1, 0}, {1, 1}, {0, 1}, {-1, 1}, {-1, 0}, {-1, -1}};
		for (int d = 1; d <= 4; d++) {
			for (int[] dir : dirs) {
				BlockPos col = feet.offset(dir[0] * d, 0, dir[1] * d);
				if (!level.isLoaded(col) || !level.getBlockState(col).getCollisionShape(level, col).isEmpty()) {
					continue;
				}
				int depth = 0;
				BlockPos.MutableBlockPos p = col.mutable();
				while (depth < 16) {
					p.move(0, -1, 0);
					BlockState s = level.getBlockState(p);
					if (!s.getCollisionShape(level, p).isEmpty() || !s.getFluidState().isEmpty()) {
						break;
					}
					depth++;
				}
				if (depth >= 4) {
					return "drop " + (depth >= 16 ? "16+" : String.valueOf(depth)) + " deep " + Compass.where(feet, col);
				}
			}
		}
		return null;
	}

	/** Natural trees around {@code center}, nearest first. */
	public static List<Trees.Tree> nearbyTrees(final ServerLevel level, final BlockPos center, final int radius, final int limit) {
		List<BlockPos> logs = BlockScan.nearest(level, center, radius, Trees::isNaturalLogBlock, p -> true, 160);
		return Trees.treesOf(level, logs, limit);
	}

	/** Clusters of placed blocks near the agent: who built what, how big, where. The Base is listed as itself. */
	private static String built(final AgentPlayer agent, final int radius, final Zones.@org.jspecify.annotations.Nullable Zone zone, final boolean full) {
		ServerLevel level = agent.level();
		BlockPos here = agent.blockPosition();
		Map<String, List<BlockPos>> byOwner = new LinkedHashMap<>();
		int minCx = SectionPos.blockToSectionCoord(here.getX() - radius);
		int maxCx = SectionPos.blockToSectionCoord(here.getX() + radius);
		int minCz = SectionPos.blockToSectionCoord(here.getZ() - radius);
		int maxCz = SectionPos.blockToSectionCoord(here.getZ() + radius);
		int[] total = {0};
		for (int cx = minCx; cx <= maxCx; cx++) {
			for (int cz = minCz; cz <= maxCz; cz++) {
				ChunkMarks marks = Provenance.marksOf(level, cx, cz);
				if (marks == null) {
					continue;
				}
				marks.forEach(new ChunkPos(cx, cz), (p, owner) -> {
					if (total[0] >= 4096 || Math.abs(p.getX() - here.getX()) > radius || Math.abs(p.getZ() - here.getZ()) > radius
						|| Math.abs(p.getY() - here.getY()) > radius) {
						return;
					}
					if (owner.isBase() && zone != null && zone.contains(level.dimension(), p)) {
						return;
					}
					total[0]++;
					byOwner.computeIfAbsent(label(owner), k -> new ArrayList<>()).add(p.immutable());
				});
			}
		}
		List<String> parts = new ArrayList<>();
		if (zone != null && zone.distance(here) <= radius) {
			parts.add(zone.name() + " " + (zone.contains(level.dimension(), here) ? "(you are in it)" : Compass.where(here, zone.center())));
		}
		record Cluster(String owner, int count, BoundingBox box, BlockPos nearest) {
		}
		List<Cluster> clusters = new ArrayList<>();
		for (Map.Entry<String, List<BlockPos>> e : byOwner.entrySet()) {
			for (List<BlockPos> group : cluster(e.getValue())) {
				BoundingBox box = BoundingBox.encapsulatingPositions(group).orElseThrow();
				BlockPos nearest = group.stream().min(Comparator.comparingDouble(p -> p.distSqr(here))).orElseThrow();
				clusters.add(new Cluster(e.getKey(), group.size(), box, nearest));
			}
		}
		clusters.sort(Comparator.comparingDouble(c -> c.nearest().distSqr(here)));
		int shown = 0;
		for (Cluster c : clusters) {
			if (shown++ >= (full ? 6 : 3)) {
				parts.add("+" + (clusters.size() - (full ? 6 : 3)) + " more");
				break;
			}
			String size = c.count() == 1 ? "1 block" : c.count() + " blocks";
			String box = c.count() > 1 ? " " + c.box().minX() + " " + c.box().minY() + " " + c.box().minZ() + ".." + c.box().maxX() + " " + c.box().maxY() + " " + c.box().maxZ() : " at " + Compass.xyz(c.nearest());
			parts.add(c.owner() + " (" + size + ") " + Compass.where(here, c.nearest()) + (full ? box : ""));
		}
		return parts.isEmpty() ? "" : "Built: " + String.join("; ", parts) + ". Player-built blocks are protected; crew-built ones are yours to change.";
	}

	private static String label(final Owner owner) {
		return switch (owner.kind()) {
			case PLAYER -> owner.name() + "'s build";
			case AGENT -> owner.name() + " (crew) build";
			case BASE -> owner.name() + " (base)";
		};
	}

	/** Groups positions whose 4x4x4 cells touch (26 neighbours). */
	static List<List<BlockPos>> cluster(final List<BlockPos> positions) {
		Map<Long, List<BlockPos>> cells = new HashMap<>();
		for (BlockPos p : positions) {
			cells.computeIfAbsent(BlockPos.asLong(p.getX() >> 2, p.getY() >> 2, p.getZ() >> 2), k -> new ArrayList<>()).add(p);
		}
		Map<Long, Long> parent = new HashMap<>();
		for (Long c : cells.keySet()) {
			parent.put(c, c);
		}
		for (Long c : cells.keySet()) {
			BlockPos cp = BlockPos.of(c);
			for (int dx = -1; dx <= 1; dx++) {
				for (int dy = -1; dy <= 1; dy++) {
					for (int dz = -1; dz <= 1; dz++) {
						long n = BlockPos.asLong(cp.getX() + dx, cp.getY() + dy, cp.getZ() + dz);
						if (parent.containsKey(n)) {
							union(parent, c, n);
						}
					}
				}
			}
		}
		Map<Long, List<BlockPos>> groups = new LinkedHashMap<>();
		for (Map.Entry<Long, List<BlockPos>> e : cells.entrySet()) {
			groups.computeIfAbsent(find(parent, e.getKey()), k -> new ArrayList<>()).addAll(e.getValue());
		}
		return new ArrayList<>(groups.values());
	}

	private static long find(final Map<Long, Long> parent, final long x) {
		long r = x;
		while (parent.get(r) != r) {
			r = parent.get(r);
		}
		long c = x;
		while (parent.get(c) != r) {
			long next = parent.get(c);
			parent.put(c, r);
			c = next;
		}
		return r;
	}

	private static void union(final Map<Long, Long> parent, final long a, final long b) {
		long ra = find(parent, a);
		long rb = find(parent, b);
		if (ra != rb) {
			parent.put(ra, rb);
		}
	}

	/**
	 * Where someone stands for shelter: {@code in Base, under cover}, {@code under cover}, {@code in Base, in the open},
	 * {@code in the open}. {@code zone}: the protected zone they are in, or null; {@code covered}: a block above the head
	 * (leaves don't count).
	 */
	static String shelterWords(final @org.jspecify.annotations.Nullable String zone, final boolean covered) {
		return (zone != null ? "in " + zone + ", " : "") + (covered ? "under cover" : "in the open");
	}

	private static String people(final AgentPlayer agent, final boolean full) {
		ServerLevel level = agent.level();
		BlockPos here = agent.blockPosition();
		List<String> parts = new ArrayList<>();
		for (ServerPlayer p : level.getServer().getPlayerList().getPlayers()) {
			if (p instanceof AgentPlayer || p.isSpectator()) {
				continue;
			}
			if (p.level() != level) {
				parts.add(p.getGameProfile().name() + " (player) in " + p.level().dimension().identifier().getPath());
			} else {
				// Whether the player is indoors (in the Base, under a roof): what "keep me safe" at night checks. Leaves are
				// no roof: a player under a tree at night is in the open.
				BlockPos feet = p.blockPosition();
				Zones.Zone in = Zones.at(level, feet);
				boolean covered = level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, feet.getX(), feet.getZ()) > feet.getY() + 1;
				parts.add(p.getGameProfile().name() + " (player) " + Compass.where(here, feet) + (full ? " at " + Compass.xyz(feet) : "")
					+ ", " + shelterWords(in == null ? null : in.name(), covered));
			}
		}
		for (AgentPlayer a : AgentService.get(level.getServer()).agents()) {
			if (a == agent || a.isAgentDead() || a.isRemoved()) {
				continue;
			}
			String who = a.getGameProfile().name() + " (" + a.role().id() + ")";
			if (a.level() != level) {
				parts.add(who + " in " + a.level().dimension().identifier().getPath());
			} else {
				parts.add(who + " " + Compass.where(here, a.blockPosition()) + (full ? ", " + StatusFooter.activity(a) : ""));
			}
		}
		return parts.isEmpty() ? "" : "People: " + String.join("; ", parts) + ".";
	}

	private record Ore(String name, TagKey<Block> tag) {
	}

	private static final List<Ore> ORES = List.of(
		new Ore("coal", tag("coal_ores")), new Ore("iron", tag("iron_ores")), new Ore("copper", tag("copper_ores")),
		new Ore("gold", tag("gold_ores")), new Ore("redstone", tag("redstone_ores")), new Ore("lapis", tag("lapis_ores")),
		new Ore("diamond", tag("diamond_ores")), new Ore("emerald", tag("emerald_ores")));

	private static TagKey<Block> tag(final String path) {
		return TagKey.create(Registries.BLOCK, Identifier.withDefaultNamespace(path));
	}

	private static String resources(final AgentPlayer agent, final int radius, final boolean full) {
		ServerLevel level = agent.level();
		BlockPos here = agent.blockPosition();
		List<String> parts = new ArrayList<>();
		List<BlockPos> water = BlockScan.nearest(level, here, Math.max(radius, 24), s -> s.getFluidState().is(FluidTags.WATER), p -> true, 1);
		if (!water.isEmpty()) {
			parts.add("water " + Compass.where(here, water.getFirst()));
		}
		List<String> ores = new ArrayList<>();
		int oreRadius = Math.min(radius, 16);
		for (Ore ore : ORES) {
			Predicate<BlockState> m = s -> s.is(ore.tag());
			List<BlockPos> found = BlockScan.nearest(level, here, oreRadius, m, p -> BlockScan.exposed(level, p) && !Protection.isProtected(level, p), 8);
			if (!found.isEmpty()) {
				ores.add(ore.name() + (found.size() > 1 ? " x" + found.size() + (found.size() >= 8 ? "+" : "") : "") + " " + Compass.where(here, found.getFirst()));
			}
		}
		if (!ores.isEmpty()) {
			parts.add("ores in sight: " + String.join(", ", ores.subList(0, Math.min(full ? 8 : 3, ores.size()))));
		}
		List<BlockPos> crops = BlockScan.nearest(level, here, radius, s -> s.getBlock() instanceof CropBlock, p -> true, 64);
		if (!crops.isEmpty()) {
			int ripe = 0;
			for (BlockPos p : crops) {
				BlockState s = level.getBlockState(p);
				if (s.getBlock() instanceof CropBlock c && c.isMaxAge(s)) {
					ripe++;
				}
			}
			BlockPos first = crops.getFirst();
			String kind = Refs.blockId(level.getBlockState(first).getBlock()).replace("minecraft:", "");
			parts.add("crops: " + kind + (crops.size() > 1 ? " x" + crops.size() : "") + " (" + ripe + " ripe) " + Compass.where(here, first)
				+ (Protection.isProtected(level, first) ? " (" + player(level) + "'s, protected)" : ""));
		}
		if (full) {
			List<Entity> animals = level.getEntities(agent, agent.getBoundingBox().inflate(radius), e -> e.isAlive() && e instanceof Animal);
			Map<String, Integer> kinds = new LinkedHashMap<>();
			animals.sort(Comparator.comparingDouble(e -> e.distanceToSqr(agent)));
			for (Entity e : animals) {
				kinds.merge(Refs.entityTypeId(e).replace("minecraft:", ""), 1, Integer::sum);
			}
			if (!kinds.isEmpty()) {
				List<String> a = new ArrayList<>();
				kinds.forEach((k, v) -> a.add(k + (v > 1 ? " x" + v : "")));
				parts.add("animals: " + String.join(", ", a.subList(0, Math.min(5, a.size()))));
			}
		}
		return parts.isEmpty() ? "" : "Resources: " + String.join("; ", parts) + ".";
	}

	private static String player(final ServerLevel level) {
		return Protection.playerName(level.getServer());
	}

	private static String ground(final AgentPlayer agent, final int radius, final boolean full) {
		ServerLevel level = agent.level();
		BlockPos feet = agent.blockPosition();
		int step = Math.max(2, radius / 4);
		int min = Integer.MAX_VALUE;
		int max = Integer.MIN_VALUE;
		Map<String, Integer> surface = new HashMap<>();
		for (int dx = -4; dx <= 4; dx++) {
			for (int dz = -4; dz <= 4; dz++) {
				int x = feet.getX() + dx * step;
				int z = feet.getZ() + dz * step;
				if (!level.isLoaded(new BlockPos(x, feet.getY(), z))) {
					continue;
				}
				int top = level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x, z);
				min = Math.min(min, top - feet.getY());
				max = Math.max(max, top - feet.getY());
				BlockState s = level.getBlockState(new BlockPos(x, top - 1, z));
				String name = !s.getFluidState().isEmpty() ? "water" : Refs.blockId(s.getBlock()).replace("minecraft:", "");
				surface.merge(name, 1, Integer::sum);
			}
		}
		StringBuilder sb = new StringBuilder("Ground: ");
		String main = surface.entrySet().stream().max(Map.Entry.comparingByValue()).map(Map.Entry::getKey).orElse("?");
		sb.append(main);
		if (min != Integer.MAX_VALUE) {
			int range = max - min;
			String shape = range <= 2 ? "flat" : range <= 6 ? "gentle slopes" : range <= 15 ? "hilly" : "steep";
			sb.append(", ").append(shape).append(String.format(Locale.ROOT, " (%+d..%+d within %dm)", min, max, step * 4));
		}
		BlockState under = level.getBlockState(feet.below());
		sb.append(", standing on ").append(Refs.blockId(under.getBlock()).replace("minecraft:", ""));
		if (full) {
			sb.append(", block light ").append(level.getBrightness(LightLayer.BLOCK, feet));
		}
		return sb.append('.').toString();
	}

	/** Full detail only: loose items, workstations and beds around. */
	private static String extras(final AgentPlayer agent, final int radius) {
		ServerLevel level = agent.level();
		BlockPos here = agent.blockPosition();
		List<String> parts = new ArrayList<>();
		Map<String, Integer> items = new LinkedHashMap<>();
		for (ItemEntity e : level.getEntitiesOfClass(ItemEntity.class, agent.getBoundingBox().inflate(radius), Entity::isAlive)) {
			items.merge(Refs.itemId(e.getItem()).replace("minecraft:", ""), e.getItem().getCount(), Integer::sum);
		}
		if (!items.isEmpty()) {
			List<String> i = new ArrayList<>();
			items.forEach((k, v) -> i.add(k + " x" + v));
			parts.add("items on the ground: " + String.join(", ", i.subList(0, Math.min(6, i.size()))));
		}
		Map<String, Predicate<BlockState>> spots = new LinkedHashMap<>();
		spots.put("crafting table", s -> s.is(Blocks.CRAFTING_TABLE));
		spots.put("furnace", s -> s.is(Blocks.FURNACE) || s.is(Blocks.SMOKER) || s.is(Blocks.BLAST_FURNACE));
		spots.put("chest", s -> s.is(Blocks.CHEST) || s.is(Blocks.BARREL));
		spots.put("bed", s -> s.is(net.minecraft.tags.BlockTags.BEDS));
		for (Map.Entry<String, Predicate<BlockState>> e : spots.entrySet()) {
			List<BlockPos> found = BlockScan.nearest(level, here, Math.min(radius, 24), e.getValue(), p -> true, 1);
			if (!found.isEmpty()) {
				parts.add(e.getKey() + " " + Compass.where(here, found.getFirst()) + " at " + Compass.xyz(found.getFirst()));
			}
		}
		return parts.isEmpty() ? "" : "Also: " + String.join("; ", parts) + ".";
	}
}
