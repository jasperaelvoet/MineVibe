package dev.minevibe.agent;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.mojang.brigadier.suggestion.SuggestionProvider;
import dev.minevibe.agent.job.GotoJob;
import dev.minevibe.agent.job.MineJob;
import dev.minevibe.agent.job.SitJob;
import java.util.Arrays;
import java.util.Locale;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.commands.arguments.coordinates.BlockPosArgument;
import net.minecraft.commands.arguments.coordinates.Vec3Argument;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.phys.Vec3;

/**
 * Dev commands, available only where commands are allowed (game-master permission; release worlds have
 * {@code allowCommands=false}):
 * <pre>
 * /mv agent spawn &lt;name&gt; [role]
 * /mv agent goto &lt;name&gt; &lt;x y z&gt;
 * /mv agent kill &lt;name&gt;
 * /mv agent mine &lt;name&gt; &lt;x y z&gt;     (extra, for manual S1 checks)
 * /mv agent sit &lt;name&gt; &lt;x y z&gt;
 * /mv agent follow &lt;name&gt;
 * /mv agent list
 * </pre>
 */
public final class AgentCommands {
	private AgentCommands() {
	}

	public static void register() {
		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> register(dispatcher));
	}

	private static final SuggestionProvider<CommandSourceStack> AGENT_NAMES = (ctx, builder) -> SharedSuggestionProvider.suggest(
		AgentService.get(ctx.getSource().getServer()).agents().stream().map(a -> a.getGameProfile().name()), builder
	);

	private static final SuggestionProvider<CommandSourceStack> ROLES = (ctx, builder) -> SharedSuggestionProvider.suggest(
		Arrays.stream(AgentRole.values()).map(AgentRole::id), builder
	);

	private static void register(final CommandDispatcher<CommandSourceStack> dispatcher) {
		dispatcher.register(
			Commands.literal("mv")
				.requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
				.then(
					Commands.literal("agent")
						.then(
							Commands.literal("spawn")
								.then(
									Commands.argument("name", StringArgumentType.word())
										.executes(ctx -> spawn(ctx, AgentRole.ENGINEER))
										.then(
											Commands.argument("role", StringArgumentType.word())
												.suggests(ROLES)
												.executes(ctx -> {
													AgentRole role = AgentRole.byId(StringArgumentType.getString(ctx, "role"));
													if (role == null) {
														ctx.getSource().sendFailure(Component.literal("Unknown role. Roles: " + Arrays.toString(AgentRole.values()).toLowerCase(Locale.ROOT)));
														return 0;
													}
													return spawn(ctx, role);
												})
										)
								)
						)
						.then(
							Commands.literal("goto")
								.then(
									Commands.argument("name", StringArgumentType.word())
										.suggests(AGENT_NAMES)
										.then(Commands.argument("pos", Vec3Argument.vec3()).executes(AgentCommands::goTo))
								)
						)
						.then(Commands.literal("kill").then(Commands.argument("name", StringArgumentType.word()).suggests(AGENT_NAMES).executes(AgentCommands::kill)))
						.then(
							Commands.literal("mine")
								.then(
									Commands.argument("name", StringArgumentType.word())
										.suggests(AGENT_NAMES)
										.then(Commands.argument("pos", BlockPosArgument.blockPos()).executes(AgentCommands::mine))
								)
						)
						.then(
							Commands.literal("sit")
								.then(
									Commands.argument("name", StringArgumentType.word())
										.suggests(AGENT_NAMES)
										.then(Commands.argument("pos", BlockPosArgument.blockPos()).executes(AgentCommands::sit))
								)
						)
						.then(Commands.literal("follow").then(Commands.argument("name", StringArgumentType.word()).suggests(AGENT_NAMES).executes(AgentCommands::follow)))
						.then(Commands.literal("list").executes(AgentCommands::list))
				)
		);
	}

	private static int spawn(final CommandContext<CommandSourceStack> ctx, final AgentRole role) {
		CommandSourceStack source = ctx.getSource();
		String name = StringArgumentType.getString(ctx, "name");
		AgentService service = AgentService.get(source.getServer());
		try {
			AgentPlayer agent = service.spawn(AgentService.idFromName(name), name, role, source.getLevel(), source.getPosition(), source.getRotation().y);
			ServerPlayer player = source.getPlayer();
			if (player != null && !(player instanceof AgentPlayer)) {
				agent.brain().setFollowTarget(player.getUUID());
			}
			source.sendSuccess(() -> Component.literal("Spawned " + agent.getGameProfile().name() + " (" + role.id() + ")"), true);
			return 1;
		} catch (RuntimeException e) {
			source.sendFailure(Component.literal(e.getMessage()));
			return 0;
		}
	}

	private static AgentPlayer agentArg(final CommandContext<CommandSourceStack> ctx) {
		String name = StringArgumentType.getString(ctx, "name");
		AgentPlayer agent = AgentService.get(ctx.getSource().getServer()).agentByName(name);
		if (agent == null) {
			throw new IllegalArgumentException("No agent named " + name);
		}
		return agent;
	}

	private static int goTo(final CommandContext<CommandSourceStack> ctx) {
		try {
			AgentPlayer agent = agentArg(ctx);
			Vec3 pos = Vec3Argument.getVec3(ctx, "pos");
			agent.jobs().start(new GotoJob(pos, 1.0));
			ctx.getSource().sendSuccess(() -> Component.literal(agent.getGameProfile().name() + " is walking to " + BlockPos.containing(pos).toShortString()), false);
			return 1;
		} catch (RuntimeException e) {
			ctx.getSource().sendFailure(Component.literal(e.getMessage()));
			return 0;
		}
	}

	private static int mine(final CommandContext<CommandSourceStack> ctx) throws CommandSyntaxException {
		BlockPos pos = BlockPosArgument.getLoadedBlockPos(ctx, "pos");
		try {
			AgentPlayer agent = agentArg(ctx);
			agent.jobs().start(new MineJob(pos, true));
			return 1;
		} catch (RuntimeException e) {
			ctx.getSource().sendFailure(Component.literal(e.getMessage()));
			return 0;
		}
	}

	private static int sit(final CommandContext<CommandSourceStack> ctx) throws CommandSyntaxException {
		BlockPos pos = BlockPosArgument.getLoadedBlockPos(ctx, "pos");
		try {
			AgentPlayer agent = agentArg(ctx);
			agent.jobs().start(new SitJob(pos));
			return 1;
		} catch (RuntimeException e) {
			ctx.getSource().sendFailure(Component.literal(e.getMessage()));
			return 0;
		}
	}

	private static int follow(final CommandContext<CommandSourceStack> ctx) {
		try {
			AgentPlayer agent = agentArg(ctx);
			ServerPlayer player = ctx.getSource().getPlayer();
			agent.jobs().cancel();
			agent.brain().setFollowTarget(player == null ? null : player.getUUID());
			return 1;
		} catch (RuntimeException e) {
			ctx.getSource().sendFailure(Component.literal(e.getMessage()));
			return 0;
		}
	}

	private static int kill(final CommandContext<CommandSourceStack> ctx) {
		try {
			AgentPlayer agent = agentArg(ctx);
			agent.kill(agent.level());
			return 1;
		} catch (RuntimeException e) {
			ctx.getSource().sendFailure(Component.literal(e.getMessage()));
			return 0;
		}
	}

	private static int list(final CommandContext<CommandSourceStack> ctx) {
		AgentService service = AgentService.get(ctx.getSource().getServer());
		StringBuilder sb = new StringBuilder("Agents:");
		for (AgentPlayer agent : service.agents()) {
			sb.append(String.format(
				Locale.ROOT,
				"%n %s (%s) hp=%.0f food=%d at %s reflex=%s %.3f ms/tick",
				agent.getGameProfile().name(),
				agent.role().id(),
				agent.getHealth(),
				agent.getFoodData().getFoodLevel(),
				agent.blockPosition().toShortString(),
				agent.brain().activeName(),
				agent.avgTickMillis()
			));
		}
		ctx.getSource().sendSuccess(() -> Component.literal(sb.toString()), false);
		return service.agents().size();
	}
}
