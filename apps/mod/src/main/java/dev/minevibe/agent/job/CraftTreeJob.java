package dev.minevibe.agent.job;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.skill.Refs;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.AbstractFurnaceBlock;
import net.minecraft.world.level.block.Blocks;
import org.jspecify.annotations.Nullable;

/**
 * {@code craft{item, count, table?, tree:true, gather_missing?}} (docs/design/tools-v2-mc.md M4): makes {@code count}
 * of an item end to end. It plans the recipe tree ({@link RecipeTree}) from the inventory, gathers missing raw
 * materials from nature when {@code gather_missing} (child {@code collect} jobs, natural sources only), plans again,
 * then runs the steps as child {@code craft} / {@code smelt} jobs, crafting a table or furnace first when none is near
 * or carried (the child jobs use a station within 24 blocks, the one at {@code table}, or put the agent's own down).
 *
 * <p>Without {@code gather_missing}, missing raw materials fail the job with {@code MISSING_INGREDIENTS} and
 * {@code result.missing: [{item, need, have, for}]} before anything is crafted. The result: {@code {item, crafted, have,
 * steps: ["oak_log 1 → oak_planks 4", …], station: {kind, pos, placed}, gathered: {…}}}.
 */
public final class CraftTreeJob extends SkillJob {
	/** Rounds of gather → plan before giving up (a gather that comes back short). */
	private static final int MAX_ROUNDS = 3;
	/** Radius of the child {@code collect} jobs. */
	public static final int GATHER_RADIUS = 48;
	/** Stations this close count as "near" (the child jobs' own search). */
	private static final int STATION_RADIUS = 24;

	private enum Phase { PLAN, GATHER, STEPS, DONE }

	private final Item item;
	private final int count;
	private final @Nullable BlockPos table;
	private final boolean gatherMissing;
	private final ChildRunner runner = new ChildRunner();
	private final Deque<SkillJob> queue = new ArrayDeque<>();
	private final JsonArray stepTexts = new JsonArray();
	private final Map<String, Integer> gathered = new LinkedHashMap<>();
	private Phase phase = Phase.PLAN;
	private int rounds;
	private int startCount;
	private RecipeTree.@Nullable Plan plan;
	private @Nullable JsonObject station;
	private String current = "";

	public CraftTreeJob(final Item item, final int count, final @Nullable BlockPos table, final boolean gatherMissing) {
		super("craft");
		this.item = item;
		this.count = count;
		this.table = table;
		this.gatherMissing = gatherMissing;
	}

	@Override
	protected int timeoutTicks() {
		return SequenceJob.MAX_TICKS;
	}

	@Override
	public void start(final AgentPlayer agent) {
		this.startCount = Inv.count(agent, this.item);
	}

	@Override
	public void onPreempt(final AgentPlayer agent) {
		super.onPreempt(agent);
		this.runner.preempt(agent);
	}

	@Override
	public void onResume(final AgentPlayer agent) {
		this.runner.resume(agent);
	}

	@Override
	public void cancel(final AgentPlayer agent) {
		super.cancel(agent);
		this.runner.cancel(agent, "cancelled");
	}

	@Override
	protected void onFinish(final AgentPlayer agent) {
		this.report(agent);
	}

	/** The plan this job made last (tests). */
	public RecipeTree.@Nullable Plan plan() {
		return this.plan;
	}

	@Override
	protected Status step(final AgentPlayer agent) {
		if (this.runner.active()) {
			Status s = this.runner.tick(agent);
			SkillJob child = this.runner.child();
			if (child != null) {
				this.progress(null, (this.current + " " + child.progressText()).trim());
			}
			if (s == Status.RUNNING) {
				return Status.RUNNING;
			}
			SkillJob.Outcome o = this.runner.last();
			if (o != null) {
				this.noteChild(o);
			}
			if (o == null || !o.done()) {
				// A child that failed (NO_NATURAL_SOURCE while gathering, MISSING_INGREDIENTS, NO_ROOM, ...) ends the job
				// with its code, and the details the agent needs (candidates seen, what is protected) come along.
				if (o != null) {
					for (String k : new String[] {"noNaturalSource", "protected", "candidates", "missing", "ingredients"}) {
						if (o.result().has(k)) {
							this.result.add(k, o.result().get(k).deepCopy());
						}
					}
				}
				this.report(agent);
				String what = this.phase == Phase.GATHER ? "gathering for " + RecipeTree.id(this.item) : this.current;
				return this.fail(o == null || o.code() == null ? "FAILED" : o.code(), what + ": " + (o == null ? "failed" : o.message()));
			}
		}
		return switch (this.phase) {
			case PLAN -> this.planNow(agent);
			case GATHER -> this.nextGather(agent);
			case STEPS -> this.nextStep(agent);
			case DONE -> this.finish(agent);
		};
	}

