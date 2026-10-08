package dev.minevibe.agent.skill;

import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.mojang.brigadier.suggestion.SuggestionProvider;
import dev.minevibe.agent.AgentService;
import dev.minevibe.agent.skill.seat.PcRegistry;
import dev.minevibe.agent.skill.seat.Seats;
import dev.minevibe.agent.skill.seat.SimplePcRegistry;
import dev.minevibe.bridge.BridgeException;
import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.msg.Skills;
import dev.minevibe.bridge.msg.Ui;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.commands.arguments.coordinates.BlockPosArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;

/**
 * Dev commands that drive the skill API the way Node does (game-master permission only; release worlds have commands
 * off):
 * <pre>
 * /mv skill &lt;agent&gt; &lt;skill&gt; [args json]     skill.run (replace, waitMs 0); the outcome is printed when it ends
 * /mv obs &lt;agent&gt; &lt;query&gt; [args json]       obs.query
 * /mv mode &lt;agent&gt; &lt;follow|stay|guard|wander&gt;
 * /mv approach &lt;agent&gt; &lt;present|queue|ping|release&gt;
 * /mv pcbind &lt;pcId&gt; &lt;chair x y z&gt;          binds a PC id to an office chair in the built-in registry (status running)
 * /mv sit &lt;agent&gt; &lt;pcId&gt;                     agent.seat
 * /mv stand &lt;agent&gt;                            agent.unseat
 * </pre>
 */
public final class SkillCommands {
	private static final AtomicLong SEQ = new AtomicLong();

	private SkillCommands() {
	}

