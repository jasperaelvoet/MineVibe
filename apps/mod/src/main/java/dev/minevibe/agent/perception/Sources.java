package dev.minevibe.agent.perception;

import com.google.gson.JsonObject;
import dev.minevibe.agent.job.SkillJob;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * Natural resource targeting (W1) for {@code mine}, {@code collect} and {@code find}: what a block or tag request
 * resolves to, and the record of sources a job could not use.
 *
 * <ul>
 *   <li>A tag ({@code #minecraft:logs}) expands to natural blocks only: stripped logs, wood, hyphae and planks are
 *       building variants and count only when named explicitly ({@code stripped_spruce_log}).</li>
 *   <li>Requests for logs (all accepted blocks are natural logs) work on whole natural trees ({@link Trees}).</li>
 *   <li>Everything else skips protected blocks (player-built, in the Base); blocks agents placed are fair game.</li>
 * </ul>
 */
public final class Sources {
	private Sources() {
	}

	/** A source a job saw but did not use, and why: {@code unreachable}, {@code too_far}, {@code protected}, {@code not_natural}. */
	public record Candidate(BlockPos pos, String block, int distance, String dir, String why, @Nullable String owner) {
		public JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.add("pos", SkillJob.pos(this.pos));
			o.addProperty("block", this.block);
			o.addProperty("distance", this.distance);
			o.addProperty("dir", this.dir);
			o.addProperty("why", this.why);
			if (this.owner != null) {
				o.addProperty("owner", dev.minevibe.bridge.protocol.ProtocolCodec.clip(this.owner, 48));
			}
			return o;
		}

		/** {@code oak tree 9m W at 3 70 -2 (unreachable)} */
		public String describe() {
			String what = this.block.replace("minecraft:", "");
			String reason = switch (this.why) {
				case "unreachable" -> "unreachable";
				case "too_far" -> "out of range";
				case "protected" -> this.owner != null ? this.owner + "'s, not touched" : "protected, not touched";
				default -> "not a natural tree";
			};
			return what + " " + this.distance + "m " + this.dir + " at " + Compass.xyz(this.pos) + " (" + reason + ")";
		}
	}

	/** A tag request without its building variants. */
	public static Predicate<BlockState> naturalTag(final Predicate<BlockState> tagMatch) {
		return s -> tagMatch.test(s) && !Trees.isBuildingVariant(s.getBlock());
	}

	/** True when {@code match} accepts natural logs and nothing else: the request is for trees. */
	public static boolean treeMode(final Predicate<BlockState> match) {
		boolean any = false;
		for (Block b : BuiltInRegistries.BLOCK) {
			BlockState s = b.defaultBlockState();
			if (!match.test(s)) {
				continue;
			}
			if (!Trees.isNaturalLogBlock(s)) {
				return false;
			}
			any = true;
		}
		return any;
	}

	/** True when {@code match} accepts no block at all (a tag of building variants only, such as planks). */
	public static boolean acceptsNothing(final Predicate<BlockState> match) {
		for (Block b : BuiltInRegistries.BLOCK) {
			if (match.test(b.defaultBlockState())) {
				return false;
			}
		}
		return true;
	}
}