	private Status planNow(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		RecipeTree.Stations stations = stations(agent, this.table);
		RecipeTree.Plan p = RecipeTree.plan(Recipes.book(level), this.item, this.count, Recipes.inventory(agent), stations);
		this.plan = p;
		if (p.steps().isEmpty() && p.missing().size() == 1 && p.missing().getFirst().item() == this.item) {
			return this.fail("NO_RECIPE", "nothing crafts or smelts " + Refs.itemId(this.item) + "; gather it instead");
		}
		if (!p.complete()) {
			if (!this.gatherMissing || this.rounds >= MAX_ROUNDS) {
				this.putMissing(p);
				this.report(agent);
				return this.fail("MISSING_INGREDIENTS", "raw materials missing: " + missingText(p) + (this.gatherMissing ? " (gathered what nature had)" : ""));
			}
			this.rounds++;
			for (RecipeTree.Missing m : p.missing()) {
				Refs.ItemMatcher what = Refs.item(m.ref());
				this.queue.add(new GatherJobs.Collect(what, m.need(), GATHER_RADIUS));
			}
			this.phase = Phase.GATHER;
			return Status.RUNNING;
		}
		for (RecipeTree.Step s : p.steps()) {
			boolean last = s == p.steps().getLast() && s.item() == this.item;
			this.queue.add(switch (s.kind()) {
				case CRAFT -> new CraftJobs.Craft(s.item(), last ? this.count : s.made(), s.needsTable() ? this.table : null);
				case SMELT -> new CraftJobs.Smelt(Refs.item(Refs.itemId(s.from().keySet().iterator().next())), s.times(), null, null);
			});
			this.stepTexts.add(s.text());
		}
		this.phase = Phase.STEPS;
		return Status.RUNNING;
	}

	private Status nextGather(final AgentPlayer agent) {
		SkillJob next = this.queue.poll();
		if (next == null) {
			this.phase = Phase.PLAN;
			return Status.RUNNING;
		}
		this.current = "gather " + describe(next);
		this.runner.begin(agent, next);
		return Status.RUNNING;
	}

	private Status nextStep(final AgentPlayer agent) {
		SkillJob next = this.queue.poll();
		if (next == null) {
			return this.finish(agent);
		}
		this.current = next.skill() + " " + describe(next);
		this.runner.begin(agent, next);
		return Status.RUNNING;
	}

	private Status finish(final AgentPlayer agent) {
		this.phase = Phase.DONE;
		this.report(agent);
		int made = Inv.count(agent, this.item) - this.startCount;
		if (made < this.count) {
			return this.fail("MISSING_INGREDIENTS", "made only " + Math.max(0, made) + " of " + this.count + " " + Refs.itemId(this.item));
		}
		return this.done();
	}

	/** Notes what a finished child did: gathered items, the station it used or placed. */
	private void noteChild(final SkillJob.Outcome o) {
		JsonObject r = o.result();
		if (r.has("items") && r.get("items").isJsonObject() && this.phase == Phase.GATHER) {
			for (var e : r.getAsJsonObject("items").entrySet()) {
				if (e.getValue().isJsonPrimitive()) {
					this.gathered.merge(e.getKey().replace("minecraft:", ""), e.getValue().getAsInt(), Integer::sum);
				}
			}
		}
		for (String[] k : new String[][] {{"placedTable", "crafting_table", "true"}, {"table", "crafting_table", "false"},
			{"placedFurnace", "furnace", "true"}, {"furnace", "furnace", "false"}}) {
			if (r.has(k[0]) && r.get(k[0]).isJsonObject() && (this.station == null || "true".equals(k[2]))) {
				JsonObject s = new JsonObject();
				s.addProperty("kind", k[1]);
				s.add("pos", r.get(k[0]));
				s.addProperty("placed", Boolean.parseBoolean(k[2]));
				this.station = s;
			}
		}
	}

	private void report(final AgentPlayer agent) {
		this.put("item", Refs.itemId(this.item));
		this.put("crafted", Math.max(0, Inv.count(agent, this.item) - this.startCount));
		this.put("have", Inv.count(agent, this.item));
		this.put("steps", this.stepTexts);
		if (this.station != null) {
			this.put("station", this.station);
		}
		if (!this.gathered.isEmpty()) {
			this.put("gathered", this.gathered);
		}
	}

	private void putMissing(final RecipeTree.Plan p) {
		JsonArray arr = new JsonArray();
		for (RecipeTree.Missing m : p.missing()) {
			JsonObject o = new JsonObject();
			o.addProperty("item", m.item() == null ? m.ref() : RecipeTree.id(m.item()));
			o.addProperty("need", m.need());
			o.addProperty("have", m.have());
			if (m.forItem() != null) {
				o.addProperty("for", RecipeTree.id(m.forItem()));
			}
			arr.add(o);
		}
		this.put("missing", arr);
	}

	static String missingText(final RecipeTree.Plan p) {
		StringBuilder b = new StringBuilder();
		for (RecipeTree.Missing m : p.missing()) {
			if (!b.isEmpty()) {
				b.append(", ");
			}
			b.append(m.item() == null ? m.ref().replace("minecraft:", "") + " (fuel)" : RecipeTree.id(m.item())).append(' ').append(m.need());
		}
		return b.toString();
	}