	public static void register() {
		CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> register(dispatcher));
	}

	private static final SuggestionProvider<CommandSourceStack> AGENTS = (ctx, builder) -> SharedSuggestionProvider.suggest(
		AgentService.get(ctx.getSource().getServer()).agents().stream().map(a -> a.agentId()), builder);

	private static final SuggestionProvider<CommandSourceStack> SKILL_NAMES = (ctx, builder) -> SharedSuggestionProvider.suggest(Skills.SKILL_NAMES, builder);

	private static final SuggestionProvider<CommandSourceStack> QUERIES = (ctx, builder) -> SharedSuggestionProvider.suggest(Skills.OBS_QUERIES, builder);

	private static void register(final CommandDispatcher<CommandSourceStack> dispatcher) {
		dispatcher.register(Commands.literal("mv")
			.requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
			.then(Commands.literal("skill")
				.then(Commands.argument("agent", StringArgumentType.word()).suggests(AGENTS)
					.then(Commands.argument("skill", StringArgumentType.word()).suggests(SKILL_NAMES)
						.executes(ctx -> skill(ctx, "{}"))
						.then(Commands.argument("args", StringArgumentType.greedyString())
							.executes(ctx -> skill(ctx, StringArgumentType.getString(ctx, "args")))))))
			.then(Commands.literal("obs")
				.then(Commands.argument("agent", StringArgumentType.word()).suggests(AGENTS)
					.then(Commands.argument("query", StringArgumentType.word()).suggests(QUERIES)
						.executes(ctx -> obs(ctx, "{}"))
						.then(Commands.argument("args", StringArgumentType.greedyString())
							.executes(ctx -> obs(ctx, StringArgumentType.getString(ctx, "args")))))))
			.then(Commands.literal("mode")
				.then(Commands.argument("agent", StringArgumentType.word()).suggests(AGENTS)
					.then(Commands.argument("mode", StringArgumentType.word())
						.suggests((ctx, b) -> SharedSuggestionProvider.suggest(new String[] {"follow", "stay", "guard", "wander"}, b))
						.executes(ctx -> call(ctx, () -> service(ctx).mode(new Bodies.AgentMode(
							StringArgumentType.getString(ctx, "agent"), StringArgumentType.getString(ctx, "mode"), null)))))))
			.then(Commands.literal("approach")
				.then(Commands.argument("agent", StringArgumentType.word()).suggests(AGENTS)
					.then(Commands.argument("role", StringArgumentType.word())
						.suggests((ctx, b) -> SharedSuggestionProvider.suggest(new String[] {"present", "present_seated", "queue", "ping", "release"}, b))
						.executes(ctx -> call(ctx, () -> {
							service(ctx).approach(new Ui.AgentApproach(StringArgumentType.getString(ctx, "agent"), "dev", StringArgumentType.getString(ctx, "role")));
							return Map.of();
						})))))
			.then(Commands.literal("pcbind")
				.then(Commands.argument("pcId", StringArgumentType.word())
					.then(Commands.argument("chair", BlockPosArgument.blockPos()).executes(SkillCommands::pcbind))))
			.then(Commands.literal("sit")
				.then(Commands.argument("agent", StringArgumentType.word()).suggests(AGENTS)
					.then(Commands.argument("pcId", StringArgumentType.word())
						.executes(ctx -> call(ctx, () -> service(ctx).seat(new dev.minevibe.bridge.msg.Seats.AgentSeat(
							StringArgumentType.getString(ctx, "agent"), "dev-" + SEQ.incrementAndGet(), System.currentTimeMillis(),
							dev.minevibe.bridge.msg.Seats.SeatTarget.pc(StringArgumentType.getString(ctx, "pcId")), "dev command")))))))
			.then(Commands.literal("stand")
				.then(Commands.argument("agent", StringArgumentType.word()).suggests(AGENTS)
					.executes(ctx -> call(ctx, () -> service(ctx).unseat(new dev.minevibe.bridge.msg.Seats.AgentUnseat(
						StringArgumentType.getString(ctx, "agent"), Long.MAX_VALUE / 2, "stand", false)))))));
	}

	private static SkillService service(final CommandContext<CommandSourceStack> ctx) {
		return SkillService.get(ctx.getSource().getServer());
	}

	private interface Call {
		Map<String, Object> run();
	}

	private static int call(final CommandContext<CommandSourceStack> ctx, final Call call) {
		try {
			Map<String, Object> out = call.run();
			ctx.getSource().sendSuccess(() -> Component.literal("ok " + out), false);
			return 1;
		} catch (BridgeException e) {
			ctx.getSource().sendFailure(Component.literal(e.code() + ": " + e.getMessage()));
			return 0;
		}
	}

	private static int skill(final CommandContext<CommandSourceStack> ctx, final String args) {
		CommandSourceStack source = ctx.getSource();
		String jobId = "dev-" + SEQ.incrementAndGet();
		try {
			JsonObject json = JsonParser.parseString(args).getAsJsonObject();
			service(ctx).run(new Skills.SkillRun(jobId, StringArgumentType.getString(ctx, "agent"), StringArgumentType.getString(ctx, "skill"), json, 0, true));
			SkillService.Handle h = service(ctx).handle(jobId);
			if (h != null) {
				h.job().outcome().thenAccept(o -> source.sendSystemMessage(Component.literal(jobId + " " + o.status()
					+ (o.code() == null ? "" : " " + o.code() + ": " + o.message()) + " " + o.result())));
			}
			source.sendSuccess(() -> Component.literal("started " + jobId), false);
			return 1;
		} catch (BridgeException e) {
			source.sendFailure(Component.literal(e.code() + ": " + e.getMessage()));
			return 0;
		} catch (JsonParseException | IllegalStateException e) {
			source.sendFailure(Component.literal("args must be a JSON object: " + e.getMessage()));
			return 0;
		}
	}

	private static int obs(final CommandContext<CommandSourceStack> ctx, final String args) {
		try {
			JsonObject json = JsonParser.parseString(args).getAsJsonObject();
			Map<String, Object> out = service(ctx).obs(new Skills.ObsQuery(StringArgumentType.getString(ctx, "agent"), StringArgumentType.getString(ctx, "query"), json));
			ctx.getSource().sendSuccess(() -> Component.literal(String.valueOf(out.get("result"))), false);
			return 1;
		} catch (BridgeException e) {
			ctx.getSource().sendFailure(Component.literal(e.code() + ": " + e.getMessage()));
			return 0;
		} catch (JsonParseException | IllegalStateException e) {
			ctx.getSource().sendFailure(Component.literal("args must be a JSON object: " + e.getMessage()));
			return 0;
		}
	}

	private static int pcbind(final CommandContext<CommandSourceStack> ctx) throws CommandSyntaxException {
		PcRegistry pcs = Seats.pcs();
		if (!(pcs instanceof SimplePcRegistry simple)) {
			ctx.getSource().sendFailure(Component.literal("the PC blocks own the registry; place a workstation instead"));
			return 0;
		}
		BlockPos chair = BlockPosArgument.getLoadedBlockPos(ctx, "chair");
		String pcId = StringArgumentType.getString(ctx, "pcId");
		simple.register(pcId, ctx.getSource().getLevel().dimension(), chair);
		simple.setStatus(pcId, "running");
		ctx.getSource().sendSuccess(() -> Component.literal(pcId + " -> chair at " + chair.toShortString()), false);
		return 1;
	}
}
