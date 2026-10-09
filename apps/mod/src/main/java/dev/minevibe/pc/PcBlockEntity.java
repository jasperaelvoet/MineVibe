package dev.minevibe.pc;

import com.google.gson.JsonObject;
import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.bridge.msg.Types;
import dev.minevibe.bridge.protocol.Messages;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.component.DataComponentGetter;
import net.minecraft.core.component.DataComponentMap;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.network.protocol.game.ClientboundBlockEntityDataPacket;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.level.storage.ValueInput;
import net.minecraft.world.level.storage.ValueOutput;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The monitor of a {@code pc_desk} (PLAN 7.5): which PC it shows ({@code pcId}, null until Node created one), the
 * PC type, and its chair ({@code seatPos}). Lives in the main upper block. Synced to the client (renderer, chair
 * lookup) and saved with the chunk.
 *
 * <ul>
 *   <li><b>Create on place.</b> A workstation item without {@code pc_id} places an unbound desk and sends
 *       {@code pc.action{create}}; the reply binds the desk. A refusal ({@code NO_CAPACITY}, {@code OVER_BUDGET},
 *       {@code MACOS_SLOTS_FULL}, ...) stays on the desk ({@link #createError()}) for the monitor to show; using
 *       the desk tries again.</li>
 *   <li><b>Unplug on break.</b> When the block goes away (player, explosion, a broken partner), the desk drops the
 *       workstation item bound to its PC and sends {@code pc.action{unplug}}, so {@code bootAll} skips the PC until
 *       the item is placed again (which sends {@code plug}).</li>
 * </ul>
 */
public final class PcBlockEntity extends BlockEntity {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/PC");

	private @Nullable String pcId;
	private String type = "linux";
	private @Nullable BlockPos seatPos;
	private @Nullable String createError;
	/** A create request is in flight (not saved: a reload forgets it, and using the desk retries). */
	private boolean creating;
	/** Set when a creative player breaks the desk: no item drop. */
	private boolean suppressDrop;
	/** Set before {@link PcWorkstation#removeQuietly}: no item drop and no unplug (the PC stays plugged). */
	private boolean quiet;

	public PcBlockEntity(final BlockPos pos, final BlockState state) {
		super(PcContent.PC_BLOCK_ENTITY, pos, state);
	}

	public @Nullable String pcId() {
		return this.pcId;
	}

	/** {@code linux}, {@code linux-slim} or {@code macos}. */
	public String type() {
		return this.type;
	}

	public @Nullable BlockPos seatPos() {
		return this.seatPos;
	}

	public @Nullable String createError() {
		return this.createError;
	}

	public boolean isCreating() {
		return this.creating;
	}

	void suppressDrop() {
		this.suppressDrop = true;
	}

	void markQuiet() {
		this.quiet = true;
		this.suppressDrop = true;
	}

	public Direction facing() {
		return this.getBlockState().getValue(PcDeskBlock.FACING);
	}

	/** The main lower block of this desk. */
	public BlockPos origin() {
		return this.worldPosition.below();
	}

	/** First setup by {@link PcWorkstation#place}: type, chair, and (for a bound item) the PC. */
	void setup(final String newType, final BlockPos chair, final @Nullable String boundPcId) {
		this.type = newType;
		this.seatPos = chair.immutable();
		this.pcId = boundPcId;
		this.createError = null;
		this.creating = false;
		this.changed();
	}

	// -----------------------------------------------------------------------------------------
	// Create / plug / unplug (server thread)
	// -----------------------------------------------------------------------------------------

	/**
	 * Sends {@code pc.action{create}} for this unbound desk and binds the reply: an existing PC that has no desk in this
	 * world yet (PLAN 7.5), or a new one.
	 */
	public void requestCreate(final ServerLevel level) {
		if (this.pcId != null || this.creating) {
			return;
		}
		this.creating = true;
		this.createError = null;
		this.changed();
		BlockPos pos = this.worldPosition;
		ResourceKey<Level> dim = level.dimension();
		MinecraftServer server = level.getServer();
		// Node plugs a PC of this family that has no desk here yet (linux-1 for the first Linux desk), and creates one only
		// when every one has: tell it which desks this world has, as far as this session has seen them.
		CompletableFuture<JsonObject> reply = PcBridge.create(this.type, new Messages.BlockPos(pos.getX(), pos.getY(), pos.getZ()), PcRegistry.pcIds());
		reply.whenComplete((ok, err) -> {
			String created = err == null && ok != null && ok.has("pcId") ? ok.get("pcId").getAsString() : null;
			String code = err != null ? PcBridge.codeOf(err) : created == null ? Messages.Codes.INTERNAL : null;
			server.execute(() -> {
				ServerLevel l = server.getLevel(dim);
				PcBlockEntity be = l != null && l.getBlockEntity(pos) instanceof PcBlockEntity desk ? desk : null;
				if (be == null || be.pcId != null) {
					if (created != null) {
						// The desk went away (or was bound otherwise) while Node created the PC: leave it unplugged.
						LOG.info("PC {} was created for a desk that is gone; unplugging it", created);
						PcBridge.action("unplug", created, null, null);
					}
					return;
				}
				be.creating = false;
				if (created != null) {
					LOG.info("Desk at {} is now PC {}", pos, created);
					be.bind(created);
				} else {
					LOG.info("Creating a {} PC at {} failed: {}", be.type, pos, code);
					be.createError = code;
					be.changed();
				}
			});
		});
	}

	/** Binds this desk to {@code id} (create reply, or a bound item: then {@code pc.action{plug}} follows). */
	void bind(final String id) {
		this.pcId = id;
		this.createError = null;
		this.creating = false;
		Pc.PcInfo info = PcStates.get(id);
		if (info != null) {
			this.type = info.type();
		}
		this.changed();
		if (this.level instanceof ServerLevel serverLevel) {
			PcRegistry.registerDesk(serverLevel, this);
		}
	}

	/** Sends {@code pc.action{plug}} for a desk placed from a bound item; a PC Node no longer knows unbinds it. */
	void requestPlug(final ServerLevel level) {
		String id = this.pcId;
		if (id == null) {
			return;
		}
		BlockPos pos = this.worldPosition;
		ResourceKey<Level> dim = level.dimension();
		MinecraftServer server = level.getServer();
		PcBridge.action("plug", id, null, null).whenComplete((ok, err) -> {
			if (err == null) {
				return;
			}
			String code = PcBridge.codeOf(err);
			LOG.info("Plugging PC {} in failed: {}", id, code);
			if (!Messages.Codes.PC_UNKNOWN.equals(code)) {
				return;
			}
			server.execute(() -> {
				ServerLevel l = server.getLevel(dim);
				if (l != null && l.getBlockEntity(pos) instanceof PcBlockEntity be && id.equals(be.pcId)) {
					PcRegistry.unregisterDesk(l, be);
					be.pcId = null;
					be.createError = code;
					be.changed();
				}
			});
		});
	}

	@Override
	public void preRemoveSideEffects(final BlockPos pos, final BlockState state) {
		if (!(this.level instanceof ServerLevel serverLevel)) {
			return;
		}
		PcRegistry.unregisterDesk(serverLevel, this);
		if (!this.suppressDrop) {
			Block.popResource(serverLevel, pos, WorkstationItem.stackFor(this.type, this.pcId));
		}
		String id = this.pcId;
		if (id != null && !this.quiet) {
			LOG.info("Desk of PC {} removed at {}: unplugging", id, pos);
			PcBridge.action("unplug", id, null, null).whenComplete((ok, err) -> {
				if (err != null) {
					LOG.info("Unplugging PC {} failed: {}", id, PcBridge.codeOf(err));
				}
			});
		}
	}

	// -----------------------------------------------------------------------------------------
	// LED
	// -----------------------------------------------------------------------------------------

	/** The LED this desk should show now. */
	public PcLed led() {
		Pc.PcInfo info = PcStates.get(this.pcId);
		return PcLed.forDesk(this.pcId, this.creating, this.createError, info != null ? info.status() : null, info == null || info.plugged());
	}

	/** Sets the LED blockstate on the monitor (the only part whose model shows it) if it changed. */
	public void refreshLed() {
		if (!(this.level instanceof ServerLevel serverLevel)) {
			return;
		}
		BlockState state = this.getBlockState();
		if (!(state.getBlock() instanceof PcDeskBlock) || state.getValue(PcDeskBlock.HALF) != DoubleBlockHalf.UPPER) {
			return;
		}
		PcLed led = this.led();
		if (state.getValue(PcDeskBlock.LED) != led) {
			serverLevel.setBlock(this.worldPosition, state.setValue(PcDeskBlock.LED, led), Block.UPDATE_CLIENTS);
		}
	}

	private void changed() {
		this.setChanged();
		if (this.level != null && !this.level.isClientSide()) {
			BlockState state = this.getBlockState();
			this.level.sendBlockUpdated(this.worldPosition, state, state, Block.UPDATE_CLIENTS);
			this.refreshLed();
		}
	}

	// -----------------------------------------------------------------------------------------
	// Persistence and sync
	// -----------------------------------------------------------------------------------------

	@Override
	protected void saveAdditional(final ValueOutput output) {
		super.saveAdditional(output);
		if (this.pcId != null) {
			output.putString("pc_id", this.pcId);
		}
		output.putString("type", this.type);
		if (this.seatPos != null) {
			output.store("seat", BlockPos.CODEC, this.seatPos);
		}
		if (this.createError != null) {
			output.putString("create_error", this.createError);
		}
		if (this.creating) {
			// Only on the client copy: a create in flight shows as "creating".
			output.putBoolean("creating", true);
		}
	}

	@Override
	protected void loadAdditional(final ValueInput input) {
		super.loadAdditional(input);
		String id = input.getStringOr("pc_id", "");
		this.pcId = id.matches(Types.PC_ID_REGEX) ? id : null;
		this.type = input.getStringOr("type", "linux");
		this.seatPos = input.read("seat", BlockPos.CODEC).orElse(null);
		String error = input.getStringOr("create_error", "");
		this.createError = error.isEmpty() ? null : error;
		this.creating = this.level != null && this.level.isClientSide() && input.getBooleanOr("creating", false);
	}

	@Override
	public ClientboundBlockEntityDataPacket getUpdatePacket() {
		return ClientboundBlockEntityDataPacket.create(this);
	}

	@Override
	public CompoundTag getUpdateTag(final HolderLookup.Provider registries) {
		return this.saveCustomOnly(registries);
	}

	@Override
	protected void applyImplicitComponents(final DataComponentGetter components) {
		super.applyImplicitComponents(components);
		String id = components.get(PcContent.PC_ID);
		if (id != null && id.matches(Types.PC_ID_REGEX)) {
			this.pcId = id;
		}
	}

	@Override
	protected void collectImplicitComponents(final DataComponentMap.Builder components) {
		super.collectImplicitComponents(components);
		if (this.pcId != null) {
			components.set(PcContent.PC_ID, this.pcId);
		}
	}
}
