package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.skill.Refs;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.AbstractCraftingMenu;
import net.minecraft.world.inventory.AbstractFurnaceMenu;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.inventory.CraftingMenu;
import net.minecraft.world.inventory.InventoryMenu;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.crafting.AbstractCookingRecipe;
import net.minecraft.world.item.crafting.CraftingRecipe;
import net.minecraft.world.item.crafting.RecipeHolder;
import net.minecraft.world.level.block.AbstractFurnaceBlock;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import org.jspecify.annotations.Nullable;

/** {@code craft} (a real CraftingMenu, filled by the server's recipe placement) and {@code smelt} (a real furnace). */
public final class CraftJobs {
	private CraftJobs() {
	}

	/**
	 * {@code craft{item, count, table?}}: makes {@code count} of an item. Recipes that fit 2x2 use the agent's own
	 * inventory grid; bigger ones use the given or the nearest crafting table, and a table from the inventory is placed
	 * next to the agent when there is none. Every craft goes through {@code RecipeBookMenu#handlePlacement} (the path
	 * of a recipe-book click) and a shift-click on the result slot, so it obeys every vanilla rule.
	 */
	public static final class Craft extends SkillJob {
		private enum Phase { PLAN, TABLE, OPEN, CRAFT }

		private final Item item;
		private final int count;
		private final @Nullable BlockPos requestedTable;
		private final MenuJobs.Opener opener = new MenuJobs.Opener();
		private final Walk walk = new Walk();
		private Phase phase = Phase.PLAN;
		private @Nullable RecipeHolder<CraftingRecipe> recipe;
		private @Nullable BlockPos table;
		private @Nullable BlockPos placing;
		private boolean placedTable;
		/** A table found nearby could not be reached: the next one is the agent's own. */
		private boolean ownTableOnly;
		private int crafted;
		private int placeTries;

		public Craft(final Item item, final int count, final @Nullable BlockPos table) {
			super("craft");
			this.item = item;
			this.count = count;
			this.requestedTable = table;
		}

		@Override
		protected int timeoutTicks() {
			return 3 * MINUTE;
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.opener.reset();
			this.walk.reset();
			if (this.phase == Phase.CRAFT && this.table != null) {
				this.phase = Phase.OPEN;
			}
		}

		@Override
		protected void onFinish(final AgentPlayer agent) {
			if (MenuView.isOpen(agent)) {
				agent.closeContainer();
			}
			clearGrid(agent, agent.inventoryMenu);
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			ServerLevel level = agent.level();
			switch (this.phase) {
				case PLAN -> {
					if (MenuView.isOpen(agent)) {
						agent.closeContainer();
					}
					List<RecipeHolder<CraftingRecipe>> recipes = Recipes.crafting(level, this.item);
					if (recipes.isEmpty()) {
						return this.fail("NO_RECIPE", "nothing crafts " + Refs.itemId(this.item));
					}
					for (RecipeHolder<CraftingRecipe> r : recipes) {
						if (Recipes.craftable(agent, r.value(), 1) > 0) {
							this.recipe = r;
							break;
						}
					}
					if (this.recipe == null) {
						this.put("ingredients", missing(agent, recipes.getFirst()));
						return this.fail("MISSING_INGREDIENTS", "missing ingredients for " + Refs.itemId(this.item) + ": " + missingText(agent, recipes.getFirst()));
					}
					this.put("recipe", this.recipe.id().identifier().toString());
					this.phase = Recipes.fits2x2(this.recipe.value()) && this.requestedTable == null ? Phase.CRAFT : Phase.TABLE;
					return Status.RUNNING;
				}
				case TABLE -> {
					return this.findTable(agent);
				}
				case OPEN -> {
					return switch (this.opener.open(agent, this.table)) {
						case WORKING -> Status.RUNNING;
						case UNREACHABLE -> {
							if (!this.placedTable && !this.ownTableOnly && this.requestedTable == null && Inv.count(agent, Items.CRAFTING_TABLE) > 0) {
								// A table seen behind a wall or up a cliff: put down the one in the bag instead.
								this.ownTableOnly = true;
								this.table = null;
								this.opener.reset();
								this.walk.reset();
								this.phase = Phase.TABLE;
								yield Status.RUNNING;
							}
							yield this.fail("UNREACHABLE", "cannot reach the crafting table at " + this.table.toShortString());
						}
						case NO_MENU -> this.fail("NO_TABLE", "the crafting table at " + this.table.toShortString() + " did not open");
						case OPEN -> {
							if (!(agent.containerMenu instanceof CraftingMenu)) {
								yield this.fail("NO_TABLE", "the block at " + this.table.toShortString() + " is not a crafting table");
							}
							this.phase = Phase.CRAFT;
							yield Status.RUNNING;
						}
					};
				}
				case CRAFT -> {
					return this.craftOnce(agent);
				}
			}
			return Status.RUNNING;
		}

