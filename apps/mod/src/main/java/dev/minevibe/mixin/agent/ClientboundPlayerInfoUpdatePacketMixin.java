package dev.minevibe.mixin.agent;

import dev.minevibe.agent.AgentPlayer;
import java.util.ArrayList;
import java.util.Collection;
import java.util.EnumSet;
import java.util.List;
import net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket;
import net.minecraft.server.level.ServerPlayer;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Mutable;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Hides agents from the tab list: every player-info entry built from an {@link AgentPlayer} is sent with
 * {@code listed=false}. The entry itself is still sent (never a REMOVE), so clients keep the profile and
 * can spawn and skin the agent's body.
 */
@Mixin(ClientboundPlayerInfoUpdatePacket.class)
public abstract class ClientboundPlayerInfoUpdatePacketMixin {
	@Shadow
	@Final
	@Mutable
	private List<ClientboundPlayerInfoUpdatePacket.Entry> entries;

	@Inject(method = "<init>(Ljava/util/EnumSet;Ljava/util/Collection;)V", at = @At("RETURN"))
	private void minevibe$unlistAgents(final EnumSet<ClientboundPlayerInfoUpdatePacket.Action> actions, final Collection<ServerPlayer> players, final CallbackInfo ci) {
		this.minevibe$unlist(players);
	}

	@Inject(
		method = "<init>(Lnet/minecraft/network/protocol/game/ClientboundPlayerInfoUpdatePacket$Action;Lnet/minecraft/server/level/ServerPlayer;)V",
		at = @At("RETURN")
	)
	private void minevibe$unlistAgent(final ClientboundPlayerInfoUpdatePacket.Action action, final ServerPlayer player, final CallbackInfo ci) {
		this.minevibe$unlist(List.of(player));
	}

	private void minevibe$unlist(final Collection<ServerPlayer> players) {
		boolean anyAgent = false;
		for (ServerPlayer player : players) {
			if (player instanceof AgentPlayer) {
				anyAgent = true;
				break;
			}
		}
		if (!anyAgent) {
			return;
		}
		List<ClientboundPlayerInfoUpdatePacket.Entry> fixed = new ArrayList<>(this.entries.size());
		for (ClientboundPlayerInfoUpdatePacket.Entry e : this.entries) {
			if (e.listed() && isAgent(players, e)) {
				fixed.add(new ClientboundPlayerInfoUpdatePacket.Entry(
					e.profileId(), e.profile(), false, e.latency(), e.gameMode(), e.displayName(), e.showHat(), e.listOrder(), e.chatSession()
				));
			} else {
				fixed.add(e);
			}
		}
		this.entries = List.copyOf(fixed);
	}

	private static boolean isAgent(final Collection<ServerPlayer> players, final ClientboundPlayerInfoUpdatePacket.Entry entry) {
		for (ServerPlayer player : players) {
			if (player instanceof AgentPlayer && player.getUUID().equals(entry.profileId())) {
				return true;
			}
		}
		return false;
	}
}
