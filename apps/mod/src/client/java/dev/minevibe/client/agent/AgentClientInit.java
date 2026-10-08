package dev.minevibe.client.agent;

import dev.minevibe.agent.nav.NavProxyMob;
import dev.minevibe.world.MvWorldContent;
import net.fabricmc.api.ClientModInitializer;
import net.minecraft.client.renderer.entity.EntityRenderers;
import net.minecraft.client.renderer.entity.NoopRenderer;

/**
 * Client entrypoint for agent bodies (S1). Separate from {@code MineVibeClient} so this work can land
 * independently. Role skins come from {@code PlayerInfoSkinMixin}.
 */
public final class AgentClientInit implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		// Seats are invisible; the nav proxy is never spawned but every entity type needs a renderer entry.
		EntityRenderers.register(MvWorldContent.SEAT, NoopRenderer::new);
		EntityRenderers.register(NavProxyMob.TYPE, NoopRenderer::new);
	}
}
