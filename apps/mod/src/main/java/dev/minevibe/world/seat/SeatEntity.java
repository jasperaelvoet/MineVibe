package dev.minevibe.world.seat;

import dev.minevibe.world.MvWorldContent;
import net.minecraft.core.BlockPos;
import net.minecraft.network.syncher.SynchedEntityData;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.storage.ValueInput;
import net.minecraft.world.level.storage.ValueOutput;
import org.jspecify.annotations.Nullable;

/**
 * The invisible entity a player or agent rides when sitting on an {@code office_chair} (PLAN 7.5).
 *
 * <ul>
 *   <li>Single occupancy by construction: {@link #canAddPassenger} is true only while empty, and agents
 *       always use the non-forced {@code startRiding(seat)}.</li>
 *   <li>Never saved with the chunk; a chair spawns a fresh seat on use, and the seat discards itself when
 *       it has been empty for a second or its chair is gone.</li>
 *   <li>No gravity, no collision, not pickable.</li>
 * </ul>
 */
public final class SeatEntity extends Entity {
	private static final int EMPTY_TICKS_BEFORE_DISCARD = 20;

	private SeatKind kind = SeatKind.PC;
	private @Nullable BlockPos chairPos;
	private int emptyTicks;

	public SeatEntity(final EntityType<? extends SeatEntity> type, final Level level) {
		super(type, level);
		this.noPhysics = true;
		this.setNoGravity(true);
		this.setInvisible(true);
	}

	public static SeatEntity create(final ServerLevel level, final BlockPos chairPos, final SeatKind kind) {
		SeatEntity seat = new SeatEntity(MvWorldContent.SEAT, level);
		seat.chairPos = chairPos.immutable();
		seat.kind = kind;
		seat.setPos(chairPos.getX() + 0.5, chairPos.getY() + 0.05, chairPos.getZ() + 0.5);
		return seat;
	}

	public SeatKind kind() {
		return this.kind;
	}

	public @Nullable BlockPos chairPos() {
		return this.chairPos;
	}

	@Override
	protected void defineSynchedData(final SynchedEntityData.Builder entityData) {
	}

	@Override
	protected void readAdditionalSaveData(final ValueInput input) {
	}

	@Override
	protected void addAdditionalSaveData(final ValueOutput output) {
	}

	@Override
	public boolean shouldBeSaved() {
		return false;
	}

	@Override
	public boolean hurtServer(final ServerLevel level, final DamageSource source, final float damage) {
		return false;
	}

	@Override
	protected boolean canAddPassenger(final Entity passenger) {
		return this.getPassengers().isEmpty();
	}

	@Override
	public boolean isPickable() {
		return false;
	}

	@Override
	public boolean isPushable() {
		return false;
	}

	@Override
	public void tick() {
		super.tick();
		if (!(this.level() instanceof ServerLevel level)) {
			return;
		}
		if (this.chairPos == null || !level.getBlockState(this.chairPos).is(MvWorldContent.OFFICE_CHAIR)) {
			this.ejectPassengers();
			this.discard();
			return;
		}
		if (this.getPassengers().isEmpty()) {
			if (++this.emptyTicks > EMPTY_TICKS_BEFORE_DISCARD) {
				this.discard();
			}
		} else {
			this.emptyTicks = 0;
		}
	}
}
