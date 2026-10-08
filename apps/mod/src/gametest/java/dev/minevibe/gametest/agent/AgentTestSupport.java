package dev.minevibe.gametest.agent;

import com.mojang.authlib.GameProfile;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentRole;
import dev.minevibe.agent.AgentService;
import io.netty.channel.embedded.EmbeddedChannel;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.gametest.framework.GameTestInfo;
import net.minecraft.gametest.framework.GameTestListener;
import net.minecraft.gametest.framework.GameTestRunner;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.PacketFlow;
import net.minecraft.network.protocol.game.ServerboundPlayerLoadedPacket;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.world.level.GameType;
import net.minecraft.world.phys.Vec3;

/** Spawning and cleanup helpers for agent GameTests. Every agent/player made here is removed when the test ends. */
final class AgentTestSupport {
	private AgentTestSupport() {
	}

	/** A unique name per run (tests share one world, and dead agents can never be spawned again). */
	static String uniqueName(final String prefix) {
		String suffix = Long.toString(ThreadLocalRandom.current().nextLong(36L * 36 * 36 * 36), 36);
		return (prefix + "_" + suffix).substring(0, Math.min(16, prefix.length() + 1 + suffix.length()));
	}

	/** Spawns an agent standing at the relative block position (x, y, z), centred in the block. */
	static AgentPlayer spawnAgent(final GameTestHelper helper, final String prefix, final AgentRole role, final double x, final double y, final double z) {
		String name = uniqueName(prefix);
		ServerLevel level = helper.getLevel();
		Vec3 pos = helper.absoluteVec(new Vec3(x + 0.5, y, z + 0.5));
		AgentPlayer agent = AgentService.get(level.getServer()).spawn(name.toLowerCase(Locale.ROOT), name, role, level, pos, 0.0F);
		onTestEnd(helper, () -> {
			AgentService service = AgentService.get(level.getServer());
			if (service.agent(agent.agentId()) == agent) {
				service.dismiss(agent);
			}
		});
		return agent;
	}

	/**
	 * A plain (non-agent) survival ServerPlayer standing still at (x, y, z), to stand in for the human
	 * player. Like vanilla's mock player, it has no client; unlike it, it is in survival so mobs target it.
	 */
	static ServerPlayer spawnHumanStandIn(final GameTestHelper helper, final double x, final double y, final double z) {
		ServerLevel level = helper.getLevel();
		GameProfile profile = new GameProfile(UUID.randomUUID(), uniqueName("human"));
		CommonListenerCookie cookie = CommonListenerCookie.createInitial(profile, false);
		ServerPlayer player = new ServerPlayer(level.getServer(), level, profile, cookie.clientInformation());
		player.snapTo(helper.absoluteVec(new Vec3(x + 0.5, y, z + 0.5)), 0.0F, 0.0F);
		Connection connection = new Connection(PacketFlow.SERVERBOUND);
		new EmbeddedChannel(connection);
		level.getServer().getPlayerList().placeNewPlayer(connection, player, cookie);
		player.connection.handleAcceptPlayerLoad(new ServerboundPlayerLoadedPacket());
		player.setGameMode(GameType.SURVIVAL);
		onTestEnd(helper, () -> {
			if (!player.hasDisconnected()) {
				player.disconnect();
				level.getServer().getPlayerList().remove(player);
			}
		});
		return player;
	}

	/** Runs {@code action} when the test passes or fails (via the test's listener list). */
	static void onTestEnd(final GameTestHelper helper, final Runnable action) {
		GameTestInfo info = testInfo(helper);
		info.addListener(new GameTestListener() {
			@Override
			public void testStructureLoaded(final GameTestInfo testInfo) {
			}

			@Override
			public void testPassed(final GameTestInfo testInfo, final GameTestRunner runner) {
				action.run();
			}

			@Override
			public void testFailed(final GameTestInfo testInfo, final GameTestRunner runner) {
				action.run();
			}

			@Override
			public void testAddedForRerun(final GameTestInfo original, final GameTestInfo copy, final GameTestRunner runner) {
			}
		});
	}

	private static GameTestInfo testInfo(final GameTestHelper helper) {
		try {
			Field field = GameTestHelper.class.getDeclaredField("testInfo");
			field.setAccessible(true);
			return (GameTestInfo)field.get(helper);
		} catch (ReflectiveOperationException e) {
			throw new IllegalStateException("GameTestHelper.testInfo not accessible", e);
		}
	}

	/** Collects numbers that tests print in one greppable line ("[S1] ..."). */
	static final class Report {
		private final List<String> parts = new ArrayList<>();
		private final String name;

		Report(final String name) {
			this.name = name;
		}

		Report add(final String key, final Object value) {
			this.parts.add(key + "=" + value);
			return this;
		}

		void print() {
			System.out.println("[S1] " + this.name + " " + String.join(" ", this.parts));
		}
	}
}
