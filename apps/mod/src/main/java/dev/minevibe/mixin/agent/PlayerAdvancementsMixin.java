package dev.minevibe.mixin.agent;

import com.llamalad7.mixinextras.injector.v2.WrapWithCondition;
import dev.minevibe.agent.AgentPlayer;
import net.minecraft.network.chat.Component;
import net.minecraft.server.PlayerAdvancements;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.players.PlayerList;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;

/**
 * Agents earn advancements like any player (PLAN §7.1: they are real players), but the "Ada has made the advancement
 * [Stone Age]" lines are not broadcast: with a crew mining and crafting all day they would drown the chat the player
 * uses to talk to them.
 */
@Mixin(PlayerAdvancements.class)
public abstract class PlayerAdvancementsMixin {
	@Shadow
	private ServerPlayer player;

	/** The announcement sits in the lambda {@code award} passes to {@code display().ifPresent(...)}. */
	@WrapWithCondition(
		method = "lambda$award$0",
		at = @At(value = "INVOKE", target = "Lnet/minecraft/server/players/PlayerList;broadcastSystemMessage(Lnet/minecraft/network/chat/Component;Z)V")
	)
	private boolean minevibe$quietAgentAdvancements(final PlayerList playerList, final Component message, final boolean overlay) {
		return !(this.player instanceof AgentPlayer);
	}
}
