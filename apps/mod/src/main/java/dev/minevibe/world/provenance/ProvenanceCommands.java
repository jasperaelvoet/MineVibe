package dev.minevibe.world.provenance;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.arguments.coordinates.BlockPosArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * Dev commands for block provenance and protected zones (W1), where commands are allowed:
 * <pre>
 * /mv provenance &lt;pos&gt;              who placed the block there, and whether agents may change it
 * /mv zone list                         the protected zones of this world (the Base included)
 * /mv zone add &lt;name&gt; &lt;from&gt; &lt;to&gt;   protect a box in this dimension (kept in &lt;world&gt;/minevibe/zones.json)
 * /mv zone remove &lt;name&gt;              stop protecting a named zone
 * </pre>
 */
public final class ProvenanceCommands {
	private ProvenanceCommands() {
	}

	public static void register() {
		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> register(dispatcher));
	}

	private static void register(final CommandDispatcher<CommandSourceStack> dispatcher) {
		dispatcher.register(
			Commands.literal("mv")
				.requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
				.then(Commands.literal("provenance")
					.then(Commands.argument("pos", BlockPosArgument.blockPos()).executes(ProvenanceCommands::provenance)))
				.then(Commands.literal("zone")
					.then(Commands.literal("list").executes(ProvenanceCommands::list))
					.then(Commands.literal("add")
						.then(Commands.argument("name", StringArgumentType.word())
							.then(Commands.argument("from", BlockPosArgument.blockPos())
								.then(Commands.argument("to", BlockPosArgument.blockPos()).executes(ProvenanceCommands::add)))))
					.then(Commands.literal("remove")
						.then(Commands.argument("name", StringArgumentType.word()).executes(ProvenanceCommands::remove))))
		);
	}

	private static int provenance(final CommandContext<CommandSourceStack> ctx) throws CommandSyntaxException {
		BlockPos pos = BlockPosArgument.getLoadedBlockPos(ctx, "pos");
		ServerLevel level = ctx.getSource().getLevel();
		Owner owner = Provenance.ownerAt(level, pos);
		Protection.Verdict v = Protection.check(level, pos, null);
		String who = owner == null ? "natural (nobody placed it)" : switch (owner.kind()) {
			case PLAYER -> "placed by " + owner.name();
			case AGENT -> "placed by agent " + owner.name();
			case BASE -> "built with the " + owner.name();
		};
		String rule = v == null ? "agents may change it" : "protected (" + v.what().wire + "): " + v.hint();
		ctx.getSource().sendSuccess(() -> Component.literal(pos.toShortString() + ": " + who + "; " + rule), false);
		return 1;
	}

	private static int list(final CommandContext<CommandSourceStack> ctx) {
		StringBuilder sb = new StringBuilder("Protected zones:");
		for (Zones.Zone z : Zones.all(ctx.getSource().getServer())) {
			sb.append("\n  ").append(z.name()).append(" ").append(z.dim().identifier()).append(" ").append(z.describeBox());
		}
		ctx.getSource().sendSuccess(() -> Component.literal(sb.toString()), false);
		return 1;
	}

	private static int add(final CommandContext<CommandSourceStack> ctx) throws CommandSyntaxException {
		String name = StringArgumentType.getString(ctx, "name");
		BlockPos from = BlockPosArgument.getBlockPos(ctx, "from");
		BlockPos to = BlockPosArgument.getBlockPos(ctx, "to");
		try {
			Zones.add(ctx.getSource().getServer(), new Zones.Zone(name, ctx.getSource().getLevel().dimension(), BoundingBox.fromCorners(from, to), null));
		} catch (IllegalArgumentException e) {
			ctx.getSource().sendFailure(Component.literal(e.getMessage()));
			return 0;
		}
		ctx.getSource().sendSuccess(() -> Component.literal("Protected " + name + " " + from.toShortString() + " .. " + to.toShortString()), true);
		return 1;
	}

	private static int remove(final CommandContext<CommandSourceStack> ctx) {
		String name = StringArgumentType.getString(ctx, "name");
		boolean removed = Zones.remove(ctx.getSource().getServer(), name);
		if (!removed) {
			ctx.getSource().sendFailure(Component.literal("No named zone " + name + " (the Base cannot be removed)"));
			return 0;
		}
		ctx.getSource().sendSuccess(() -> Component.literal("Removed zone " + name), true);
		return 1;
	}
}
