package dev.minevibe.org;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.context.CommandContext;
import dev.minevibe.org.meeting.MeetingSeats;
import dev.minevibe.org.meeting.MeetingTables;
import dev.minevibe.org.office.OfficeBuilder;
import dev.minevibe.org.office.OfficeLayout;
import dev.minevibe.org.office.OfficeService;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;

/**
 * Dev commands for the org tools, available only where commands are allowed (game-master permission; release worlds
 * have {@code allowCommands=false}):
 * <pre>
 * /mv office build    build the starter office with its spawn cell where you stand, and make it the world's office
 * /mv office info     where the office and its slots are
 * /mv meeting chairs  the meeting chairs of the nearest table and who sits on them
 * </pre>
 */
public final class OrgCommands {
	private OrgCommands() {
	}

	public static void register() {
		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> register(dispatcher));
	}

	private static void register(final CommandDispatcher<CommandSourceStack> dispatcher) {
		dispatcher.register(
			Commands.literal("mv")
				.requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
				.then(Commands.literal("office")
					.then(Commands.literal("build").executes(OrgCommands::build))
					.then(Commands.literal("info").executes(OrgCommands::info)))
				.then(Commands.literal("meeting")
					.then(Commands.literal("chairs").executes(OrgCommands::chairs)))
		);
	}

	private static int build(final CommandContext<CommandSourceStack> ctx) {
		CommandSourceStack source = ctx.getSource();
		BlockPos standing = BlockPos.containing(source.getPosition());
		OfficeLayout layout = OfficeService.buildAt(source.getLevel(), OfficeBuilder.originForStanding(standing));
		source.sendSuccess(() -> Component.literal("Built the office at " + layout.origin().toShortString() + "; spawn " + layout.spawn().toShortString()), true);
		return 1;
	}

	private static int info(final CommandContext<CommandSourceStack> ctx) {
		CommandSourceStack source = ctx.getSource();
		OfficeLayout layout = OfficeService.layout(source.getServer());
		if (layout == null) {
			source.sendFailure(Component.literal("This world has no office (/mv office build makes one where you stand)"));
			return 0;
		}
		StringBuilder text = new StringBuilder("Office at ").append(layout.origin().toShortString()).append(", spawn ").append(layout.spawn().toShortString());
		for (OfficeLayout.Slot slot : layout.slots()) {
			text.append("\n  ").append(slot.kind()).append(" ").append(slot.pos().toShortString());
			if (slot.pcId() != null) {
				text.append(" (").append(slot.pcId()).append(")");
			}
		}
		source.sendSuccess(() -> Component.literal(text.toString()), false);
		return 1;
	}

	private static int chairs(final CommandContext<CommandSourceStack> ctx) {
		CommandSourceStack source = ctx.getSource();
		ServerLevel level = source.getLevel();
		BlockPos table = MeetingSeats.nearestTable(level, BlockPos.containing(source.getPosition()));
		if (table == null) {
			source.sendFailure(Component.literal("No meeting table within " + MeetingSeats.SEARCH_RADIUS + " blocks"));
			return 0;
		}
		StringBuilder text = new StringBuilder("Meeting table at ").append(table.toShortString());
		for (BlockPos chair : MeetingTables.chairsOf(level, table)) {
			text.append("\n  chair ").append(chair.toShortString()).append(MeetingSeats.isOccupied(level, chair) ? " (taken)" : " (free)");
		}
		source.sendSuccess(() -> Component.literal(text.toString()), false);
		return 1;
	}
}
