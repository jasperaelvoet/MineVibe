package dev.minevibe.agent.skill;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.minevibe.agent.AgentEvents;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentService;
import dev.minevibe.agent.job.BlockScan;
import dev.minevibe.agent.job.Inv;
import dev.minevibe.agent.job.Job;
import dev.minevibe.agent.job.MenuView;
import dev.minevibe.agent.job.Recipes;
import dev.minevibe.agent.job.SkillJob;
import dev.minevibe.agent.skill.seat.PcRegistry;
import dev.minevibe.agent.skill.seat.Seats;
import dev.minevibe.bridge.msg.Types;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.TagKey;
import net.minecraft.world.effect.MobEffectInstance;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.RecipeHolder;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CropBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import org.jspecify.annotations.Nullable;

/**
 * {@code obs.query} (PLAN 7.4 Observe): {@code status}, {@code look_around}, {@code inventory}, {@code find},
 * {@code recipe}, {@code recent_events}, {@code crew}, {@code list_pcs}, {@code job_status}, {@code menu_state}. Every
 * result is a compact JSON object ending with the agent's status {@code footer}.
 */
public final class Observations {
	private Observations() {
	}

	public static JsonObject query(final SkillService service, final AgentPlayer agent, final String query, final JsonObject args) {
		JsonObject out = switch (query) {
			case "status" -> status(service, agent);
			case "look_around" -> lookAround(agent, intArg(args, "radius", 16, 1, 32));
			case "inventory" -> inventory(agent);
			case "find" -> find(agent, stringArg(args, "what"), intArg(args, "radius", 32, 1, 64), intArg(args, "limit", 5, 1, 10));
			case "recipe" -> recipe(agent, stringArg(args, "item"));
			case "recent_events" -> recentEvents(agent, intArg(args, "limit", 20, 1, 50));
			case "crew" -> crew(service, agent);
			case "list_pcs" -> listPcs(agent);
			case "job_status" -> jobStatus(service, agent, args.has("jobId") ? rawStringArg(args, "jobId") : null);
			case "menu_state" -> MenuView.snapshot(agent);
			default -> throw Refs.badArgs("unknown query " + query);
		};
		out.addProperty("footer", StatusFooter.line(agent));
		return out;
	}

	// ---------------------------------------------------------------- queries

	static JsonObject status(final SkillService service, final AgentPlayer agent) {
		ServerLevel level = agent.level();
		JsonObject o = new JsonObject();
		o.addProperty("agentId", agent.agentId());
		o.addProperty("name", agent.getGameProfile().name());
		o.addProperty("role", agent.role().id());
		o.addProperty("hp", round(agent.getHealth()));
		o.addProperty("maxHp", round(agent.getMaxHealth()));
		o.addProperty("food", agent.getFoodData().getFoodLevel());
		o.addProperty("saturation", round(agent.getFoodData().getSaturationLevel()));
		o.addProperty("air", agent.getAirSupply());
		o.addProperty("armor", agent.getArmorValue());
		o.addProperty("xpLevel", agent.experienceLevel);
		o.add("pos", SkillJob.toJson(agent.position()));
		o.addProperty("dim", level.dimension().identifier().toString());
		level.getBiome(agent.blockPosition()).unwrapKey().ifPresent(k -> o.addProperty("biome", k.identifier().toString()));
		o.addProperty("time", WorldClock.dayAndTime(level.getOverworldClockTime()));
		o.addProperty("weather", level.isThundering() ? "thunder" : level.isRaining() ? "rain" : "clear");
		o.addProperty("light", level.getMaxLocalRawBrightness(agent.blockPosition()));
		o.addProperty("mode", agent.brain().mode().id());
		if (agent.brain().anchor() != null) {
			o.add("anchor", SkillJob.pos(agent.brain().anchor()));
		}
		o.addProperty("activity", StatusFooter.activity(agent));
		Job job = agent.jobs().current();
		if (job instanceof SkillJob sj) {
			o.add("job", jobJson(service, sj));
		}
		SkillService.Seated seated = service.seated(agent.agentId());
		if (seated != null) {
			JsonObject s = new JsonObject();
			s.addProperty("kind", seated.target().kind());
			if (seated.target().pcId() != null) {
				s.addProperty("pcId", seated.target().pcId());
			}
			if (seated.target().meetingId() != null) {
				s.addProperty("meetingId", seated.target().meetingId());
			}
			o.add("seat", s);
		}
		o.addProperty("held", agent.getMainHandItem().isEmpty() ? "nothing" : Refs.itemId(agent.getMainHandItem()));
		if (!agent.getOffhandItem().isEmpty()) {
			o.addProperty("offhand", Refs.itemId(agent.getOffhandItem()));
		}
		JsonArray effects = new JsonArray();
		for (MobEffectInstance e : agent.getActiveEffects()) {
			effects.add(e.getEffect().unwrapKey().map(k -> k.identifier().getPath()).orElse("?") + " " + e.getDuration() / 20 + "s");
		}
		if (!effects.isEmpty()) {
			o.add("effects", effects);
		}
		o.addProperty("inCombat", agent.brain().threats().inCombat(agent, 12.0) || agent.brain().hurtByHostileWithin(160));
		if (agent.isSleeping()) {
			o.addProperty("sleeping", true);
		}
		ServerPlayer player = Refs.player(agent);
		if (player != null) {
			o.addProperty("playerDistance", round(agent.distanceTo(player)));
		}
		return o;
	}