	/** A short label of a child job ({@code oak_log ×4}). */
	private static String describe(final SkillJob job) {
		return job.progressText().isEmpty() ? job.skill() : job.progressText();
	}

	/** Stations the agent can use without making one: one within reach, the one asked for, or one carried. */
	public static RecipeTree.Stations stations(final AgentPlayer agent, final @Nullable BlockPos table) {
		ServerLevel level = agent.level();
		boolean hasTable = table != null && level.getBlockState(table).is(Blocks.CRAFTING_TABLE)
			|| Inv.count(agent, Items.CRAFTING_TABLE) > 0
			|| !BlockScan.nearest(level, agent.blockPosition(), STATION_RADIUS, s -> s.is(Blocks.CRAFTING_TABLE), p -> true, 1).isEmpty();
		boolean hasFurnace = Inv.count(agent, Items.FURNACE) > 0
			|| !BlockScan.nearest(level, agent.blockPosition(), STATION_RADIUS, s -> s.getBlock() instanceof AbstractFurnaceBlock && s.is(Blocks.FURNACE), p -> true, 1).isEmpty();
		return new RecipeTree.Stations(hasTable, hasFurnace);
	}

	/** {@code obs.query recipe{item, count, tree:true}} (M5): the plan as JSON, without acting. */
	public static JsonObject planJson(final AgentPlayer agent, final Item item, final int count) {
		ServerLevel level = agent.level();
		RecipeTree.Stations stations = stations(agent, null);
		RecipeTree.Plan p = RecipeTree.plan(Recipes.book(level), item, count, Recipes.inventory(agent), stations);
		JsonObject o = new JsonObject();
		o.addProperty("item", Refs.itemId(item));
		o.addProperty("count", count);
		o.addProperty("tree", true);
		o.addProperty("ok", p.complete());
		o.addProperty("have", Inv.count(agent, item));
		JsonArray steps = new JsonArray();
		Map<Item, Integer> virtual = new LinkedHashMap<>(Recipes.inventory(agent));
		for (RecipeTree.Step s : p.steps()) {
			JsonObject e = new JsonObject();
			e.addProperty("action", s.kind() == RecipeTree.Kind.SMELT ? "smelt" : "craft");
			e.addProperty("item", RecipeTree.id(s.item()));
			e.addProperty("count", s.made());
			JsonObject from = new JsonObject();
			boolean ready = true;
			for (Map.Entry<Item, Integer> f : s.from().entrySet()) {
				from.addProperty(RecipeTree.id(f.getKey()), f.getValue());
				int have = virtual.getOrDefault(f.getKey(), 0);
				ready &= have >= f.getValue();
				virtual.put(f.getKey(), have - f.getValue());
			}
			virtual.merge(s.item(), s.made(), Integer::sum);
			e.add("from", from);
			if (ready) {
				e.addProperty("ready", true);
			}
			if (s.needsTable()) {
				e.addProperty("station", "crafting_table");
			} else if (s.kind() == RecipeTree.Kind.SMELT) {
				e.addProperty("station", "furnace");
			}
			steps.add(e);
		}
		o.add("steps", steps);
		JsonArray missing = new JsonArray();
		for (RecipeTree.Missing m : p.missing()) {
			JsonObject e = new JsonObject();
			e.addProperty("item", m.item() == null ? m.ref() : RecipeTree.id(m.item()));
			e.addProperty("need", m.need());
			e.addProperty("have", m.have());
			if (m.forItem() != null) {
				e.addProperty("for", RecipeTree.id(m.forItem()));
			}
			missing.add(e);
		}
		o.add("missing", missing);
		JsonObject st = new JsonObject();
		if (p.needsTable()) {
			st.add("table", stationJson(agent, s -> s.is(Blocks.CRAFTING_TABLE), Items.CRAFTING_TABLE, p.makesTable()));
		}
		if (p.needsFurnace()) {
			st.add("furnace", stationJson(agent, s -> s.is(Blocks.FURNACE), Items.FURNACE, p.makesFurnace()));
		}
		o.add("stations", st);
		return o;
	}

	private static JsonObject stationJson(final AgentPlayer agent, final java.util.function.Predicate<net.minecraft.world.level.block.state.BlockState> match,
		final Item item, final boolean makes) {
		JsonObject o = new JsonObject();
		List<BlockPos> near = BlockScan.nearest(agent.level(), agent.blockPosition(), STATION_RADIUS, match, p -> true, 1);
		if (!near.isEmpty()) {
			o.add("pos", SkillJob.pos(near.getFirst()));
		} else if (Inv.count(agent, item) > 0) {
			o.addProperty("how", "put down the one you carry");
		} else if (makes) {
			o.addProperty("how", "craft one first");
		}
		return o;
	}
}
