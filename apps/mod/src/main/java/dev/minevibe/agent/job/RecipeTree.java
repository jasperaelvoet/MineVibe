package dev.minevibe.agent.job;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import org.jspecify.annotations.Nullable;

/**
 * The recipe tree behind {@code craft{tree:true}} and {@code obs.query recipe{tree:true}} (docs/design/tools-v2-mc.md
 * M4, M5): how to make {@code count} of an item from what the agent carries, crafting intermediates (logs → planks →
 * sticks) and smelting where needed, down to raw materials that must be gathered.
 *
 * <ul>
 *   <li>Recipes are picked by how well the inventory fits them (a dry run each: the fewest missing raw materials wins;
 *       2x2 recipes come first in the book, so they win ties).</li>
 *   <li>Ingredients are expanded at most {@value #MAX_DEPTH} levels deep, netting out the inventory as it goes (a
 *       virtual inventory: what one step makes, the next can use).</li>
 *   <li>Cycles are cut: a recipe that consumes an item being made higher up the tree is never used (nugget ↔ ingot ↔
 *       block), and an ingredient that is only a compressed or uncompressed form of the item itself (a block of 9
 *       ingots, log ↔ wood) is used only when the inventory holds it.</li>
 *   <li>What cannot be made is a raw leaf ({@link Missing}): gathered when asked ({@code gather_missing}), else the
 *       job fails {@code MISSING_INGREDIENTS} with the list.</li>
 *   <li>A 3x3 recipe needs a crafting table and smelting a furnace: when none is near and none is carried, making one is
 *       planned first (a furnace needs a table too). Smelting needs fuel: carried fuel the plan does not use, else
 *       logs to gather.</li>
 * </ul>
 *
 * <p>The planner is pure: recipes come from a {@link Book} (the server's RecipeManager in game, a table in tests).
 */
public final class RecipeTree {
	/** How deep ingredients are expanded. */
	public static final int MAX_DEPTH = 4;
	/** Items tried per slot, and slot combinations tried per recipe (bounds the dry runs). */
	private static final int MAX_CANDIDATES = 4;
	private static final int MAX_COMBOS = 8;
	/** Furnace ticks per smelted item. */
	public static final int SMELT_TICKS = 200;
	/** Fuel gathered when the inventory has none: any natural log (300 ticks each). */
	public static final String FUEL_REF = "#minecraft:logs";
	private static final int LOG_BURN_TICKS = 300;

	/** A crafting recipe as the planner sees it: what it makes, how many, and the item choices of each grid slot. */
	public record CraftOption(Object recipe, Item result, int makes, List<List<Item>> slots, boolean fits2x2) {
	}

	/** A smelting recipe: what goes in (any of {@code inputs}) and what comes out, one for one. */
	public record SmeltOption(Object recipe, Item result, List<Item> inputs) {
	}

	/** Where recipes come from. */
	public interface Book {
		/** Crafting recipes whose result is {@code item}, 2x2 recipes first. */
		List<CraftOption> crafting(Item item);

		/** Smelting recipes whose result is {@code item}. */
		List<SmeltOption> smelting(Item item);

		/** Furnace ticks one {@code item} burns for; 0 when it is no fuel. */
		int burnTicks(Item item);
	}

	public enum Kind {
		CRAFT,
		SMELT
	}

	/**
	 * One step, in the order to run them: craft {@code times} times (or smelt {@code times} items) to make {@code made}
	 * of {@code item} from {@code from}.
	 */
	public record Step(Kind kind, Item item, int times, int made, Map<Item, Integer> from, boolean needsTable, @Nullable Object recipe) {
		/** {@code oak_log 1 → oak_planks 4}. */
		public String text() {
			StringBuilder b = new StringBuilder();
			for (Map.Entry<Item, Integer> e : this.from.entrySet()) {
				if (!b.isEmpty()) {
					b.append(" + ");
				}
				b.append(id(e.getKey())).append(' ').append(e.getValue());
			}
			return b + " → " + id(this.item) + " " + this.made;
		}
	}

	/**
	 * A raw material the plan lacks: {@code need} more of {@code ref} (an item id, or {@link #FUEL_REF} for fuel), for
	 * {@code forItem}. {@code item} is null for a tag.
	 */
	public record Missing(String ref, @Nullable Item item, int need, int have, @Nullable Item forItem) {
	}