	static JsonObject lookAround(final AgentPlayer agent, final int radius) {
		ServerLevel level = agent.level();
		JsonObject o = new JsonObject();
		List<Entity> entities = level.getEntities(agent, agent.getBoundingBox().inflate(radius), e -> e.isAlive() && !(e instanceof dev.minevibe.world.seat.SeatEntity));
		entities.sort(Comparator.comparingDouble(e -> e.distanceToSqr(agent)));
		JsonArray ents = new JsonArray();
		Map<String, Integer> items = new LinkedHashMap<>();
		for (Entity e : entities) {
			if (e instanceof ItemEntity item) {
				items.merge(Refs.itemId(item.getItem()), item.getItem().getCount(), Integer::sum);
				continue;
			}
			if (ents.size() >= 20) {
				continue;
			}
			ents.add(entityJson(agent, e));
		}
		o.add("entities", ents);
		if (!items.isEmpty()) {
			o.add("itemsOnGround", SkillJob.toJson(items));
		}
		o.add("blocks", notableBlocks(agent, Math.min(radius, 12)));
		BlockPos feet = agent.blockPosition();
		o.addProperty("time", WorldClock.dayAndTime(level.getOverworldClockTime()));
		o.addProperty("dark", level.isDarkOutside());
		o.addProperty("sky", level.canSeeSky(feet.above()));
		o.addProperty("blockLight", level.getBrightness(LightLayer.BLOCK, feet));
		o.addProperty("standingOn", Refs.blockId(level.getBlockState(feet.below()).getBlock()));
		level.getBiome(feet).unwrapKey().ifPresent(k -> o.addProperty("biome", k.identifier().toString()));
		return o;
	}

	static JsonObject entityJson(final AgentPlayer agent, final Entity e) {
		JsonObject j = new JsonObject();
		if (e instanceof AgentPlayer other) {
			j.addProperty("type", "agent");
			j.addProperty("id", other.agentId());
			j.addProperty("name", other.getGameProfile().name());
		} else if (e instanceof Player p) {
			j.addProperty("type", "player");
			j.addProperty("name", p.getGameProfile().name());
		} else {
			j.addProperty("type", Refs.entityTypeId(e));
			j.addProperty("id", e.getStringUUID());
			if (e.hasCustomName()) {
				j.addProperty("name", e.getCustomName().getString());
			}
		}
		j.addProperty("distance", round(agent.distanceTo(e)));
		j.add("pos", SkillJob.toJson(e.blockPosition()));
		if (e instanceof LivingEntity living) {
			j.addProperty("hp", round(living.getHealth()));
		}
		if (e instanceof Enemy) {
			j.addProperty("hostile", true);
		}
		return j;
	}

	private record Category(String name, Predicate<BlockState> match) {
	}

	private static TagKey<Block> blockTag(final String path) {
		return TagKey.create(Registries.BLOCK, Identifier.withDefaultNamespace(path));
	}

	private static final List<Category> NOTABLE = List.of(
		new Category("logs", s -> s.is(BlockTags.LOGS)),
		new Category("coal_ore", s -> s.is(blockTag("coal_ores"))),
		new Category("iron_ore", s -> s.is(blockTag("iron_ores"))),
		new Category("copper_ore", s -> s.is(blockTag("copper_ores"))),
		new Category("gold_ore", s -> s.is(blockTag("gold_ores"))),
		new Category("redstone_ore", s -> s.is(blockTag("redstone_ores"))),
		new Category("lapis_ore", s -> s.is(blockTag("lapis_ores"))),
		new Category("diamond_ore", s -> s.is(blockTag("diamond_ores"))),
		new Category("emerald_ore", s -> s.is(blockTag("emerald_ores"))),
		new Category("crafting_table", s -> s.is(Blocks.CRAFTING_TABLE)),
		new Category("furnace", s -> s.is(Blocks.FURNACE) || s.is(Blocks.SMOKER) || s.is(Blocks.BLAST_FURNACE)),
		new Category("chest", s -> s.is(Blocks.CHEST) || s.is(Blocks.BARREL) || s.is(Blocks.TRAPPED_CHEST)),
		new Category("bed", s -> s.is(BlockTags.BEDS)),
		new Category("crops", s -> s.getBlock() instanceof CropBlock),
		new Category("ripe_crops", s -> s.getBlock() instanceof CropBlock crop && crop.isMaxAge(s)),
		new Category("water", s -> s.is(Blocks.WATER)),
		new Category("lava", s -> s.is(Blocks.LAVA)),
		new Category("office_chair", s -> s.getBlock() instanceof dev.minevibe.world.seat.OfficeChairBlock)
	);

