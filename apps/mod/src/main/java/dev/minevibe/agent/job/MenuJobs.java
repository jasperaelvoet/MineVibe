package dev.minevibe.agent.job;

import com.google.gson.JsonObject;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.skill.Refs;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/** Container and generic menu skills: {@code container}, {@code open_menu}, {@code menu_click}, {@code menu_close}. */
public final class MenuJobs {
	private MenuJobs() {
	}

	/** Walks to a block and opens its menu by using it. Shared by container, open_menu, craft and smelt. */
	static final class Opener {
		private final Walk walk = new Walk();
		private int tries;

		enum State {
			OPEN,
			WORKING,
			UNREACHABLE,
			NO_MENU
		}

		State open(final AgentPlayer agent, final BlockPos pos) {
			if (MenuView.isOpen(agent) && agent.containerMenu.stillValid(agent)) {
				return State.OPEN;
			}
			Walk.State s = this.walk.toBlock(agent, pos);
			if (s == Walk.State.MOVING) {
				return State.WORKING;
			}
			if (s == Walk.State.FAILED) {
				return State.UNREACHABLE;
			}
			agent.controls().lookAt(Vec3.atCenterOf(pos));
			boolean wasSneaking = agent.isShiftKeyDown();
			if (wasSneaking) {
				agent.controls().setSneaking(false);
			}
			agent.controls().useBlock(pos, WorldJobs.faceToward(agent, pos));
			if (MenuView.isOpen(agent)) {
				return State.OPEN;
			}
			return ++this.tries > 10 ? State.NO_MENU : State.WORKING;
		}

		void reset() {
			this.walk.reset();
		}

		Walk walk() {
			return this.walk;
		}
	}

	/** {@code container{pos, action: list|put|take, item?, count?}}: look into, fill or empty a chest (barrel, shulker...). */
	public static final class Container extends SkillJob {
		private final BlockPos pos;
		private final String action;
		private final Refs.@Nullable ItemMatcher item;
		private final int count;
		private final Opener opener = new Opener();

		public Container(final BlockPos pos, final String action, final Refs.@Nullable ItemMatcher item, final int count) {
			super("container");
			this.pos = pos;
			this.action = action;
			this.item = item;
			this.count = count;
		}

		@Override
		protected int timeoutTicks() {
			return 2 * MINUTE;
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.opener.reset();
		}

		@Override
		protected void onFinish(final AgentPlayer agent) {
			if (MenuView.isOpen(agent)) {
				agent.closeContainer();
			}
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			if (agent.level().getBlockState(this.pos).isAir()) {
				return this.fail("NOT_FOUND", "no container at " + this.pos.toShortString());
			}
			if ("take".equals(this.action)) {
				// W1: a chest the player placed is theirs; the office's own chest is the crew's shared supply.
				dev.minevibe.world.provenance.Protection.Verdict v = dev.minevibe.world.provenance.Protection.check(agent.level(), this.pos, agent.agentId());
				if (v != null && v.what() == dev.minevibe.world.provenance.Protection.What.PLAYER_BUILT) {
					return this.refuseProtected(agent, v, List.of(this.pos));
				}
			}
			if (this.ticks == 1 && MenuView.isOpen(agent)) {
				agent.closeContainer();
			}
			switch (this.opener.open(agent, this.pos)) {
				case WORKING -> {
					return Status.RUNNING;
				}
				case UNREACHABLE -> {
					return this.fail("UNREACHABLE", "cannot get within reach of " + this.pos.toShortString());
				}
				case NO_MENU -> {
					return this.fail("NOT_A_CONTAINER", Refs.blockId(agent.level().getBlockState(this.pos).getBlock()) + " has no inventory to open");
				}
				case OPEN -> {
				}
			}
			AbstractContainerMenu menu = agent.containerMenu;
			List<Integer> mine = MenuView.playerSlots(agent, menu);
			List<Integer> theirs = MenuView.containerSlots(agent, menu);
			switch (this.action) {
				case "put" -> {
					int have = Inv.count(agent, this.item);
					if (have == 0) {
						return this.fail("NO_ITEM", "no " + this.item.ref() + " in the inventory");
					}
					int want = this.count > 0 ? Math.min(this.count, have) : have;
					int moved = MenuView.transfer(agent, menu, mine, theirs, this.item, want);
					this.put("moved", moved);
					this.put("item", this.item.ref());
					if (moved < want) {
						this.put("full", true);
					}
				}
				case "take" -> {
					int there = 0;
					for (int i : theirs) {
						ItemStack s = menu.getSlot(i).getItem();
						if (this.item.test(s)) {
							there += s.getCount();
						}
					}
					if (there == 0) {
						return this.fail("NOT_FOUND", "no " + this.item.ref() + " in the container");
					}
					int want = this.count > 0 ? Math.min(this.count, there) : there;
					int moved = MenuView.transfer(agent, menu, theirs, mine, this.item, want);
					this.put("moved", moved);
					this.put("item", this.item.ref());
					if (moved < want) {
						this.put("inventoryFull", true);
					}
				}
				default -> {
				}
			}
			this.put("contents", contents(agent, menu, theirs));
			agent.closeContainer();
			return this.done();
		}
	}

	static JsonObject contents(final AgentPlayer agent, final AbstractContainerMenu menu, final List<Integer> slots) {
		Map<String, Integer> items = new TreeMap<>();
		int free = 0;
		for (int i : slots) {
			ItemStack s = menu.getSlot(i).getItem();
			if (s.isEmpty()) {
				free++;
			} else {
				items.merge(Refs.itemId(s), s.getCount(), Integer::sum);
			}
		}
		JsonObject o = new JsonObject();
		o.add("items", SkillJob.toJson(items));
		o.addProperty("freeSlots", free);
		return o;
	}

