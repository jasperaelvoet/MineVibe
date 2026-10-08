package dev.minevibe.agent.job;

import dev.minevibe.agent.AgentPlayer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.EntityBlock;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * {@code build{blueprint, origin, rotation?}}: builds one of the simple built-in blueprints at {@code origin} (the
 * agent's floor level), block by block like a player: {@code shelter} (5x5 hut with a door gap and a roof),
 * {@code wall_ring} (9x9 ring, 2 high), {@code torch_ring} (8 torches 5 blocks out), {@code bridge} (8 blocks straight
 * ahead at foot level), {@code stairs_down} (an 8-step staircase dug downwards) and {@code farm_plot} (9x9 field with a
 * water source in the middle, tilled and planted). Walls take any plain building block in the inventory (dirt,
 * cobblestone, planks...). At rotation 0 "ahead" is south (+Z) and a shelter's door faces north; rotations turn
 * clockwise seen from above.
 */
public final class BuildJob extends SkillJob {
	public static final List<String> BLUEPRINTS = List.of("shelter", "wall_ring", "torch_ring", "bridge", "stairs_down", "farm_plot");

	enum Kind { SOLID, TORCH, CLEAR, WATER }

	record Step(Kind kind, BlockPos pos) {
	}

	private final String blueprint;
	private final BlockPos origin;
	private final int rotation;
	private final List<Step> steps = new ArrayList<>();
	private final Walk walk = new Walk();
	private int index;
	private int stepTicks;
	private int requeued;
	private int placed;
	private int dug;
	private int skipped;
	private @Nullable FarmJob farm;

	public BuildJob(final String blueprint, final BlockPos origin, final int rotation) {
		super("build");
		this.blueprint = blueprint;
		this.origin = origin;
		this.rotation = ((rotation % 360) + 360) % 360;
	}

	@Override
	protected int timeoutTicks() {
		return 20 * MINUTE;
	}

	@Override
	public void onResume(final AgentPlayer agent) {
		this.walk.reset();
	}

	/** Rotates (x, z) clockwise around the origin. */
	BlockPos at(final int x, final int y, final int z) {
		return switch (this.rotation) {
			case 90 -> this.origin.offset(-z, y, x);
			case 180 -> this.origin.offset(-x, y, -z);
			case 270 -> this.origin.offset(z, y, -x);
			default -> this.origin.offset(x, y, z);
		};
	}

	/** The blueprint's steps, in build order. */
	List<Step> plan(final ServerLevel level) {
		List<Step> out = new ArrayList<>();
		switch (this.blueprint) {
			case "shelter" -> {
				for (int y = 0; y <= 2; y++) {
					for (int x = -2; x <= 2; x++) {
						for (int z = -2; z <= 2; z++) {
							boolean wall = Math.abs(x) == 2 || Math.abs(z) == 2;
							boolean door = x == 0 && z == -2 && y <= 1;
							if (wall && !door) {
								out.add(new Step(Kind.SOLID, this.at(x, y, z)));
							} else if (!wall || door) {
								out.add(new Step(Kind.CLEAR, this.at(x, y, z)));
							}
						}
					}
				}
				List<Step> roof = new ArrayList<>();
				for (int x = -2; x <= 2; x++) {
					for (int z = -2; z <= 2; z++) {
						roof.add(new Step(Kind.SOLID, this.at(x, 3, z)));
					}
				}
				// Edges first: each roof block then rests against a wall or a roof block placed before it.
				roof.sort(Comparator.comparingInt(s -> -Math.max(Math.abs(s.pos().getX() - this.origin.getX()), Math.abs(s.pos().getZ() - this.origin.getZ()))));
				out.addAll(roof);
				out.add(new Step(Kind.TORCH, this.at(1, 0, 1)));
				// Clear the inside before building walls, so the agent never walls itself in.
				out.sort(Comparator.comparingInt(s -> s.kind() == Kind.CLEAR ? 0 : 1));
			}
			case "wall_ring" -> {
				for (int y = 0; y <= 1; y++) {
					for (int x = -4; x <= 4; x++) {
						for (int z = -4; z <= 4; z++) {
							if (Math.abs(x) == 4 || Math.abs(z) == 4) {
								out.add(new Step(Kind.SOLID, this.at(x, y, z)));
							}
						}
					}
				}
			}
			case "torch_ring" -> {
				int[][] ring = {{5, 0}, {4, 4}, {0, 5}, {-4, 4}, {-5, 0}, {-4, -4}, {0, -5}, {4, -4}};
				for (int[] p : ring) {
					out.add(new Step(Kind.TORCH, ground(level, this.at(p[0], 0, p[1]))));
				}
			}
			case "bridge" -> {
				for (int i = 1; i <= 8; i++) {
					out.add(new Step(Kind.SOLID, this.at(0, -1, i)));
				}
			}
			case "stairs_down" -> {
				for (int i = 1; i <= 8; i++) {
					out.add(new Step(Kind.CLEAR, this.at(0, -i + 2, i)));
					out.add(new Step(Kind.CLEAR, this.at(0, -i + 1, i)));
					out.add(new Step(Kind.CLEAR, this.at(0, -i, i)));
					out.add(new Step(Kind.SOLID, this.at(0, -i - 1, i)));
				}
			}
			case "farm_plot" -> {
				out.add(new Step(Kind.CLEAR, this.at(0, -1, 0)));
				out.add(new Step(Kind.WATER, this.at(0, -1, 0)));
			}
			default -> {
			}
		}
		return out;
	}

	/** The air block on top of the ground at a column (searching 4 up and 4 down). */
	private static BlockPos ground(final ServerLevel level, final BlockPos p) {
		for (int dy = 4; dy >= -4; dy--) {
			BlockPos q = p.above(dy);
			if (level.getBlockState(q).canBeReplaced() && !level.getBlockState(q.below()).canBeReplaced()) {
				return q;
			}
		}
		return p;
	}

	/** Plain full blocks to build walls from, cheapest first. */
	public static boolean isBuildingBlock(final ItemStack stack) {
		if (!(stack.getItem() instanceof BlockItem bi)) {
			return false;
		}
		Block b = bi.getBlock();
		BlockState s = b.defaultBlockState();
		return s.isCollisionShapeFullBlock(net.minecraft.world.level.EmptyBlockGetter.INSTANCE, BlockPos.ZERO) && !(b instanceof EntityBlock)
			&& !(b instanceof FallingBlock) && !s.hasProperty(net.minecraft.world.level.block.state.properties.BlockStateProperties.AXIS)
			&& !stack.is(Items.TNT) && !s.is(net.minecraft.tags.BlockTags.LEAVES) && !stack.is(Items.CRAFTING_TABLE);
	}

	private static Predicate<ItemStack> material(final Kind kind) {
		return switch (kind) {
			case SOLID -> BuildJob::isBuildingBlock;
			case TORCH -> s -> s.is(Items.TORCH);
			case WATER -> s -> s.is(Items.WATER_BUCKET);
			case CLEAR -> s -> false;
		};
	}

	@Override
	public void start(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		this.steps.clear();
		this.steps.addAll(this.plan(level));
	}

	@Override
	protected Status step(final AgentPlayer agent) {
		ServerLevel level = agent.level();
		if (this.ticks == 1) {
			Status pre = this.precheck(agent);
			if (pre != null) {
				return pre;
			}
		}
		if (this.farm != null) {
			Status s = this.farm.step(agent);
			if (s != Status.RUNNING) {
				for (String key : this.farm.result().keySet()) {
					this.result.add(key, this.farm.result().get(key));
				}
				return this.finish();
			}
			return Status.RUNNING;
		}
		while (this.index < this.steps.size() && this.satisfied(level, this.steps.get(this.index))) {
			// A held attack breaks its block after the step that hit it; count it when it turns up gone.
			if (this.steps.get(this.index).kind() == Kind.CLEAR && this.stepTicks > 0) {
				this.dug++;
			}
			this.index++;
			this.stepTicks = 0;
		}
		if (this.index >= this.steps.size()) {
			if ("farm_plot".equals(this.blueprint)) {
				this.farm = new FarmJob(this.at(-4, -1, -4), this.at(4, -1, 4), null);
				return Status.RUNNING;
			}
			return this.finish();
		}
		Step step = this.steps.get(this.index);
		this.progress((double)this.index / this.steps.size(), this.blueprint + ": step " + (this.index + 1) + "/" + this.steps.size());
		Walk.State s = this.walk.toBlock(agent, step.pos());
		if (s == Walk.State.MOVING) {
			return Status.RUNNING;
		}
		if (s == Walk.State.FAILED || ++this.stepTicks > 20 * SECOND) {
			this.defer(step);
			return Status.RUNNING;
		}
		switch (step.kind()) {
			case CLEAR -> {
				if (BlockOps.unbreakable(level, step.pos())) {
					this.skip();
				} else if (BlockOps.mineTick(agent, step.pos())) {
					this.dug++;
				}
			}
			case SOLID, TORCH -> {
				BlockOps.Place r = BlockOps.placeTick(agent, step.pos(), material(step.kind()));
				switch (r) {
					case PLACED -> this.placed++;
					case NO_ITEM -> {
						return this.finishShort("NO_MATERIAL", step.kind() == Kind.TORCH ? "out of torches" : "out of building blocks");
					}
					case SELF_IN_WAY -> WorldJobs.stepAside(agent, step.pos(), this.walk);
					case NO_SUPPORT, OCCUPIED -> this.defer(step);
					default -> {
					}
				}
			}
			case WATER -> {
				if (!Inv.equip(agent, material(Kind.WATER))) {
					this.skip();
					return Status.RUNNING;
				}
				BlockPos floor = step.pos().below();
				agent.controls().lookAt(Vec3.atCenterOf(floor).add(0.0, 0.5, 0.0));
				agent.controls().useBlock(floor, Direction.UP);
				if (agent.getMainHandItem().is(Items.WATER_BUCKET)) {
					agent.controls().useItem(InteractionHand.MAIN_HAND);
				}
				if (!agent.getMainHandItem().is(Items.WATER_BUCKET)) {
					this.placed++;
					this.index++;
				}
			}
		}
		return Status.RUNNING;
	}

	private @Nullable Status precheck(final AgentPlayer agent) {
		int solids = 0;
		int torches = 0;
		for (Step st : this.steps) {
			if (!this.satisfied(agent.level(), st)) {
				if (st.kind() == Kind.SOLID) {
					solids++;
				} else if (st.kind() == Kind.TORCH) {
					torches++;
				}
			}
		}
		// W1: digging out or building over player-built or Base blocks needs the player's consent.
		List<BlockPos> prot = new ArrayList<>();
		dev.minevibe.world.provenance.Protection.Verdict nearest = null;
		for (Step st : this.steps) {
			if (this.satisfied(agent.level(), st)) {
				continue;
			}
			BlockState s = agent.level().getBlockState(st.pos());
			boolean changes = switch (st.kind()) {
				case CLEAR, WATER -> !s.isAir();
				case SOLID, TORCH -> !s.isAir() && s.canBeReplaced();
			};
			if (!changes) {
				continue;
			}
			dev.minevibe.world.provenance.Protection.Verdict v = dev.minevibe.world.provenance.Protection.check(agent.level(), st.pos(), agent.agentId());
			if (v != null) {
				prot.add(st.pos());
				if (nearest == null || st.pos().distSqr(agent.blockPosition()) < nearest.pos().distSqr(agent.blockPosition())) {
					nearest = v;
				}
			}
		}
		if (nearest != null) {
			this.put("blueprint", this.blueprint);
			return this.refuseProtected(agent, nearest, prot);
		}
		int haveBlocks = Inv.count(agent, BuildJob::isBuildingBlock);
		int haveTorches = Inv.count(agent, Items.TORCH);
		this.put("needBlocks", solids);
		if (solids > haveBlocks) {
			return this.fail("NO_MATERIAL", String.format(Locale.ROOT, "%s needs %d building blocks (dirt, cobblestone, planks...), have %d", this.blueprint, solids, haveBlocks));
		}
		if ("torch_ring".equals(this.blueprint) && torches > haveTorches) {
			return this.fail("NO_MATERIAL", "torch_ring needs " + torches + " torches, have " + haveTorches);
		}
		return null;
	}

	private boolean satisfied(final ServerLevel level, final Step step) {
		BlockState s = level.getBlockState(step.pos());
		return switch (step.kind()) {
			case SOLID -> !s.canBeReplaced();
			case TORCH -> s.is(net.minecraft.world.level.block.Blocks.TORCH) || s.is(net.minecraft.world.level.block.Blocks.WALL_TORCH);
			case CLEAR -> BlockOps.isClear(level, step.pos());
			case WATER -> s.getFluidState().is(net.minecraft.tags.FluidTags.WATER);
		};
	}

	private void defer(final Step step) {
		this.stepTicks = 0;
		this.walk.reset();
		if (this.requeued < this.steps.size()) {
			this.requeued++;
			this.steps.remove(this.index);
			this.steps.add(step);
		} else {
			this.skip();
		}
	}

	private void skip() {
		this.skipped++;
		this.index++;
		this.stepTicks = 0;
	}

	private Status finish() {
		this.put("blueprint", this.blueprint);
		this.put("origin", this.origin);
		this.put("placed", this.placed);
		this.put("dug", this.dug);
		this.put("skipped", this.skipped);
		return this.done();
	}

	private Status finishShort(final String code, final String msg) {
		this.put("blueprint", this.blueprint);
		this.put("placed", this.placed);
		this.put("dug", this.dug);
		return this.fail(code, msg + " after " + this.placed + " blocks");
	}
}