	/** Counts and the nearest position of notable blocks (logs, ores, workstations, beds, water, lava) in a cube. */
	static JsonObject notableBlocks(final AgentPlayer agent, final int radius) {
		ServerLevel level = agent.level();
		BlockPos c = agent.blockPosition();
		int[] counts = new int[NOTABLE.size()];
		BlockPos[] nearest = new BlockPos[NOTABLE.size()];
		double[] nearestD = new double[NOTABLE.size()];
		java.util.Arrays.fill(nearestD, Double.MAX_VALUE);
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		for (int dx = -radius; dx <= radius; dx++) {
			for (int dy = -radius; dy <= radius; dy++) {
				for (int dz = -radius; dz <= radius; dz++) {
					p.set(c.getX() + dx, c.getY() + dy, c.getZ() + dz);
					if (!level.isLoaded(p)) {
						continue;
					}
					BlockState s = level.getBlockState(p);
					if (s.isAir() || s.is(Blocks.STONE) || s.is(Blocks.DIRT) || s.is(Blocks.GRASS_BLOCK) || s.is(Blocks.DEEPSLATE)) {
						continue;
					}
					for (int i = 0; i < NOTABLE.size(); i++) {
						if (NOTABLE.get(i).match().test(s)) {
							counts[i]++;
							double d = dx * dx + dy * dy + dz * dz;
							if (d < nearestD[i]) {
								nearestD[i] = d;
								nearest[i] = p.immutable();
							}
						}
					}
				}
			}
		}
		JsonObject o = new JsonObject();
		for (int i = 0; i < NOTABLE.size(); i++) {
			if (counts[i] > 0) {
				JsonObject e = new JsonObject();
				e.addProperty("count", counts[i]);
				e.add("nearest", SkillJob.pos(nearest[i]));
				o.add(NOTABLE.get(i).name(), e);
			}
		}
		return o;
	}

	static JsonObject inventory(final AgentPlayer agent) {
		Inventory inv = agent.getInventory();
		JsonObject o = new JsonObject();
		JsonArray slots = new JsonArray();
		for (int slot = 0; slot < Inventory.INVENTORY_SIZE; slot++) {
			ItemStack s = inv.getItem(slot);
			if (s.isEmpty()) {
				continue;
			}
			JsonObject e = new JsonObject();
			e.addProperty("slot", slot);
			e.addProperty("item", Refs.itemId(s));
			e.addProperty("count", s.getCount());
			if (s.isDamageableItem()) {
				e.addProperty("durability", s.getMaxDamage() - s.getDamageValue());
			}
			slots.add(e);
		}
		o.add("slots", slots);
		JsonObject armor = new JsonObject();
		for (EquipmentSlot es : List.of(EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET)) {
			ItemStack s = agent.getItemBySlot(es);
			if (!s.isEmpty()) {
				armor.addProperty(es.getName(), Refs.itemId(s));
			}
		}
		o.add("armor", armor);
		if (!agent.getOffhandItem().isEmpty()) {
			o.addProperty("offhand", Refs.itemId(agent.getOffhandItem()));
		}
		o.addProperty("selected", inv.getSelectedSlot());
		o.addProperty("freeSlots", Inv.freeSlots(agent));
		o.add("totals", SkillJob.toJson(Inv.counts(agent)));
		return o;
	}