		private Status findTable(final AgentPlayer agent) {
			ServerLevel level = agent.level();
			if (this.table == null) {
				if (this.requestedTable != null) {
					if (!level.getBlockState(this.requestedTable).is(Blocks.CRAFTING_TABLE)) {
						return this.fail("NO_TABLE", "no crafting table at " + this.requestedTable.toShortString());
					}
					this.table = this.requestedTable;
				} else if (!this.ownTableOnly) {
					List<BlockPos> tables = BlockScan.nearest(level, agent.blockPosition(), 24, s -> s.is(Blocks.CRAFTING_TABLE), p -> true, 1);
					if (!tables.isEmpty()) {
						this.table = tables.getFirst();
					}
				}
			}
			if (this.table != null) {
				this.phase = Phase.OPEN;
				return Status.RUNNING;
			}
			// Place one from the inventory, next to the agent.
			if (Inv.count(agent, Items.CRAFTING_TABLE) == 0) {
				return this.fail("NEEDS_TABLE", Refs.itemId(this.item) + " needs a crafting table: craft one (4 planks) or stand near one");
			}
			if (this.placing == null) {
				this.placing = freeSpotNear(agent);
				if (this.placing == null) {
					return this.fail("NO_ROOM", "no free spot next to the agent to put a crafting table");
				}
			}
			BlockOps.Place r = BlockOps.placeTick(agent, this.placing, s -> s.is(Items.CRAFTING_TABLE));
			switch (r) {
				case PLACED -> {
					this.table = this.placing;
					this.placedTable = true;
					this.put("placedTable", SkillJob.pos(this.table));
					this.phase = Phase.OPEN;
				}
				case RETRY, ENTITY_IN_WAY, SELF_IN_WAY -> {
					if (r == BlockOps.Place.SELF_IN_WAY) {
						WorldJobs.stepAside(agent, this.placing, this.walk);
					}
					if (++this.placeTries > 60) {
						this.placing = null;
						this.placeTries = 0;
					}
				}
				default -> {
					this.placing = null;
					if (++this.placeTries > 100) {
						return this.fail("NO_ROOM", "could not put the crafting table down (" + r + ")");
					}
				}
			}
			return Status.RUNNING;
		}

		private Status craftOnce(final AgentPlayer agent) {
			AbstractContainerMenu open = agent.containerMenu;
			AbstractCraftingMenu menu;
			if (this.table != null) {
				if (!(open instanceof CraftingMenu crafting) || !open.stillValid(agent)) {
					this.phase = Phase.OPEN;
					return Status.RUNNING;
				}
				menu = crafting;
			} else {
				menu = agent.inventoryMenu;
			}
			if (this.crafted >= this.count) {
				return this.finish(agent);
			}
			menu.handlePlacement(false, false, this.recipe, agent.level(), agent.getInventory());
			int resultSlot = menu.slots.indexOf(menu.getResultSlot());
			ItemStack out = menu.getResultSlot().getItem();
			if (out.isEmpty() || !out.is(this.item)) {
				clearGrid(agent, menu);
				if (this.crafted == 0) {
					this.put("ingredients", missing(agent, this.recipe));
					return this.fail("MISSING_INGREDIENTS", "missing ingredients for " + Refs.itemId(this.item) + ": " + missingText(agent, this.recipe));
				}
				this.put("short", true);
				return this.finish(agent);
			}
			int got = MenuView.takeAll(agent, menu, resultSlot);
			if (got <= 0) {
				clearGrid(agent, menu);
				return this.fail("INVENTORY_FULL", "no room for " + Refs.itemId(this.item));
			}
			this.crafted += got;
			this.progress((double)Math.min(this.crafted, this.count) / this.count, this.crafted + "/" + this.count + " " + Refs.itemId(this.item).replace("minecraft:", ""));
			return Status.RUNNING;
		}

