package dev.minevibe.agent.nav;

import dev.minevibe.MineVibeMod;
import dev.minevibe.org.office.OfficeService;
import java.util.Locale;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;

/**
 * Navigation diagnostics. Failing searches are always logged in one line ({@code [nav] ...}); with
 * {@code -Dminevibe.navDebug=true} or {@code MINEVIBE_NAV_DEBUG=1} (the game inherits the environment of
 * {@code npm run play} and the acceptance harness) a failure also logs a top-down map of the terrain between the agent
 * and its goal, which is how seeds whose trees cannot be reached were diagnosed.
 */
public final class NavDebug {
	/** Verbose navigation logging: plans, stuck rungs, terrain maps on failures. */
	public static final boolean ENABLED = Boolean.getBoolean("minevibe.navDebug") || "1".equals(System.getenv("MINEVIBE_NAV_DEBUG"))
		|| "true".equalsIgnoreCase(System.getenv("MINEVIBE_NAV_DEBUG"));

	private static final int MAX_SIDE = 48;

	private NavDebug() {
	}

	public static void log(final String agentId, final String what, final Object... kv) {
		StringBuilder sb = new StringBuilder("[nav] ").append(agentId).append(' ').append(what);
		for (int i = 0; i + 1 < kv.length; i += 2) {
			sb.append(' ').append(kv[i]).append('=').append(kv[i + 1]);
		}
		MineVibeMod.LOGGER.info(sb.toString());
	}

	/**
	 * Logs a top-down map of the box spanned by {@code a} and {@code b} (plus a margin): per column the top block's
	 * kind and the height of its top face relative to {@code a}'s feet (0: level with the agent). Cell = kind + height:
	 * kind {@code .} ground, {@code T} log, {@code L}
	 * leaves, {@code ~} water, {@code !} lava, {@code #} stone-like, {@code O} the office, {@code ?} unloaded, {@code +}
	 * anything else; height {@code 0}-{@code 9} above, {@code a}-{@code i} for 1 to 9 below, {@code ^} / {@code v}
	 * beyond. {@code @} marks {@code a}, {@code X} marks {@code b}.
	 */
	public static void terrainMap(final ServerLevel level, final String agentId, final BlockPos a, final BlockPos b) {
		int margin = 6;
		int x0 = Math.min(a.getX(), b.getX()) - margin;
		int x1 = Math.max(a.getX(), b.getX()) + margin;
		int z0 = Math.min(a.getZ(), b.getZ()) - margin;
		int z1 = Math.max(a.getZ(), b.getZ()) + margin;
		if (x1 - x0 > MAX_SIDE) {
			x1 = x0 + MAX_SIDE;
		}
		if (z1 - z0 > MAX_SIDE) {
			z1 = z0 + MAX_SIDE;
		}
		StringBuilder sb = new StringBuilder();
		sb.append(String.format(Locale.ROOT, "[nav] %s terrain x %d..%d z %d..%d, heights relative to y=%d (@ %s, X %s)%n", agentId, x0, x1, z0, z1,
			a.getY(), a.toShortString(), b.toShortString()));
		sb.append("  ground under the canopy (kind+height) | what fills the body cells above it (L leaves, T log, + other, . free)\n");
		java.util.Set<String> others = new java.util.TreeSet<>();
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		for (int z = z0; z <= z1; z++) {
			StringBuilder body = new StringBuilder();
			sb.append(String.format(Locale.ROOT, "%5d ", z));
			for (int x = x0; x <= x1; x++) {
				LevelChunk chunk = level.getChunkSource().getChunkNow(x >> 4, z >> 4);
				if (chunk == null) {
					sb.append("??");
					body.append('?');
					continue;
				}
				// The ground: the first solid block under the leaves and logs, from 12 above the agent down.
				int y = a.getY() + 12;
				BlockState s = null;
				for (; y > a.getY() - 16; y--) {
					p.set(x, y, z);
					s = level.getBlockState(p);
					if (!s.is(BlockTags.LEAVES) && !s.is(BlockTags.LOGS) && !s.getCollisionShape(level, p).isEmpty() || !s.getFluidState().isEmpty()) {
						break;
					}
				}
				p.set(x, y, z);
				char k = kind(level, p, s);
				if (k == '+') {
					others.add(net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(s.getBlock()).getPath());
				}
				String cell = String.valueOf(k) + height(y + 1 - a.getY());
				if (x == a.getX() && z == a.getZ()) {
					cell = "@@";
				} else if (x == b.getX() && z == b.getZ()) {
					cell = "XX";
				}
				sb.append(cell);
				body.append(bodyCell(level, p.set(x, y + 1, z)));
			}
			sb.append("  ").append(body).append('\n');
		}
		if (!others.isEmpty()) {
			sb.append("  + is: ").append(String.join(", ", others)).append('\n');
		}
		MineVibeMod.LOGGER.info(sb.toString());
	}

	private static char bodyCell(final ServerLevel level, final BlockPos feet) {
		char out = '.';
		for (BlockPos q : new BlockPos[] {feet, feet.above()}) {
			BlockState s = level.getBlockState(q);
			if (s.is(BlockTags.LOGS)) {
				return 'T';
			}
			if (s.is(BlockTags.LEAVES)) {
				out = 'L';
			} else if (out == '.' && !s.getCollisionShape(level, q).isEmpty()) {
				out = '+';
			}
		}
		return out;
	}

	/** Logs the blocks of the column at {@code at} from {@code below} blocks under it up to {@code above} over it. */
	public static void column(final ServerLevel level, final String agentId, final BlockPos at, final int below, final int above) {
		StringBuilder sb = new StringBuilder("[nav] ").append(agentId).append(" column ").append(at.toShortString()).append(':');
		for (int dy = above; dy >= -below; dy--) {
			BlockPos p = at.above(dy);
			BlockState s = level.getBlockState(p);
			sb.append(' ').append(p.getY()).append('=').append(net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(s.getBlock()).getPath());
		}
		MineVibeMod.LOGGER.info(sb.toString());
	}

	private static char kind(final ServerLevel level, final BlockPos p, final BlockState s) {
		if (OfficeService.protects(level, p)) {
			return 'O';
		}
		if (s.getFluidState().is(FluidTags.LAVA)) {
			return '!';
		}
		if (!s.getFluidState().isEmpty()) {
			return '~';
		}
		if (s.is(BlockTags.LOGS)) {
			return 'T';
		}
		if (s.is(BlockTags.LEAVES)) {
			return 'L';
		}
		if (s.is(BlockTags.SUBSTRATE_OVERWORLD) || s.is(BlockTags.DIRT) || s.is(BlockTags.SAND)) {
			return '.';
		}
		if (s.is(BlockTags.BASE_STONE_OVERWORLD)) {
			return '#';
		}
		return '+';
	}

	private static char height(final int dy) {
		if (dy > 9) {
			return '^';
		}
		if (dy >= 0) {
			return (char)('0' + dy);
		}
		if (dy >= -9) {
			return (char)('a' - 1 - dy);
		}
		return 'v';
	}
}