	static JsonObject find(final AgentPlayer agent, final String what, final int radius, final int limit) {
		ServerLevel level = agent.level();
		JsonObject o = new JsonObject();
		o.addProperty("what", what);
		JsonArray matches = new JsonArray();
		Identifier id = Refs.id(what);
		EntityType<?> type = what.startsWith("#") ? null : Refs.entityType(what);
		boolean isBlock = id != null && (what.startsWith("#") ? isBlockTag(id) : net.minecraft.core.registries.BuiltInRegistries.BLOCK.containsKey(id));
		if (type != null && !isBlock || "player".equals(what)) {
			o.addProperty("kind", "entity");
			List<Entity> found = new ArrayList<>(level.getEntities(agent, agent.getBoundingBox().inflate(radius),
				e -> e.isAlive() && ("player".equals(what) ? e instanceof Player && !(e instanceof AgentPlayer) : e.getType() == type)));
			found.sort(Comparator.comparingDouble(e -> e.distanceToSqr(agent)));
			for (Entity e : found.subList(0, Math.min(limit, found.size()))) {
				matches.add(entityJson(agent, e));
			}
		} else if (isBlock) {
			o.addProperty("kind", "block");
			Refs.BlockMatcher block = Refs.block(what);
			for (BlockPos p : BlockScan.nearest(level, agent.blockPosition(), radius, block, q -> true, limit)) {
				JsonObject m = new JsonObject();
				m.add("pos", SkillJob.pos(p));
				m.addProperty("block", Refs.blockId(level.getBlockState(p).getBlock()));
				m.addProperty("distance", round(Math.sqrt(p.distSqr(agent.blockPosition()))));
				m.addProperty("exposed", BlockScan.exposed(level, p));
				matches.add(m);
			}
		} else {
			o.addProperty("kind", "item");
			Refs.ItemMatcher item = Refs.item(what);
			List<ItemEntity> found = new ArrayList<>(level.getEntitiesOfClass(ItemEntity.class, agent.getBoundingBox().inflate(radius), e -> e.isAlive() && item.test(e.getItem())));
			found.sort(Comparator.comparingDouble(e -> e.distanceToSqr(agent)));
			for (ItemEntity e : found.subList(0, Math.min(limit, found.size()))) {
				JsonObject m = new JsonObject();
				m.add("pos", SkillJob.pos(e.blockPosition()));
				m.addProperty("item", Refs.itemId(e.getItem()));
				m.addProperty("count", e.getItem().getCount());
				m.addProperty("distance", round(agent.distanceTo(e)));
				matches.add(m);
			}
			o.addProperty("inInventory", Inv.count(agent, item));
		}
		o.add("matches", matches);
		if (matches.isEmpty()) {
			o.addProperty("note", "none within " + radius + " blocks (only loaded chunks are searched)");
		}
		return o;
	}

	private static boolean isBlockTag(final Identifier id) {
		return net.minecraft.core.registries.BuiltInRegistries.BLOCK.get(TagKey.create(Registries.BLOCK, id)).isPresent();
	}

	static JsonObject recipe(final AgentPlayer agent, final String itemRef) {
		Refs.ItemMatcher m = Refs.item(itemRef);
		if (m.item() == null) {
			throw Refs.badArgs("recipe needs one item, not a tag");
		}
		ServerLevel level = agent.level();
		JsonObject o = new JsonObject();
		o.addProperty("item", Refs.itemId(m.item()));
		JsonArray recipes = new JsonArray();
		List<RecipeHolder<?>> all = new ArrayList<>();
		all.addAll(Recipes.crafting(level, m.item()));
		all.addAll(Recipes.smeltingTo(level, m.item()));
		for (RecipeHolder<?> h : all.subList(0, Math.min(4, all.size()))) {
			recipes.add(Recipes.describe(agent, h));
		}
		o.add("recipes", recipes);
		if (all.isEmpty()) {
			o.addProperty("note", "no crafting or smelting recipe makes it; gather it instead");
		}
		o.addProperty("have", Inv.count(agent, m));
		return o;
	}

	static JsonObject recentEvents(final AgentPlayer agent, final int limit) {
		List<AgentEvents.Event> events = AgentEvents.recent(agent.agentId());
		long now = agent.level().getGameTime();
		JsonArray arr = new JsonArray();
		for (AgentEvents.Event e : events.subList(Math.max(0, events.size() - limit), events.size())) {
			JsonObject j = new JsonObject();
			j.addProperty("type", e.type());
			j.addProperty("agoS", Math.max(0L, (now - e.gameTime()) / 20L));
			if (!e.data().isEmpty()) {
				j.add("data", SkillJob.toJson(e.data()));
			}
			arr.add(j);
		}
		JsonObject o = new JsonObject();
		o.add("events", arr);
		return o;
	}