		private Status finish(final AgentPlayer agent) {
			if (this.table != null) {
				agent.closeContainer();
				this.put("table", SkillJob.pos(this.table));
			} else {
				clearGrid(agent, agent.inventoryMenu);
			}
			this.put("crafted", this.crafted);
			this.put("item", Refs.itemId(this.item));
			this.put("have", Inv.count(agent, this.item));
			return this.done();
		}
	}

	/**
	 * Shift-clicks whatever is left in a crafting grid back into the inventory. The agent's own 2x2 grid is never closed
	 * (and never saved), so what does not fit there is dropped at its feet rather than lost; a table's grid goes back
	 * when its menu closes.
	 */
	static void clearGrid(final AgentPlayer agent, final AbstractCraftingMenu menu) {
		for (var slot : menu.getInputGridSlots()) {
			if (slot.hasItem()) {
				menu.clicked(menu.slots.indexOf(slot), 0, ContainerInput.QUICK_MOVE, agent);
			}
		}
		if (menu instanceof InventoryMenu) {
			for (var slot : menu.getInputGridSlots()) {
				if (slot.hasItem()) {
					ItemStack rest = slot.getItem();
					slot.set(ItemStack.EMPTY);
					agent.getInventory().placeItemBackInInventory(rest, net.minecraft.util.Prediction.SERVER_ONLY);
				}
			}
			if (!menu.getCarried().isEmpty()) {
				ItemStack rest = menu.getCarried();
				menu.setCarried(ItemStack.EMPTY);
				agent.getInventory().placeItemBackInInventory(rest, net.minecraft.util.Prediction.SERVER_ONLY);
			}
		}
	}

	static Map<String, int[]> missing(final AgentPlayer agent, final RecipeHolder<CraftingRecipe> recipe) {
		return Recipes.ingredients(agent, recipe.value());
	}

	static String missingText(final AgentPlayer agent, final RecipeHolder<CraftingRecipe> recipe) {
		List<String> parts = new ArrayList<>();
		for (Map.Entry<String, int[]> e : Recipes.ingredients(agent, recipe.value()).entrySet()) {
			if (e.getValue()[1] < e.getValue()[0]) {
				parts.add(e.getKey() + " (need " + e.getValue()[0] + ", have " + e.getValue()[1] + ")");
			}
		}
		return parts.isEmpty() ? "the right mix" : String.join(", ", parts);
	}

	/** A replaceable spot with a solid floor next to the agent (not where it stands), or null. */
	static @Nullable BlockPos freeSpotNear(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		BlockPos feet = agent.blockPosition();
		for (int r = 1; r <= 2; r++) {
			for (Direction d : Direction.Plane.HORIZONTAL) {
				for (int dy = 0; dy >= -1; dy--) {
					BlockPos p = feet.relative(d, r).above(dy);
					BlockState s = level.getBlockState(p);
					if (s.canBeReplaced() && s.getFluidState().isEmpty() && !level.getBlockState(p.below()).canBeReplaced()
						&& !agent.getBoundingBox().intersects(new AABB(p)) && level.getEntities(agent, new AABB(p), e -> e.blocksBuilding).isEmpty()) {
						return p;
					}
				}
			}
		}
		return null;
	}

	/**
	 * {@code smelt{item, count, fuel?, furnace?}}: smelts {@code count} items in a furnace (the given, the nearest, or one
	 * placed from the inventory). {@code item} is what to put in ({@code raw_iron}) or what to get out ({@code
	 * iron_ingot}). The agent loads the furnace through its menu, waits nearby, and takes the output.
	 */
	public static final class Smelt extends SkillJob {
		private enum Phase { PLAN, FURNACE, LOAD, WAIT, TAKE }

