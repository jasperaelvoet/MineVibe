package dev.minevibe.gametest.agent;

import dev.minevibe.MineVibeMod;
import dev.minevibe.agent.AgentPlayer;
import dev.minevibe.agent.AgentRole;
import dev.minevibe.agent.AgentService;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import net.fabricmc.fabric.api.client.gametest.v1.FabricClientGameTest;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;
import net.fabricmc.fabric.api.client.gametest.v1.context.TestSingleplayerContext;
import net.fabricmc.fabric.api.client.gametest.v1.world.TestWorldSave;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.client.multiplayer.PlayerInfo;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.phys.Vec3;

/**
 * Client checks for agent bodies (S1):
 * <ol>
 *   <li>agents are known to the client (their bodies render) but are not in the tab list;</li>
 *   <li>they wear their role skin (screenshot {@code minevibe-agents});</li>
 *   <li>they persist across a world reload (save, quit, reopen: restored from playerdata).</li>
 * </ol>
 * Run with {@code ./gradlew runClientGameTest} (opens a window); not part of {@code ./gradlew build}.
 */
public final class AgentClientGameTests implements FabricClientGameTest {
	private static final AgentRole[] ROLES = {AgentRole.CEO, AgentRole.MINER, AgentRole.GUARD};

	@Override
	public void runTest(final ClientGameTestContext context) {
		TestWorldSave save;
		List<UUID> ids;
		Vec3 minerPos;
		try (TestSingleplayerContext singleplayer = context.worldBuilder().create()) {
			singleplayer.getConnection().waitForChunksRender();
			ids = singleplayer.getServer().computeOnServer(server -> {
				ServerPlayer host = server.getPlayerList().getPlayers().getFirst();
				Vec3 look = Vec3.directionFromRotation(0.0F, host.getYRot());
				Vec3 side = new Vec3(-look.z, 0.0, look.x);
				List<UUID> out = new ArrayList<>();
				for (int i = 0; i < ROLES.length; i++) {
					Vec3 pos = host.position().add(look.scale(4.0)).add(side.scale((i - 1) * 1.5));
					AgentPlayer agent = AgentService.get(server)
						.spawn("skin" + ROLES[i].id(), "Skin" + ROLES[i].displayName(), ROLES[i], host.level(), pos, host.getYRot() + 180.0F);
					agent.brain().setEnabled(false);
					out.add(agent.getUUID());
				}
				return out;
			});
			context.waitTicks(30);
			context.runOnClient(client -> {
				checkClientView(client.getConnection(), client.level.players(), ids);
				System.out.println("[S1] client agents_known=" + ids.size() + " listed=" + client.getConnection().getListedOnlinePlayers().size()
					+ " online=" + client.getConnection().getOnlinePlayers().size());
			});
			context.takeScreenshot("minevibe-agents");
			minerPos = singleplayer.getServer().computeOnServer(server -> {
				AgentPlayer miner = AgentService.get(server).agent("skinminer");
				miner.setHealth(11.0F);
				// Below 18 food there is no natural regeneration, so the saved health stays put.
				miner.getFoodData().setFoodLevel(10);
				miner.getInventory().setItem(2, new ItemStack(Items.TORCH, 5));
				return miner.position();
			});
			save = singleplayer.getWorldSave();
		}

		// Quit and reopen the world: living agents come back from playerdata.
		try (TestSingleplayerContext singleplayer = save.open()) {
			singleplayer.getConnection().waitForChunksRender();
			context.waitTicks(20);
			String restored = singleplayer.getServer().computeOnServer(server -> {
				AgentService service = AgentService.get(server);
				AgentPlayer miner = service.agent("skinminer");
				if (service.agents().size() != ROLES.length || miner == null) {
					throw new AssertionError("expected " + ROLES.length + " restored agents, got " + service.agents().size());
				}
				if (miner.getHealth() != 11.0F || miner.getFoodData().getFoodLevel() != 10 || miner.getInventory().getItem(2).getCount() != 5) {
					throw new AssertionError("miner not restored: hp=" + miner.getHealth() + " food=" + miner.getFoodData().getFoodLevel()
						+ " slot2=" + miner.getInventory().getItem(2));
				}
				if (miner.position().distanceTo(minerPos) > 1.0) {
					throw new AssertionError("miner restored at " + miner.position() + ", saved " + minerPos);
				}
				return "restored=" + service.agents().size() + " miner_hp=" + miner.getHealth() + " torches=" + miner.getInventory().getItem(2).getCount();
			});
			context.runOnClient(client -> checkClientView(client.getConnection(), client.level.players(), ids));
			System.out.println("[S1] reload " + restored);
			singleplayer.getServer().runOnServer(server -> {
				AgentService service = AgentService.get(server);
				for (AgentPlayer agent : service.agents()) {
					service.dismiss(agent);
				}
			});
			context.waitTicks(5);
		}
	}

	private static void checkClientView(final ClientPacketListener connection, final List<AbstractClientPlayer> players, final List<UUID> ids) {
		for (int i = 0; i < ids.size(); i++) {
			UUID id = ids.get(i);
			PlayerInfo info = connection.getPlayerInfo(id);
			if (info == null) {
				throw new AssertionError("client has no PlayerInfo for agent " + id);
			}
			if (connection.getListedOnlinePlayers().contains(info)) {
				throw new AssertionError("agent " + info.getProfile().name() + " is listed in the tab list");
			}
			Identifier expected = MineVibeMod.id("textures/entity/agent/" + ROLES[i].id() + ".png");
			if (!info.getSkin().body().texturePath().equals(expected)) {
				throw new AssertionError("skin " + info.getSkin().body().texturePath() + " != " + expected);
			}
			AbstractClientPlayer body = null;
			for (AbstractClientPlayer p : players) {
				if (p.getUUID().equals(id)) {
					body = p;
				}
			}
			if (body == null) {
				throw new AssertionError("agent body not spawned on the client");
			}
			if (!body.getSkin().body().texturePath().equals(expected)) {
				throw new AssertionError("rendered skin " + body.getSkin().body().texturePath());
			}
		}
	}
}