	static JsonObject crew(final SkillService service, final AgentPlayer agent) {
		JsonArray arr = new JsonArray();
		for (AgentPlayer a : AgentService.get(agent.level().getServer()).agents()) {
			if (a.isAgentDead() || a.isRemoved()) {
				continue;
			}
			JsonObject j = new JsonObject();
			j.addProperty("agentId", a.agentId());
			j.addProperty("name", a.getGameProfile().name());
			j.addProperty("role", a.role().id());
			j.add("pos", SkillJob.pos(a.blockPosition()));
			j.addProperty("dim", a.level().dimension().identifier().toString());
			j.addProperty("hp", round(a.getHealth()));
			j.addProperty("food", a.getFoodData().getFoodLevel());
			j.addProperty("activity", StatusFooter.activity(a));
			if (a != agent && a.level() == agent.level()) {
				j.addProperty("distance", round(a.distanceTo(agent)));
			}
			SkillService.Seated s = service.seated(a.agentId());
			if (s != null) {
				j.addProperty("seated", s.target().pcId() != null ? s.target().pcId() : "meeting");
			}
			arr.add(j);
		}
		JsonObject o = new JsonObject();
		o.add("crew", arr);
		return o;
	}

	static JsonObject listPcs(final AgentPlayer agent) {
		PcRegistry pcs = Seats.pcs();
		JsonArray arr = new JsonArray();
		for (String pcId : pcs.pcIds(agent.level().getServer())) {
			JsonObject j = new JsonObject();
			j.addProperty("pcId", pcId);
			String status = pcs.status(pcId);
			j.addProperty("status", status == null ? "unknown" : status);
			PcRegistry.Chair chair = pcs.chair(agent.level().getServer(), pcId);
			if (chair != null) {
				j.add("chair", SkillJob.pos(chair.pos()));
				if (chair.dim() == agent.level().dimension()) {
					j.addProperty("distance", round(Math.sqrt(chair.pos().distSqr(agent.blockPosition()))));
				}
			}
			Types.Occupant occ = pcs.occupant(agent.level().getServer(), pcId);
			j.addProperty("occupant", occ == null ? "free" : occ.isPlayer() ? "player" : occ.agentId());
			PcRegistry.Reservation r = pcs.reservation(pcId);
			if (r != null) {
				j.addProperty("reservedFor", r.agentId() + " (" + r.kind() + ")");
			}
			arr.add(j);
		}
		JsonObject o = new JsonObject();
		o.add("pcs", arr);
		return o;
	}

	static JsonObject jobStatus(final SkillService service, final AgentPlayer agent, final @Nullable String jobId) {
		SkillService.Handle h = jobId != null ? service.handle(jobId) : service.currentHandle(agent.agentId());
		if (h == null) {
			JsonObject o = new JsonObject();
			o.addProperty("status", jobId == null ? "idle" : "unknown");
			Job job = agent.jobs().current();
			if (job != null) {
				o.addProperty("current", job.name());
			}
			return o;
		}
		return jobJson(service, h.job());
	}

	static JsonObject jobJson(final SkillService service, final SkillJob job) {
		JsonObject o = new JsonObject();
		SkillService.Handle h = job.jobId() == null ? null : service.handle(job.jobId());
		if (job.jobId() != null) {
			o.addProperty("jobId", job.jobId());
		}
		o.addProperty("skill", job.skill());
		if (h != null && h.outcome() != null) {
			o.addProperty("status", h.outcome().status());
			o.add("result", h.outcome().result());
			if (h.outcome().code() != null) {
				o.addProperty("error", h.outcome().code() + ": " + h.outcome().message());
			}
		} else {
			o.addProperty("status", "running");
			if (job.progress() != null) {
				o.addProperty("progress", round(job.progress()));
			}
			if (!job.progressText().isEmpty()) {
				o.addProperty("text", job.progressText());
			}
		}
		if (h != null) {
			o.addProperty("elapsedS", h.elapsedMs() / 1000);
		}
		return o;
	}

	// ---------------------------------------------------------------- helpers

	private static double round(final double v) {
		return Math.round(v * 10.0) / 10.0;
	}

	private static String stringArg(final JsonObject args, final String key) {
		return rawStringArg(args, key).toLowerCase(Locale.ROOT);
	}

	private static String rawStringArg(final JsonObject args, final String key) {
		JsonElement e = args.get(key);
		if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString() || e.getAsString().isBlank()) {
			throw Refs.badArgs(key + " (a string) is required");
		}
		return e.getAsString().trim();
	}

	private static int intArg(final JsonObject args, final String key, final int dflt, final int min, final int max) {
		JsonElement e = args.get(key);
		if (e == null || e.isJsonNull()) {
			return dflt;
		}
		if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) {
			throw Refs.badArgs(key + " must be a number");
		}
		int v = e.getAsInt();
		if (v < min || v > max) {
			throw Refs.badArgs(key + " must be " + min + "-" + max);
		}
		return v;
	}
}