		private final Refs.ItemMatcher item;
		private final int count;
		private final Refs.@Nullable ItemMatcher fuel;
		/** The craft tree's planned fuel (any of these), when no {@code fuel} is given. */
		private java.util.@Nullable Set<Item> fuels;
		private final @Nullable BlockPos requestedFurnace;
		private final MenuJobs.Opener opener = new MenuJobs.Opener();
		private final Walk walk = new Walk();
		private Phase phase = Phase.PLAN;
		private @Nullable ItemStack input;
		private @Nullable Item output;
		private int toSmelt;
		private @Nullable BlockPos furnace;
		private @Nullable BlockPos placing;
		private int placeTries;
		private boolean outOfFuel;
		private int beforeOutput;

		public Smelt(final Refs.ItemMatcher item, final int count, final Refs.@Nullable ItemMatcher fuel, final @Nullable BlockPos furnace) {
			super("smelt");
			this.item = item;
			this.count = count;
			this.fuel = fuel;
			this.requestedFurnace = furnace;
		}

		/**
		 * A smelt for the craft tree (tools-v2-mc.md M4): it burns only {@code fuels}, the fuel the plan set aside, so the
		 * logs a later step turns into planks stay in the bag. Empty: any fuel.
		 */
		public static Smelt withFuel(final Refs.ItemMatcher item, final int count, final java.util.Set<Item> fuels) {
			Smelt s = new Smelt(item, count, null, null);
			s.fuels = fuels.isEmpty() ? null : java.util.Set.copyOf(fuels);
			return s;
		}

		@Override
		protected int timeoutTicks() {
			return Math.min(30 * MINUTE, 2 * MINUTE + this.count * 12 * SECOND);
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.opener.reset();
			this.walk.reset();
		}

		@Override
		protected void onFinish(final AgentPlayer agent) {
			if (MenuView.isOpen(agent)) {
				agent.closeContainer();
			}
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			ServerLevel level = agent.level();
			switch (this.phase) {
				case PLAN -> {
					return this.plan(agent);
				}
				case FURNACE -> {
					return this.findFurnace(agent);
				}
				case LOAD -> {
					return this.load(agent);
				}
				case WAIT -> {
					if (!(level.getBlockEntity(this.furnace) instanceof AbstractFurnaceBlockEntity be)) {
						return this.fail("NO_FURNACE", "the furnace at " + this.furnace.toShortString() + " is gone");
					}
					Container c = be;
					int out = c.getItem(2).is(this.output) ? c.getItem(2).getCount() : 0;
					this.progress((double)Math.min(out, this.toSmelt) / this.toSmelt, out + "/" + this.toSmelt + " " + Refs.itemId(this.output).replace("minecraft:", ""));
					boolean lit = level.getBlockState(this.furnace).getValue(AbstractFurnaceBlock.LIT);
					boolean inputLeft = !c.getItem(0).isEmpty();
					if (out >= this.toSmelt || !inputLeft && !lit) {
						this.phase = Phase.TAKE;
						return Status.RUNNING;
					}
					if (inputLeft && !lit && c.getItem(1).isEmpty()) {
						this.outOfFuel = true;
						this.phase = Phase.TAKE;
						return Status.RUNNING;
					}
					// Stay close (a few blocks) while it cooks.
					if (agent.position().distanceTo(net.minecraft.world.phys.Vec3.atCenterOf(this.furnace)) > 5.0) {
						this.walk.to(agent, net.minecraft.world.phys.Vec3.atBottomCenterOf(this.furnace), 3.0);
					} else {
						this.walk.stop(agent);
					}
					return Status.RUNNING;
				}
				case TAKE -> {
					return switch (this.opener.open(agent, this.furnace)) {
						case WORKING -> Status.RUNNING;
						case UNREACHABLE -> this.fail("UNREACHABLE", "cannot reach the furnace at " + this.furnace.toShortString());
						case NO_MENU -> this.fail("NO_FURNACE", "the furnace at " + this.furnace.toShortString() + " did not open");
						case OPEN -> {
							AbstractContainerMenu menu = agent.containerMenu;
							MenuView.takeAll(agent, menu, AbstractFurnaceMenu.RESULT_SLOT);
							agent.closeContainer();
							int smelted = Math.max(0, Inv.count(agent, this.output) - this.beforeOutput);
							this.put("smelted", smelted);
							this.put("item", Refs.itemId(this.output));
							this.put("furnace", SkillJob.pos(this.furnace));
							if (this.outOfFuel && smelted < this.toSmelt) {
								yield this.fail("NO_FUEL", "the fuel ran out after " + smelted + " of " + this.toSmelt);
							}
							yield this.done();
						}
					};
				}
			}
			return Status.RUNNING;
		}