	/** Stations the agent can use without making one (a table or furnace within reach, or one carried). */
	public record Stations(boolean table, boolean furnace) {
	}

	/** The plan: steps in order, raw materials missing, and the stations it needs. */
	public record Plan(Item item, int count, List<Step> steps, List<Missing> missing, boolean needsTable, boolean needsFurnace,
		boolean makesTable, boolean makesFurnace, int smelts) {
		public boolean complete() {
			return this.missing.isEmpty();
		}

		/** Items made by the plan (the target included). */
		public int crafts() {
			return this.steps.size();
		}
	}

	private final Book book;
	private final Map<Item, Integer> inv;
	private final List<Step> steps = new ArrayList<>();
	private final Map<String, Missing> missing = new LinkedHashMap<>();
	private boolean needsTable;
	private boolean needsFurnace;
	private int smelts;

	private RecipeTree(final Book book, final Map<Item, Integer> inventory) {
		this.book = book;
		this.inv = new LinkedHashMap<>(inventory);
	}

	/**
	 * Plans {@code count} of {@code target} from {@code inventory} (item → count). {@code stations}: what is usable
	 * without making it. Crafts a table / furnace first when the plan needs one and none is usable.
	 */
	public static Plan plan(final Book book, final Item target, final int count, final Map<Item, Integer> inventory, final Stations stations) {
		boolean makeTable = false;
		boolean makeFurnace = false;
		RecipeTree t = run(book, target, count, inventory, false, false);
		for (int round = 0; round < 3; round++) {
			boolean wantTable = !stations.table() && t.needsTable && !makeTable && target != Items.CRAFTING_TABLE;
			boolean wantFurnace = !stations.furnace() && t.needsFurnace && !makeFurnace && target != Items.FURNACE;
			if (!wantTable && !wantFurnace) {
				break;
			}
			makeTable |= wantTable;
			makeFurnace |= wantFurnace;
			t = run(book, target, count, inventory, makeTable, makeFurnace);
			// A furnace is crafted at a table.
			if (makeFurnace && !stations.table() && !makeTable && t.needsTable) {
				makeTable = true;
				t = run(book, target, count, inventory, true, true);
			}
		}
		return new Plan(target, count, List.copyOf(t.steps), List.copyOf(t.missing.values()), t.needsTable, t.needsFurnace,
			makeTable, makeFurnace, t.smelts);
	}

	private static RecipeTree run(final Book book, final Item target, final int count, final Map<Item, Integer> inventory,
		final boolean makeTable, final boolean makeFurnace) {
		RecipeTree t = new RecipeTree(book, inventory);
		// Stations first: their planks and cobblestone come out of the same inventory as the rest.
		if (makeTable && t.have(Items.CRAFTING_TABLE) == 0) {
			t.need(Items.CRAFTING_TABLE, 1, 0, Set.of(), null);
			t.inv.merge(Items.CRAFTING_TABLE, 1, Integer::sum);
		}
		if (makeFurnace && t.have(Items.FURNACE) == 0) {
			t.need(Items.FURNACE, 1, 0, Set.of(), null);
			t.inv.merge(Items.FURNACE, 1, Integer::sum);
		}
		// The target is made fresh: `count` new items, whatever the inventory already holds of it.
		t.make(target, count);
		t.fuel();
		return t;
	}

	private int have(final Item item) {
		return this.inv.getOrDefault(item, 0);
	}

	/** Makes {@code n} new {@code item} (no taking from the inventory). */
	private void make(final Item item, final int n) {
		int before = this.have(item);
		this.inv.put(item, 0);
		this.need(item, n, 0, Set.of(), null);
		this.inv.merge(item, before, Integer::sum);
	}

