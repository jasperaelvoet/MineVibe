package dev.minevibe.hardcore;

import com.mojang.serialization.Codec;
import com.mojang.serialization.codecs.RecordCodecBuilder;
import dev.minevibe.MineVibeMod;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.nbt.NbtOps;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.nbt.Tag;
import net.minecraft.util.datafix.DataFixTypes;
import net.minecraft.world.level.saveddata.SavedData;
import net.minecraft.world.level.saveddata.SavedDataType;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * The world's dead marker (PLAN §7.9), stored as world-level saved data in
 * {@code <world>/data/minevibe/hardcore.dat}. It is written (and flushed) the moment the local player dies, so a
 * crash or quit on the Game Over screen still leads back to Game Over, never into the dead world.
 *
 * <p>BootScreen reads it straight from disk with {@link #readFromWorldDir(Path)} before deciding whether to open a
 * world, without starting a server.
 */
public final class HardcoreMarker extends SavedData {
	public static final Codec<HardcoreMarker> CODEC = RecordCodecBuilder.create(i -> i.group(
					Codec.BOOL.optionalFieldOf("dead", false).forGetter(m -> m.dead),
					Codec.STRING.optionalFieldOf("world_id", "").forGetter(m -> m.worldId),
					Codec.STRING.optionalFieldOf("cause", "").forGetter(m -> m.cause),
					Codec.STRING.optionalFieldOf("killer").forGetter(m -> Optional.ofNullable(m.killer)),
					Codec.INT.optionalFieldOf("day", 1).forGetter(m -> m.day),
					Codec.LONG.optionalFieldOf("ticks_alive", 0L).forGetter(m -> m.ticksAlive),
					Codec.LONG.optionalFieldOf("died_at", 0L).forGetter(m -> m.diedAt))
			.apply(i, HardcoreMarker::new));

	/**
	 * {@code minevibe:hardcore}. Saved data needs a DataFixTypes; ours has no fixers of its own, and a file written by
	 * the running version is never upgraded, so the (unrelated) command-storage type is only a placeholder.
	 */
	public static final SavedDataType<HardcoreMarker> TYPE = new SavedDataType<>(
			MineVibeMod.id("hardcore"), HardcoreMarker::new, CODEC, DataFixTypes.SAVED_DATA_COMMAND_STORAGE);

	private boolean dead;
	private String worldId;
	private String cause;
	private @Nullable String killer;
	private int day;
	private long ticksAlive;
	private long diedAt;

	public HardcoreMarker() {
		this(false, "", "", Optional.empty(), 1, 0L, 0L);
	}

	private HardcoreMarker(boolean dead, String worldId, String cause, Optional<String> killer, int day, long ticksAlive, long diedAt) {
		this.dead = dead;
		this.worldId = worldId;
		this.cause = cause;
		this.killer = killer.orElse(null);
		this.day = day;
		this.ticksAlive = ticksAlive;
		this.diedAt = diedAt;
	}

	public boolean isDead() {
		return dead;
	}

	/** The recorded death, if the world is dead. */
	public Optional<DeathRecord> death() {
		return dead ? Optional.of(new DeathRecord(worldId, cause, killer, day, ticksAlive, diedAt)) : Optional.empty();
	}

	/** Marks the world dead. The first death wins; later calls keep it. */
	public void markDead(DeathRecord record) {
		if (dead) return;
		dead = true;
		worldId = record.worldId();
		cause = record.cause();
		killer = record.killer();
		day = record.day();
		ticksAlive = record.ticksAlive();
		diedAt = record.diedAtEpochMs();
		setDirty();
	}

	/** {@code <worldDir>/data/minevibe/hardcore.dat}, where {@code SavedDataStorage} keeps this marker. */
	public static Path file(Path worldDir) {
		return TYPE.id().withSuffix(".dat").resolveAgainst(worldDir.resolve(LevelResource.DATA.id()));
	}

	/**
	 * Reads the marker of a world that is not loaded. Returns the death when the world is marked dead, empty when it
	 * is alive or has no marker. A marker that cannot be read is reported as an {@link IOException}.
	 */
	public static Optional<DeathRecord> readFromWorldDir(Path worldDir) throws IOException {
		Path file = file(worldDir);
		if (!Files.isRegularFile(file)) return Optional.empty();
		CompoundTag root = NbtIo.readCompressed(file, NbtAccounter.unlimitedHeap());
		Tag data = root.get("data");
		if (data == null) return Optional.empty();
		HardcoreMarker marker = CODEC.parse(NbtOps.INSTANCE, data).result().orElseThrow(() -> new IOException("unreadable dead marker " + file));
		return marker.death();
	}

	/** Writes a marker file the way {@code SavedDataStorage} does (used by tests and tools). */
	public static void writeToWorldDir(Path worldDir, HardcoreMarker marker) throws IOException {
		CompoundTag root = new CompoundTag();
		root.put("data", CODEC.encodeStart(NbtOps.INSTANCE, marker).getOrThrow());
		NbtUtils.addCurrentDataVersion(root);
		Path file = file(worldDir);
		Files.createDirectories(file.getParent());
		NbtIo.writeCompressed(root, file);
	}
}
