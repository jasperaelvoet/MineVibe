/*
 * Pattern from fabric-carpet (https://github.com/gnembon/fabric-carpet), PlayerList_fakePlayersMixin.
 * Copyright (c) gnembon and contributors. MIT License. Rewritten for MineVibe with MixinExtras.
 */
package dev.minevibe.mixin.agent;

import com.llamalad7.mixinextras.injector.v2.WrapWithCondition;
import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import dev.minevibe.agent.AgentNetHandler;
import dev.minevibe.agent.AgentPlayer;
import net.minecraft.network.Connection;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import net.minecraft.server.players.NameAndId;
import net.minecraft.server.players.PlayerList;
import net.minecraft.server.players.UserNameToIdResolver;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

/**
 * Agents get an {@link AgentNetHandler} instead of the vanilla game listener, their arrival is not announced in chat
 * ("Ada joined the game"), and their names never go into {@code usercache.json} (it lives in the game directory and
 * outlives every world and its crew).
 */
@Mixin(PlayerList.class)
public abstract class PlayerListMixin {
	@WrapOperation(
		method = "placeNewPlayer",
		at = @At(value = "NEW", target = "net/minecraft/server/network/ServerGamePacketListenerImpl")
	)
	private ServerGamePacketListenerImpl minevibe$agentNetHandler(
		final MinecraftServer server,
		final Connection connection,
		final ServerPlayer player,
		final CommonListenerCookie cookie,
		final Operation<ServerGamePacketListenerImpl> original
	) {
		if (player instanceof AgentPlayer) {
			return new AgentNetHandler(server, connection, player, cookie);
		}
		return original.call(server, connection, player, cookie);
	}

	@WrapWithCondition(
		method = "placeNewPlayer",
		at = @At(value = "INVOKE", target = "Lnet/minecraft/server/players/PlayerList;broadcastSystemMessage(Lnet/minecraft/network/chat/Component;Z)V")
	)
	private boolean minevibe$quietAgentJoin(
		final PlayerList self,
		final Component message,
		final boolean overlay,
		final Connection connection,
		final ServerPlayer player,
		final CommonListenerCookie cookie
	) {
		return !(player instanceof AgentPlayer);
	}

	@WrapWithCondition(
		method = "placeNewPlayer",
		at = @At(value = "INVOKE", target = "Lnet/minecraft/server/players/UserNameToIdResolver;add(Lnet/minecraft/server/players/NameAndId;)V")
	)
	private boolean minevibe$keepAgentsOutOfTheUserCache(
		final UserNameToIdResolver cache,
		final NameAndId nameAndId,
		final Connection connection,
		final ServerPlayer player,
		final CommonListenerCookie cookie
	) {
		return !(player instanceof AgentPlayer);
	}
}
