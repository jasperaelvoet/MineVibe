/*
 * Adapted from fabric-carpet (https://github.com/gnembon/fabric-carpet),
 * carpet.patches.NetHandlerPlayServerFake. Copyright (c) gnembon and contributors. MIT License.
 * Modified for MineVibe (Minecraft 26.3).
 */
package dev.minevibe.agent;

import java.util.Set;
import net.minecraft.network.Connection;
import net.minecraft.network.DisconnectionDetails;
import net.minecraft.network.chat.contents.TranslatableContents;
import net.minecraft.network.protocol.Packet;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import net.minecraft.world.entity.PositionMoveRotation;
import net.minecraft.world.entity.Relative;

/**
 * Game packet listener for agents. Installed by {@code PlayerListMixin} instead of the vanilla
 * listener when an {@link AgentPlayer} is placed in the world.
 *
 * <ul>
 *   <li>Outgoing packets are dropped (there is no client).</li>
 *   <li>Idle kicks are ignored; agents only leave through {@link AgentService}.</li>
 * </ul>
 */
public final class AgentNetHandler extends ServerGamePacketListenerImpl {
	public AgentNetHandler(final MinecraftServer server, final Connection connection, final ServerPlayer player, final CommonListenerCookie cookie) {
		super(server, connection, player, cookie);
	}

	@Override
	public void send(final Packet<?> packet) {
	}

	@Override
	public void disconnect(final DisconnectionDetails details) {
		if (details.reason().getContents() instanceof TranslatableContents text) {
			String key = text.getKey();
			if (key.equals("multiplayer.disconnect.idling") || key.equals("multiplayer.disconnect.flying")) {
				return;
			}
			if (key.equals("multiplayer.disconnect.server_shutdown")) {
				// PlayerList.saveAll() already wrote the agent's playerdata; the world is going away.
				return;
			}
		}
		if (this.player instanceof AgentPlayer agent) {
			MinecraftServer server = agent.level().getServer();
			server.execute(() -> AgentService.get(server).despawn(agent, true));
		}
	}

	@Override
	public void teleport(final PositionMoveRotation destination, final Set<Relative> relatives) {
		super.teleport(destination, relatives);
		if (this.player.level().getPlayerByUUID(this.player.getUUID()) != null) {
			this.resetPosition();
			this.player.level().getChunkSource().move(this.player);
		}
	}
}
