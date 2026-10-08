package dev.minevibe.world.seat;

import dev.minevibe.world.MvWorldContent;
import net.minecraft.core.BlockPos;
import net.minecraft.network.syncher.EntityDataAccessor;
import net.minecraft.network.syncher.EntityDataSerializers;
import net.minecraft.network.syncher.SynchedEntityData;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
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
 *   <li>Its {@link SeatKind} follows the chair's {@code kind} (checked every tick, so a chair a meeting table links
 *       or releases while someone sits on it changes at once) and is synced to clients, so client code can tell a
 *       PC seat from a meeting seat (PcControlScreen, the "seated at a PC" head icon, the kick confirmation).</li>
 * </ul>
 */
public final class SeatEntity extends Entity {
	private static final int EMPTY_TICKS_BEFORE_DISCARD = 20;
	private static final EntityDataAccessor<Byte> DATA_KIND = SynchedEntityData.defineId(SeatEntity.class, EntityDataSerializers.BYTE);

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
		seat.setKind(kind);
		seat.setPos(chairPos.getX() + 0.5, chairPos.getY() + 0.05, chairPos.getZ() + 0.5);
		return seat;
	}

	/** What the chair was for when this seat was made (on the client too: the kind is synced). */
	public SeatKind kind() {
		return kindOf(this.entityData.get(DATA_KIND));
	}

	private void setKind(final SeatKind kind) {
		this.entityData.set(DATA_KIND, (byte)kind.ordinal());
	}

	/** The kind a synced byte stands for; unknown values read as {@link SeatKind#PC}. */
	static SeatKind kindOf(final byte id) {
		SeatKind[] kinds = SeatKind.values();
		return id >= 0 && id < kinds.length ? kinds[id] : SeatKind.PC;
	}

	/** A seat at a PC chair: its sitter is at a PC (meeting seats never are). */
	public boolean isPcSeat() {
		return this.kind() == SeatKind.PC;
	}

	public @Nullable BlockPos chairPos() {
		return this.chairPos;
	}

	@Override
	protected void defineSynchedData(final SynchedEntityData.Builder entityData) {
		entityData.define(DATA_KIND, (byte)SeatKind.PC.ordinal());
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
		BlockState chair = this.chairPos == null ? null : level.getBlockState(this.chairPos);
		if (chair == null || !chair.is(MvWorldContent.OFFICE_CHAIR)) {
			this.ejectPassengers();
			this.discard();
			return;
		}
		// Follow the chair: a meeting table links (or releases) chairs about once a second, also while someone sits.
		SeatKind chairKind = chair.getValue(OfficeChairBlock.KIND);
		if (chairKind != this.kind()) {
			this.setKind(chairKind);
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
