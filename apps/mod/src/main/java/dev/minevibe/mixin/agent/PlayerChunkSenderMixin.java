package dev.minevibe.mixin.agent;

import dev.minevibe.agent.AgentPlayer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.PlayerChunkSender;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Agents have no client, so never build chunk packets for them (each one serializes a whole chunk with
 * light). Chunks stay "pending" for agents, which also means the server never builds entity-tracking
 * packets for their connection. Chunk loading and ticking (player tickets) are unaffected.
 */
@Mixin(PlayerChunkSender.class)
public abstract class PlayerChunkSenderMixin {
	@Inject(method = "sendNextChunks", at = @At("HEAD"), cancellable = true)
	private void minevibe$skipAgents(final ServerPlayer player, final CallbackInfo ci) {
		if (player instanceof AgentPlayer) {
			ci.cancel();
		}
	}
}