		private Status plan(final AgentPlayer agent) {
			ServerLevel level = agent.level();
			if (MenuView.isOpen(agent)) {
				agent.closeContainer();
			}
			// The item as input?
			int slot = Inv.find(agent, s -> this.item.test(s) && Recipes.smeltingFrom(level, s).isPresent());
			if (slot >= 0) {
				this.input = agent.getInventory().getItem(slot).copyWithCount(1);
			} else if (this.item.item() != null) {
				// The item as output: find an input the agent has.
				for (RecipeHolder<AbstractCookingRecipe> r : Recipes.smeltingTo(level, this.item.item())) {
					int s = Inv.find(agent, r.value().input());
					if (s >= 0) {
						this.input = agent.getInventory().getItem(s).copyWithCount(1);
						break;
					}
				}
				if (this.input == null && Recipes.smeltingTo(level, this.item.item()).isEmpty()
					&& Recipes.smeltingFrom(level, new ItemStack(this.item.item())).isEmpty()) {
					return this.fail("NO_RECIPE", Refs.itemId(this.item.item()) + " cannot be smelted");
				}
			}
			if (this.input == null) {
				return this.fail("NO_ITEM", "nothing to smelt for " + this.item.ref() + " in the inventory");
			}
			ItemStack proto = this.input;
			this.output = Recipes.result(level, Recipes.smeltingFrom(level, proto).orElseThrow().value()).getItem();
			int have = Inv.count(agent, s -> ItemStack.isSameItemSameComponents(s, proto));
			this.toSmelt = Math.min(this.count, have);
			if (this.toSmelt < this.count) {
				this.put("note", "only " + have + " " + Refs.itemId(proto) + " to smelt");
			}
			this.beforeOutput = Inv.count(agent, this.output);
			this.phase = Phase.FURNACE;
			return Status.RUNNING;
		}

		private Status findFurnace(final AgentPlayer agent) {
			ServerLevel level = agent.level();
			if (this.requestedFurnace != null) {
				if (!(level.getBlockState(this.requestedFurnace).getBlock() instanceof AbstractFurnaceBlock)) {
					return this.fail("NO_FURNACE", "no furnace at " + this.requestedFurnace.toShortString());
				}
				this.furnace = this.requestedFurnace;
			} else if (this.furnace == null) {
				List<BlockPos> found = BlockScan.nearest(level, agent.blockPosition(), 24, s -> s.is(Blocks.FURNACE), p -> true, 1);
				if (!found.isEmpty()) {
					this.furnace = found.getFirst();
				}
			}
			if (this.furnace != null) {
				this.phase = Phase.LOAD;
				return Status.RUNNING;
			}
			if (Inv.count(agent, Items.FURNACE) == 0) {
				return this.fail("NEEDS_FURNACE", "no furnace nearby: craft one (8 cobblestone) or stand near one");
			}
			if (this.placing == null) {
				this.placing = freeSpotNear(agent);
				if (this.placing == null) {
					return this.fail("NO_ROOM", "no free spot next to the agent to put a furnace");
				}
			}
			BlockOps.Place r = BlockOps.placeTick(agent, this.placing, s -> s.is(Items.FURNACE));
			if (r == BlockOps.Place.PLACED) {
				this.furnace = this.placing;
				this.put("placedFurnace", SkillJob.pos(this.furnace));
				this.phase = Phase.LOAD;
			} else if (r == BlockOps.Place.SELF_IN_WAY) {
				WorldJobs.stepAside(agent, this.placing, this.walk);
			} else if (++this.placeTries > 60) {
				this.placing = null;
				if (this.placeTries > 200) {
					return this.fail("NO_ROOM", "could not put the furnace down (" + r + ")");
				}
			}
			return Status.RUNNING;
		}