	/** Takes {@code n} of {@code item}: from the inventory, else made, else missing. */
	private void need(final Item item, final int n, final int depth, final Set<Item> ancestors, final @Nullable Item forItem) {
		int from = Math.min(n, this.have(item));
		if (from > 0) {
			this.inv.put(item, this.have(item) - from);
		}
		int rest = n - from;
		if (rest <= 0) {
			return;
		}
		if (depth >= MAX_DEPTH || ancestors.contains(item)) {
			this.lack(id(item), item, rest, forItem);
			return;
		}
		Choice best = null;
		for (Choice c : this.choices(item, ancestors)) {
			RecipeTree dry = this.copy();
			dry.apply(c, item, rest, depth, ancestors);
			int lacking = dry.missingCount();
			if (best == null || lacking < best.lacking) {
				best = c.withLacking(lacking);
				if (lacking == 0) {
					break;
				}
			}
		}
		if (best == null) {
			this.lack(id(item), item, rest, forItem);
			return;
		}
		this.apply(best, item, rest, depth, ancestors);
	}

	/** One way to make an item: a crafting recipe with a concrete item per slot, or a smelting input. */
	private record Choice(@Nullable CraftOption craft, @Nullable SmeltOption smelt, List<Item> picks, int lacking) {
		Choice withLacking(final int n) {
			return new Choice(this.craft, this.smelt, this.picks, n);
		}
	}

	/** The candidate recipes for {@code item}, each slot filled with its best item. */
	private List<Choice> choices(final Item item, final Set<Item> ancestors) {
		List<Choice> out = new ArrayList<>();
		for (CraftOption o : this.book.crafting(item)) {
			// Each distinct slot (a tag such as "any planks") gets its candidate items; the combinations are tried.
			Map<List<Item>, List<Item>> bySlot = new LinkedHashMap<>();
			boolean ok = true;
			for (List<Item> slot : o.slots()) {
				List<Item> c = bySlot.computeIfAbsent(slot, s -> this.candidates(s, item, ancestors));
				if (c.isEmpty()) {
					ok = false;
					break;
				}
			}
			if (!ok) {
				continue;
			}
			List<Map<List<Item>, Item>> combos = new ArrayList<>();
			combos.add(Map.of());
			for (Map.Entry<List<Item>, List<Item>> e : bySlot.entrySet()) {
				List<Map<List<Item>, Item>> next = new ArrayList<>();
				for (Map<List<Item>, Item> combo : combos) {
					for (Item c : e.getValue()) {
						if (next.size() >= MAX_COMBOS) {
							break;
						}
						Map<List<Item>, Item> m = new LinkedHashMap<>(combo);
						m.put(e.getKey(), c);
						next.add(m);
					}
				}
				combos = next;
			}
			for (Map<List<Item>, Item> combo : combos) {
				List<Item> picks = new ArrayList<>();
				for (List<Item> slot : o.slots()) {
					picks.add(combo.get(slot));
				}
				out.add(new Choice(o, null, picks, 0));
			}
		}
		for (SmeltOption o : this.book.smelting(item)) {
			for (Item c : this.candidates(o.inputs(), item, ancestors)) {
				out.add(new Choice(null, o, List.of(c), 0));
			}
		}
		return out;
	}

	/**
	 * The items worth trying for a slot that accepts {@code options}: the ones the inventory holds (most first), then
	 * the most "basic" others (an oak log before a stripped log or wood, raw iron before iron ore), at most
	 * {@value #MAX_CANDIDATES}. Never an item being made higher up, and never a compressed form of {@code making} the
	 * inventory does not hold.
	 */
	private List<Item> candidates(final List<Item> options, final Item making, final Set<Item> ancestors) {
		List<Item> held = new ArrayList<>();
		List<Item> usable = new ArrayList<>();
		for (Item o : options) {
			if (o == making || ancestors.contains(o) || held.contains(o) || usable.contains(o)) {
				continue;
			}
			if (this.have(o) > 0) {
				held.add(o);
			} else if (!this.compresses(o, making)) {
				usable.add(o);
			}
		}
		held.sort(Comparator.comparingInt((Item o) -> -this.have(o)));
		usable.sort(Comparator.comparingInt(RecipeTree::preference).thenComparing(RecipeTree::id));
		List<Item> out = new ArrayList<>(held);
		out.addAll(usable);
		return out.size() > MAX_CANDIDATES ? out.subList(0, MAX_CANDIDATES) : out;
	}

	/** Whether {@code form} is only a storage form of {@code of}: a recipe makes it from {@code of} alone. */
	private boolean compresses(final Item form, final Item of) {
		for (CraftOption o : this.book.crafting(form)) {
			boolean onlyOf = !o.slots().isEmpty();
			for (List<Item> slot : o.slots()) {
				if (!slot.contains(of)) {
					onlyOf = false;
					break;
				}
			}
			if (onlyOf) {
				return true;
			}
		}
		return false;
	}

