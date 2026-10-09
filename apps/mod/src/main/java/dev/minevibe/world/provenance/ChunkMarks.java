package dev.minevibe.world.provenance;

import com.mojang.serialization.Codec;
import com.mojang.serialization.codecs.RecordCodecBuilder;
import it.unimi.dsi.fastutil.ints.Int2IntMap;
import it.unimi.dsi.fastutil.ints.Int2IntOpenHashMap;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.IntStream;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.ChunkPos;
import org.jspecify.annotations.Nullable;

/**
 * The provenance marks of one chunk: which blocks a player, an agent or the base put there. Compact: one int per
 * marked block ({@code owner index << 20 | (y + 2048) << 8 | z << 4 | x}, local x/z) and a short list of owners, saved
 * with the chunk as a Fabric data attachment ({@link Provenance#MARKS}).
 *
 * <p>Mutable and server-thread only; whoever changes it marks the chunk unsaved ({@link Provenance} does). Fabric
 * encodes it when the chunk is serialized, which also happens on the server thread.
 */
public final class ChunkMarks {
	private static final int POS_BITS = 20;
	private static final int POS_MASK = (1 << POS_BITS) - 1;
	/** Owner indices fit in the 11 bits above the position. */
	static final int MAX_OWNERS = 2047;
	private static final int Y_OFFSET = 2048;

	/** Visible for tests (codec round trips). */
	public static final Codec<ChunkMarks> CODEC = RecordCodecBuilder.create(i -> i.group(
		Codec.STRING.listOf().fieldOf("owners").forGetter(ChunkMarks::ownersForSave),
		Codec.INT_STREAM.fieldOf("marks").forGetter(ChunkMarks::marksForSave)
	).apply(i, ChunkMarks::load));

	private final List<String> owners = new ArrayList<>();
	private final List<@Nullable Owner> decoded = new ArrayList<>();
	/** Local position key -> owner index. */
	private final Int2IntOpenHashMap marks = new Int2IntOpenHashMap();

	public ChunkMarks() {
		this.marks.defaultReturnValue(-1);
	}

	private static ChunkMarks load(final List<String> owners, final IntStream marks) {
		ChunkMarks m = new ChunkMarks();
		for (String o : owners) {
			m.owners.add(o);
			m.decoded.add(Owner.decode(o));
		}
		marks.forEach(packed -> {
			int owner = packed >>> POS_BITS;
			if (owner < m.owners.size()) {
				m.marks.put(packed & POS_MASK, owner);
			}
		});
		return m;
	}

	/** The local key of a block position (any chunk; only the low 4 bits of x and z are kept). */
	static int key(final int x, final int y, final int z) {
		return ((y + Y_OFFSET) & 0xFFF) << 8 | (z & 15) << 4 | (x & 15);
	}

	static int key(final BlockPos pos) {
		return key(pos.getX(), pos.getY(), pos.getZ());
	}

	public int size() {
		return this.marks.size();
	}

	public boolean isEmpty() {
		return this.marks.isEmpty();
	}

	public @Nullable Owner get(final BlockPos pos) {
		int i = this.marks.get(key(pos));
		return i < 0 ? null : this.decoded.get(i);
	}

	/** Marks {@code pos}; returns true when that changed anything. */
	public boolean put(final BlockPos pos, final Owner owner) {
		String enc = owner.encode();
		int index = this.owners.indexOf(enc);
		if (index < 0) {
			if (this.owners.size() >= MAX_OWNERS) {
				this.compact();
			}
			if (this.owners.size() >= MAX_OWNERS) {
				// Thousands of different builders in one chunk: keep the block marked, under the first owner.
				index = 0;
			} else {
				this.owners.add(enc);
				this.decoded.add(owner);
				index = this.owners.size() - 1;
			}
		}
		int old = this.marks.put(key(pos), index);
		return old != index;
	}

	/** Removes the mark at {@code pos}; returns true when there was one. */
	public boolean remove(final BlockPos pos) {
		boolean removed = this.marks.remove(key(pos)) >= 0;
		if (removed && this.marks.isEmpty()) {
			this.owners.clear();
			this.decoded.clear();
		}
		return removed;
	}

	/** Visits every mark of the chunk at {@code chunk} with its world position. */
	public void forEach(final ChunkPos chunk, final MarkVisitor visitor) {
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		for (Int2IntMap.Entry e : this.marks.int2IntEntrySet()) {
			int k = e.getIntKey();
			Owner owner = this.decoded.get(e.getIntValue());
			if (owner == null) {
				continue;
			}
			p.set(chunk.getMinBlockX() + (k & 15), ((k >>> 8) & 0xFFF) - Y_OFFSET, chunk.getMinBlockZ() + ((k >>> 4) & 15));
			visitor.visit(p, owner);
		}
	}

	@FunctionalInterface
	public interface MarkVisitor {
		/** {@code pos} is reused between calls: copy it ({@code immutable()}) to keep it. */
		void visit(BlockPos pos, Owner owner);
	}

	/** Drops owners no mark uses any more (renumbering the marks). */
	private void compact() {
		boolean[] used = new boolean[this.owners.size()];
		for (int v : this.marks.values()) {
			used[v] = true;
		}
		int[] remap = new int[this.owners.size()];
		List<String> keptOwners = new ArrayList<>();
		List<@Nullable Owner> keptDecoded = new ArrayList<>();
		for (int i = 0; i < used.length; i++) {
			if (used[i]) {
				remap[i] = keptOwners.size();
				keptOwners.add(this.owners.get(i));
				keptDecoded.add(this.decoded.get(i));
			}
		}
		for (Int2IntMap.Entry e : this.marks.int2IntEntrySet()) {
			e.setValue(remap[e.getIntValue()]);
		}
		this.owners.clear();
		this.owners.addAll(keptOwners);
		this.decoded.clear();
		this.decoded.addAll(keptDecoded);
	}

	private List<String> ownersForSave() {
		this.compact();
		return List.copyOf(this.owners);
	}

	private IntStream marksForSave() {
		// Compacting is idempotent, so the indices match the saved owners whichever getter the codec calls first.
		this.compact();
		int[] out = new int[this.marks.size()];
		int i = 0;
		for (Int2IntMap.Entry e : this.marks.int2IntEntrySet()) {
			out[i++] = e.getIntValue() << POS_BITS | e.getIntKey();
		}
		java.util.Arrays.sort(out);
		return IntStream.of(out);
	}
}
