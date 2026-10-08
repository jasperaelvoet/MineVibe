package dev.minevibe.agent;

import dev.minevibe.agent.nav.NavProxyMob;
import dev.minevibe.world.MvWorldContent;
import net.fabricmc.api.ModInitializer;

/**
 * Common entrypoint for agent bodies (spike S1, PLAN 7.1-7.3 and 7.5 seats). Kept separate from
 * {@code MineVibeMod} so the body code can be developed in parallel; listed under {@code main} in
 * {@code fabric.mod.json}.
 */
public final class AgentModInit implements ModInitializer {
	@Override
	public void onInitialize() {
		MvWorldContent.register();
		NavProxyMob.register();
		AgentService.registerEvents();
		AgentCommands.register();
	}
}