	/** Lower is preferred among interchangeable items: plain logs and oak first, stripped logs and wood last. */
	static int preference(final Item item) {
		String id = id(item);
		int p = 0;
		if (id.startsWith("stripped_")) {
			p += 4;
		}
		if (id.endsWith("_wood") || id.endsWith("_hyphae")) {
			p += 2;
		}
		if (id.endsWith("_ore")) {
			// Ore blocks drop raw metal: "iron_ore" itself only comes with silk touch.
			p += 3;
		}
		if (id.startsWith("oak_")) {
			p -= 1;
		}
		return p;
	}

	private void apply(final Choice c, final Item item, final int n, final int depth, final Set<Item> ancestors) {
		Set<Item> up = new HashSet<>(ancestors);
		up.add(item);
		if (c.craft() != null) {
			CraftOption o = c.craft();
			int times = (n + o.makes() - 1) / o.makes();
			Map<Item, Integer> per = new LinkedHashMap<>();
			for (Item p : c.picks()) {
				per.merge(p, 1, Integer::sum);
			}
			Map<Item, Integer> from = new LinkedHashMap<>();
			for (Map.Entry<Item, Integer> e : per.entrySet()) {
				int total = e.getValue() * times;
				from.put(e.getKey(), total);
				this.need(e.getKey(), total, depth + 1, up, item);
			}
			if (!o.fits2x2()) {
				this.needsTable = true;
			}
			int made = times * o.makes();
			this.steps.add(new Step(Kind.CRAFT, item, times, made, from, !o.fits2x2(), o.recipe()));
			this.inv.merge(item, made - n, Integer::sum);
		} else if (c.smelt() != null) {
			Item input = c.picks().getFirst();
			this.need(input, n, depth + 1, up, item);
			this.needsFurnace = true;
			this.smelts += n;
			this.steps.add(new Step(Kind.SMELT, item, n, n, Map.of(input, n), false, c.smelt().recipe()));
		}
	}

	/** Fuel for every planned smelt: carried fuel the plan does not use up, else logs to gather. */
	private void fuel() {
		int ticks = this.smelts * SMELT_TICKS;
		if (ticks <= 0) {
			return;
		}
		List<Map.Entry<Item, Integer>> fuels = new ArrayList<>(this.inv.entrySet());
		fuels.sort(Comparator.comparingInt(e -> -this.book.burnTicks(e.getKey())));
		for (Map.Entry<Item, Integer> e : fuels) {
			int burn = this.book.burnTicks(e.getKey());
			if (burn <= 0 || e.getValue() <= 0 || ticks <= 0) {
				continue;
			}
			int use = Math.min(e.getValue(), (ticks + burn - 1) / burn);
			this.inv.put(e.getKey(), e.getValue() - use);
			ticks -= use * burn;
		}
		if (ticks > 0) {
			this.lack(FUEL_REF, null, (ticks + LOG_BURN_TICKS - 1) / LOG_BURN_TICKS, null);
		}
	}

	private void lack(final String ref, final @Nullable Item item, final int n, final @Nullable Item forItem) {
		Missing m = this.missing.get(ref);
		int haveNow = item == null ? 0 : this.have(item);
		this.missing.put(ref, m == null ? new Missing(ref, item, n, haveNow, forItem) : new Missing(ref, item, m.need() + n, m.have(), m.forItem()));
	}

	private int missingCount() {
		int n = 0;
		for (Missing m : this.missing.values()) {
			n += m.need();
		}
		return n;
	}

	private RecipeTree copy() {
		RecipeTree t = new RecipeTree(this.book, this.inv);
		t.missing.putAll(this.missing);
		t.needsTable = this.needsTable;
		t.needsFurnace = this.needsFurnace;
		t.smelts = this.smelts;
		return t;
	}

	/** {@code oak_log} (other namespaces keep theirs). */
	public static String id(final Item item) {
		String s = BuiltInRegistries.ITEM.getKey(item).toString();
		return s.startsWith("minecraft:") ? s.substring("minecraft:".length()) : s;
	}
}
