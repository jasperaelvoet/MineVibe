package dev.minevibe.mixin.agent;

import dev.minevibe.agent.AgentPlayer;
import java.util.List;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.players.SleepStatus;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyVariable;

/** Agents never count toward the sleep quorum: neither as active players nor as sleepers. */
@Mixin(SleepStatus.class)
public abstract class SleepStatusMixin {
	@ModifyVariable(method = "update", at = @At("HEAD"), argsOnly = true)
	private List<ServerPlayer> minevibe$withoutAgents(final List<ServerPlayer> players) {
		return withoutAgents(players);
	}

	@ModifyVariable(method = "areEnoughDeepSleeping", at = @At("HEAD"), argsOnly = true)
	private List<ServerPlayer> minevibe$deepSleepersWithoutAgents(final List<ServerPlayer> players) {
		return withoutAgents(players);
	}

	private static List<ServerPlayer> withoutAgents(final List<ServerPlayer> players) {
		for (ServerPlayer player : players) {
			if (player instanceof AgentPlayer) {
				return players.stream().filter(p -> !(p instanceof AgentPlayer)).toList();
			}
		}
		return players;
	}
}