		private Status load(final AgentPlayer agent) {
			switch (this.opener.open(agent, this.furnace)) {
				case WORKING -> {
					return Status.RUNNING;
				}
				case UNREACHABLE -> {
					return this.fail("UNREACHABLE", "cannot reach the furnace at " + this.furnace.toShortString());
				}
				case NO_MENU -> {
					return this.fail("NO_FURNACE", "the furnace at " + this.furnace.toShortString() + " did not open");
				}
				case OPEN -> {
				}
			}
			if (!(agent.containerMenu instanceof AbstractFurnaceMenu menu)) {
				return this.fail("NO_FURNACE", "not a furnace at " + this.furnace.toShortString());
			}
			ItemStack proto = this.input;
			List<Integer> mine = MenuView.playerSlots(agent, menu);
			// Clear an output slot that holds something else, or the furnace would stall.
			ItemStack inOut = menu.getSlot(AbstractFurnaceMenu.RESULT_SLOT).getItem();
			if (!inOut.isEmpty() && !inOut.is(this.output)) {
				MenuView.takeAll(agent, menu, AbstractFurnaceMenu.RESULT_SLOT);
			}
			ItemStack inSlot = menu.getSlot(AbstractFurnaceMenu.INGREDIENT_SLOT).getItem();
			if (!inSlot.isEmpty() && !ItemStack.isSameItemSameComponents(inSlot, proto)) {
				agent.closeContainer();
				return this.fail("FURNACE_BUSY", "the furnace is smelting " + Refs.itemId(inSlot) + " already");
			}
			// Fuel first: without enough of it, nothing is loaded (the input would otherwise sit in an unlit furnace).
			int batch = inSlot.isEmpty() ? this.toSmelt : Math.min(inSlot.getCount() + this.toSmelt, proto.getMaxStackSize());
			ItemStack fuelThere = menu.getSlot(AbstractFurnaceMenu.FUEL_SLOT).getItem();
			java.util.Set<Item> planned = this.fuels;
			java.util.function.Predicate<ItemStack> isFuel = s -> (this.fuel != null ? this.fuel.test(s)
				: Recipes.burnTicks(s) > 0 && !ItemStack.isSameItemSameComponents(s, proto) && (planned == null || planned.contains(s.getItem())))
				&& (fuelThere.isEmpty() || ItemStack.isSameItemSameComponents(s, fuelThere));
			int burnLeft = menu.isLit() ? 200 : 0;
			burnLeft += Recipes.burnTicks(fuelThere) * fuelThere.getCount();
			int needTicks = batch * 200 - burnLeft;
			if (needTicks > 0 && Inv.find(agent, isFuel) < 0) {
				agent.closeContainer();
				return this.fail("NO_FUEL", this.fuel != null ? "no " + this.fuel.ref() + " in the inventory"
					: planned != null ? "none of the planned fuel (" + planned.stream().map(Refs::itemId).sorted().collect(java.util.stream.Collectors.joining(", ")) + ") in the inventory"
					: "no fuel (coal, charcoal, logs, planks...) in the inventory");
			}
			int loaded = MenuView.transfer(agent, menu, mine, List.of(AbstractFurnaceMenu.INGREDIENT_SLOT), s -> ItemStack.isSameItemSameComponents(s, proto), this.toSmelt);
			if (loaded <= 0 && inSlot.isEmpty()) {
				agent.closeContainer();
				return this.fail("NO_ITEM", "could not put " + Refs.itemId(proto) + " in the furnace");
			}
			this.toSmelt = loaded > 0 ? loaded : inSlot.getCount();
			// Fuel: enough for the whole batch (looked up again: loading may have used the stack it found).
			needTicks = this.toSmelt * 200 - burnLeft;
			int fuelSlot = Inv.find(agent, isFuel);
			if (needTicks > 0 && fuelSlot < 0) {
				this.outOfFuel = true;
			} else if (needTicks > 0) {
				ItemStack fuelProto = agent.getInventory().getItem(fuelSlot).copyWithCount(1);
				int per = Math.max(1, Recipes.burnTicks(fuelProto));
				int fuelCount = (needTicks + per - 1) / per;
				MenuView.transfer(agent, menu, mine, List.of(AbstractFurnaceMenu.FUEL_SLOT), s -> ItemStack.isSameItemSameComponents(s, fuelProto), fuelCount);
				this.put("fuel", Refs.itemId(fuelProto));
			}
			agent.closeContainer();
			this.phase = Phase.WAIT;
			return Status.RUNNING;
		}
	}
}
