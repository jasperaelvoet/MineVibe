package dev.minevibe.agent.skill;

import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.job.BlockScan;
import dev.minevibe.agent.skill.seat.PcRegistry;
import dev.minevibe.agent.skill.seat.Seats;
import java.util.List;
import java.util.Locale;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * Named places {@code goto{entity}} understands besides entities: {@code office} / {@code home} (where the agent
 * shelters: the office door it was spawned at, or the bed it last slept in), {@code spawn}, the nearest {@code bed},
 * {@code chest}, {@code crafting_table} or {@code furnace}, and {@code pc:<id>} (that PC's chair).
 */
public final class Places {
	private static final int SEARCH_RADIUS = 48;

	private Places() {
	}

	/** True when {@code ref} names a place rather than an entity. */
	public static boolean isPlace(final String ref) {
		String r = ref.toLowerCase(Locale.ROOT);
		return r.startsWith("pc:") || List.of("office", "home", "spawn", "bed", "chest", "crafting_table", "furnace").contains(r);
	}

	/** The block position of a named place for this agent, or null when there is none (in this dimension). */
	public static @Nullable BlockPos resolve(final AgentPlayer agent, final String ref) {
		String r = ref.toLowerCase(Locale.ROOT);
		ServerLevel level = agent.level();
		if (r.startsWith("pc:")) {
			PcRegistry.Chair chair = Seats.pcs().chair(level.getServer(), r.substring(3));
			return chair != null && chair.dim() == level.dimension() ? chair.pos() : null;
		}
		return switch (r) {
			case "office", "home" -> agent.brain().home() != null ? agent.brain().home() : spawn(agent);
			case "spawn" -> spawn(agent);
			case "bed" -> nearest(agent, s -> s.is(BlockTags.BEDS) && !(s.hasProperty(BedBlock.OCCUPIED) && s.getValue(BedBlock.OCCUPIED)));
			case "chest" -> nearest(agent, s -> s.is(Blocks.CHEST) || s.is(Blocks.BARREL) || s.is(Blocks.TRAPPED_CHEST));
			case "crafting_table" -> nearest(agent, s -> s.is(Blocks.CRAFTING_TABLE));
			case "furnace" -> nearest(agent, s -> s.is(Blocks.FURNACE) || s.is(Blocks.SMOKER) || s.is(Blocks.BLAST_FURNACE));
			default -> null;
		};
	}

	private static @Nullable BlockPos spawn(final AgentPlayer agent) {
		if (agent.level() != agent.level().getServer().overworld()) {
			return null;
		}
		return agent.level().getServer().getWorldData().overworldData().getRespawnData().pos();
	}

	private static @Nullable BlockPos nearest(final AgentPlayer agent, final Predicate<BlockState> match) {
		List<BlockPos> found = BlockScan.nearest(agent.level(), agent.blockPosition(), SEARCH_RADIUS, match, p -> true, 1);
		return found.isEmpty() ? null : found.getFirst();
	}
}
