/*
 * Adapted from fabric-carpet (https://github.com/gnembon/fabric-carpet),
 * carpet.helpers.EntityPlayerActionPack. Copyright (c) gnembon and contributors. MIT License.
 * Modified for MineVibe (Minecraft 26.3): trimmed to use, held attack, jump, drop, swap, movement,
 * look, sneak and sprint, with explicit targets instead of ray-traced ones.
 */
package dev.minevibe.agent;

import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.network.protocol.game.ServerboundPlayerActionPacket;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * The agent's "keyboard and mouse". Brains, jobs and the navigator set intentions here; {@link #onUpdate()}
 * turns them into player input once per tick, before the player physics tick.
 *
 * <p>Movement intentions ({@link #setForward}, {@link #setStrafe}, {@link #setJumping}, {@link #setSprinting})
 * are latched: they stay until changed. Call {@link #stopMovement()} to release everything.
 */
public final class AgentControls {
	private final AgentPlayer player;

	private float forward;
	private float strafe;
	private boolean jumping;
	private boolean sneaking;
	private boolean sprinting;

	// Held attack on a block (survival mining with real destroy progress).
	private @Nullable BlockPos miningPos;
	private Direction miningFace = Direction.UP;
	private float miningProgress;
	private int blockHitDelay;
	private int lastBrokenTick = -1;

	private int itemUseCooldown;

	public AgentControls(final AgentPlayer player) {
		this.player = player;
	}

	// ---------------------------------------------------------------- movement

	public AgentControls setForward(final float forward) {
		this.forward = Mth.clamp(forward, -1.0F, 1.0F);
		return this;
	}

	public AgentControls setStrafe(final float strafe) {
		this.strafe = Mth.clamp(strafe, -1.0F, 1.0F);
		return this;
	}

	public AgentControls setJumping(final boolean jumping) {
		this.jumping = jumping;
		return this;
	}

	public AgentControls setSneaking(final boolean sneaking) {
		this.sneaking = sneaking;
		this.player.setShiftKeyDown(sneaking);
		if (sneaking) {
			this.setSprinting(false);
		}
		return this;
	}

	public AgentControls setSprinting(final boolean sprinting) {
		boolean allowed = sprinting && !this.sneaking && this.player.getFoodData().getFoodLevel() > 6;
		this.sprinting = allowed;
		this.player.setSprinting(allowed);
		return this;
	}

	public boolean isSprinting() {
		return this.sprinting;
	}

	/** Releases movement keys (not held attack/use). */
	public void stopMovement() {
		this.forward = 0.0F;
		this.strafe = 0.0F;
		this.jumping = false;
		this.setSprinting(false);
		if (this.sneaking) {
			this.setSneaking(false);
		}
	}

	/** Releases everything, including a held attack and item use. */
	public void releaseAll() {
		this.stopMovement();
		this.stopMining();
		if (this.player.isUsingItem()) {
			this.player.releaseUsingItem();
		}
	}

	// ---------------------------------------------------------------- look

	public AgentControls look(final float yaw, final float pitch) {
		float y = Mth.wrapDegrees(yaw);
		this.player.setYRot(y);
		this.player.setYHeadRot(y);
		this.player.setXRot(Mth.clamp(pitch, -90.0F, 90.0F));
		return this;
	}

	public AgentControls lookAt(final Vec3 target) {
		this.player.lookAt(EntityAnchorArgument.Anchor.EYES, target);
		this.player.setYHeadRot(this.player.getYRot());
		return this;
	}

	public AgentControls lookAt(final Entity entity) {
		return this.lookAt(new Vec3(entity.getX(), entity.getY(0.6), entity.getZ()));
	}

	/** Yaw (degrees) that faces {@code target} from the agent's position. */
	public float yawTo(final Vec3 target) {
		double dx = target.x - this.player.getX();
		double dz = target.z - this.player.getZ();
		return (float)(Mth.atan2(dz, dx) * (180.0 / Math.PI)) - 90.0F;
	}

	// ---------------------------------------------------------------- attack

	/**
	 * Holds the attack button on {@code pos}, like a player holding left click. Mining speed is the
	 * vanilla survival speed for the held tool, so a job must keep calling this every tick until
	 * {@link #isMining()} turns false. Changing the target aborts the previous block.
	 */
	public void holdAttack(final BlockPos pos, final Direction face) {
		if (this.miningPos != null && !this.miningPos.equals(pos)) {
			this.stopMining();
		}
		if (this.miningPos == null) {
			if (this.blockHitDelay > 0) {
				return;
			}
			ServerLevel level = this.player.level();
			BlockState state = level.getBlockState(pos);
			if (state.isAir()) {
				return;
			}
			this.player.gameMode.handleBlockBreakAction(pos, ServerboundPlayerActionPacket.Action.START_DESTROY_BLOCK, face, level.getMaxY(), -1);
			this.swingAttack();
			this.player.resetLastActionTime();
			if (level.getBlockState(pos).isAir()) {
				// Instant break (e.g. grass, or haste/efficiency).
				this.lastBrokenTick = this.player.tickCount;
				this.blockHitDelay = 5;
				return;
			}
			this.miningPos = pos.immutable();
			this.miningFace = face;
			this.miningProgress = state.getDestroyProgress(this.player, level, pos);
		}
	}

	/** The block being mined, or null. */
	public @Nullable BlockPos miningPos() {
		return this.miningPos;
	}

	public boolean isMining() {
		return this.miningPos != null;
	}

	/** Tick (player tickCount) when the held attack last broke a block. */
	public int lastBrokenTick() {
		return this.lastBrokenTick;
	}

	public void stopMining() {
		if (this.miningPos != null) {
			ServerLevel level = this.player.level();
			this.player.gameMode.handleBlockBreakAction(
				this.miningPos, ServerboundPlayerActionPacket.Action.ABORT_DESTROY_BLOCK, this.miningFace, level.getMaxY(), -1
			);
			this.miningPos = null;
			this.miningProgress = 0.0F;
		}
	}

	private void tickMining() {
		if (this.blockHitDelay > 0) {
			this.blockHitDelay--;
		}
		if (this.miningPos == null) {
			return;
		}
		ServerLevel level = this.player.level();
		BlockState state = level.getBlockState(this.miningPos);
		if (state.isAir()) {
			this.miningPos = null;
			this.miningProgress = 0.0F;
			return;
		}
		this.miningProgress += state.getDestroyProgress(this.player, level, this.miningPos);
		this.swingAttack();
		if (this.miningProgress >= 1.0F) {
			BlockPos pos = this.miningPos;
			this.player.gameMode.handleBlockBreakAction(pos, ServerboundPlayerActionPacket.Action.STOP_DESTROY_BLOCK, this.miningFace, level.getMaxY(), -1);
			this.miningPos = null;
			this.miningProgress = 0.0F;
			this.blockHitDelay = 5;
			if (level.getBlockState(pos).isAir()) {
				this.lastBrokenTick = this.player.tickCount;
			}
		}
	}

	/**
	 * Attacks {@code target} if it is in reach and the attack is charged (like a player who waits for
	 * the cooldown). Returns true if a swing happened.
	 */
	public boolean attack(final Entity target) {
		ItemStack weapon = this.player.getMainHandItem();
		if (!this.player.isWithinAttackRange(weapon, target.getBoundingBox(), 0.0)) {
			return false;
		}
		if (this.player.getAttackStrengthScale(0.5F) < 0.95F || this.player.cannotAttackWithItem(weapon, 0)) {
			return false;
		}
		this.player.resetLastActionTime();
		this.player.attack(target);
		this.swingAttack();
		this.player.resetAttackStrengthTicker();
		return true;
	}

	private void swingAttack() {
		this.player.swing(InteractionHand.MAIN_HAND, this.player.getMainHandItem().getAttackAnimation(), false);
	}

	// ---------------------------------------------------------------- use

	/** Right-clicks a block face with the main hand (doors, chairs, buttons...). */
	public InteractionResult useBlock(final BlockPos pos, final Direction face) {
		if (this.itemUseCooldown > 0) {
			return InteractionResult.PASS;
		}
		ServerLevel level = this.player.level();
		if (!level.mayInteract(this.player, pos)) {
			return InteractionResult.FAIL;
		}
		this.player.resetLastActionTime();
		Vec3 hit = Vec3.atCenterOf(pos).add(face.getStepX() * 0.5, face.getStepY() * 0.5, face.getStepZ() * 0.5);
		BlockHitResult hitResult = new BlockHitResult(hit, face, pos, false);
		InteractionHand hand = InteractionHand.MAIN_HAND;
		InteractionResult result = this.player.gameMode.useItemOn(this.player, level, this.player.getItemInHand(hand), hand, hitResult);
		this.player.swing(hand, this.player.getItemInHand(hand).getInteractAnimation(), false);
		if (result.consumesAction()) {
			this.itemUseCooldown = 4;
		}
		return result;
	}

	/** Starts using the held item (eating, drinking, blocking). Returns true if use started or consumed. */
	public boolean useItem(final InteractionHand hand) {
		if (this.player.isUsingItem()) {
			return true;
		}
		if (this.itemUseCooldown > 0) {
			return false;
		}
		this.player.resetLastActionTime();
		ItemStack stack = this.player.getItemInHand(hand);
		InteractionResult result = this.player.gameMode.useItem(this.player, this.player.level(), stack, hand);
		if (result.consumesAction()) {
			this.itemUseCooldown = 4;
			return true;
		}
		return this.player.isUsingItem();
	}

	public void releaseUse() {
		if (this.player.isUsingItem()) {
			this.player.releaseUsingItem();
		}
	}

	// ---------------------------------------------------------------- items

	public void dropSelected(final boolean wholeStack) {
		this.player.resetLastActionTime();
		this.player.drop(wholeStack);
	}

	public void swapHands() {
		ItemStack off = this.player.getItemInHand(InteractionHand.OFF_HAND);
		this.player.setItemInHand(InteractionHand.OFF_HAND, this.player.getItemInHand(InteractionHand.MAIN_HAND));
		this.player.setItemInHand(InteractionHand.MAIN_HAND, off);
	}

	// ---------------------------------------------------------------- tick

	/** Applies the latched intentions. Called by {@link AgentPlayer#tick()} before the physics tick. */
	public void onUpdate() {
		if (this.itemUseCooldown > 0) {
			this.itemUseCooldown--;
		}
		this.tickMining();

		float vel = this.sneaking ? 0.3F : 1.0F;
		if (this.player.isUsingItem()) {
			vel *= 0.2F;
		}
		this.player.zza = this.forward * vel;
		this.player.xxa = this.strafe * vel;
		this.player.setJumping(this.jumping);
		if (this.sprinting && (this.forward <= 0.0F || this.player.getFoodData().getFoodLevel() <= 6 || this.player.isUsingItem())) {
			this.setSprinting(false);
		}
	}
}