	/** {@code open_menu{pos | entity}}: open a block's or an entity's menu (villager trades, enchanting table, anvil...) and leave it open. */
	public static final class OpenMenu extends SkillJob {
		private final @Nullable BlockPos pos;
		private final @Nullable String entityRef;
		private final Opener opener = new Opener();
		private @Nullable Entity entity;
		private int tries;

		public OpenMenu(final @Nullable BlockPos pos, final @Nullable String entityRef) {
			super("open_menu");
			this.pos = pos;
			this.entityRef = entityRef;
		}

		@Override
		protected int timeoutTicks() {
			return 2 * MINUTE;
		}

		@Override
		public void onResume(final AgentPlayer agent) {
			this.opener.reset();
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			if (this.ticks == 1 && MenuView.isOpen(agent)) {
				agent.closeContainer();
			}
			if (this.pos != null) {
				return switch (this.opener.open(agent, this.pos)) {
					case WORKING -> Status.RUNNING;
					case UNREACHABLE -> this.fail("UNREACHABLE", "cannot get within reach of " + this.pos.toShortString());
					case NO_MENU -> this.fail("NO_MENU", Refs.blockId(agent.level().getBlockState(this.pos).getBlock()) + " has no menu");
					case OPEN -> this.opened(agent);
				};
			}
			if (this.entity == null || !this.entity.isAlive()) {
				this.entity = Refs.entity(agent, this.entityRef, 32.0);
				if (this.entity == null) {
					return this.fail("NOT_FOUND", "cannot find " + this.entityRef);
				}
				if (this.entity instanceof Player) {
					return this.fail("BAD_TARGET", "players have no menu to open");
				}
			}
			Walk.State s = this.opener.walk().toEntity(agent, this.entity, 2.5);
			if (s == Walk.State.MOVING) {
				return Status.RUNNING;
			}
			if (s == Walk.State.FAILED) {
				return this.fail("UNREACHABLE", "cannot reach " + this.entityRef);
			}
			agent.controls().lookAt(this.entity);
			agent.interactOn(this.entity, InteractionHand.MAIN_HAND, this.entity.position().add(0.0, this.entity.getBbHeight() / 2.0, 0.0));
			if (MenuView.isOpen(agent)) {
				return this.opened(agent);
			}
			return ++this.tries > 10 ? this.fail("NO_MENU", this.entityRef + " offers no menu (a villager without a profession, or busy)") : Status.RUNNING;
		}

		private Status opened(final AgentPlayer agent) {
			if (this.pos != null) {
				OPENED_AT.put(agent.agentId(), new OpenedAt(agent.containerMenu, this.pos.immutable()));
			}
			JsonObject snapshot = MenuView.snapshot(agent);
			for (String key : snapshot.keySet()) {
				this.result.add(key, snapshot.get(key));
			}
			return this.done();
		}
	}

	/** {@code menu_click{slot, button, type}}: one click in the open menu, exactly as a player's click packet. */
	public static final class MenuClick extends SkillJob {
		private final int slot;
		private final int button;
		private final ContainerInput input;

		public MenuClick(final int slot, final int button, final ContainerInput input) {
			super("menu_click");
			this.slot = slot;
			this.button = button;
			this.input = input;
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			Status refused = this.guardPlayerContainer(agent);
			if (refused != null) {
				return refused;
			}
			String error = MenuView.click(agent, this.slot, this.button, this.input);
			if (error != null) {
				return this.fail("BAD_CLICK", error);
			}
			JsonObject snapshot = MenuView.snapshot(agent);
			for (String key : snapshot.keySet()) {
				this.result.add(key, snapshot.get(key));
			}
			return this.done();
		}

		/**
		 * W1: in the menu of a chest the player placed (opened with {@code open_menu{pos}}), clicks on the chest's own
		 * slots and "collect all" would take the player's things: refused. Putting things in stays allowed.
		 */
		private @Nullable Status guardPlayerContainer(final AgentPlayer agent) {
			OpenedAt at = OPENED_AT.get(agent.agentId());
			AbstractContainerMenu menu = agent.containerMenu;
			if (at == null || at.menu() != menu || menu == agent.inventoryMenu
				|| !(agent.level().getBlockEntity(at.pos()) instanceof net.minecraft.world.Container)) {
				return null;
			}
			boolean takes = this.input == ContainerInput.PICKUP_ALL
				|| this.slot >= 0 && this.slot < menu.slots.size() && menu.getSlot(this.slot).container != agent.getInventory();
			if (!takes) {
				return null;
			}
			dev.minevibe.world.provenance.Protection.Verdict v = dev.minevibe.world.provenance.Protection.check(agent.level(), at.pos(), agent.agentId());
			if (v != null && v.what() == dev.minevibe.world.provenance.Protection.What.PLAYER_BUILT) {
				return this.refuseProtected(agent, v, List.of(at.pos()));
			}
			return null;
		}
	}

	/** The menu an agent opened with {@code open_menu{pos}}, and where (W1 container guard). */
	record OpenedAt(AbstractContainerMenu menu, BlockPos pos) {
	}

	private static final Map<String, OpenedAt> OPENED_AT = new java.util.concurrent.ConcurrentHashMap<>();

	/** {@code menu_close{}}: close the open menu; items left in crafting grids go back to the inventory. */
	public static final class MenuClose extends SkillJob {
		public MenuClose() {
			super("menu_close");
		}

		@Override
		public boolean worksSeated() {
			return true;
		}

		@Override
		protected Status step(final AgentPlayer agent) {
			boolean open = MenuView.isOpen(agent);
			if (open) {
				agent.closeContainer();
			}
			this.put("closed", open);
			return this.done();
		}
	}
}
