package dev.minevibe.client.ui;

import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;
import net.minecraft.world.entity.Entity;
import org.jspecify.annotations.Nullable;

/**
 * Agent name tags (PLAN §7.8): the vanilla tag plus the model suffix, {@code [H]} for Haiku or {@code [O]} for Opus.
 * Applied by {@code EntityRendererNameTagMixin} at the end of {@code EntityRenderer#getNameTag}.
 */
public final class NameTags {
	private NameTags() {}

	public static @Nullable Component decorate(Entity entity, @Nullable Component tag) {
		if (tag == null) return null;
		AgentView agent = AgentEntities.viewOf(entity);
		if (agent == null) return tag;
		ChatFormatting color = "opus".equals(agent.model()) ? ChatFormatting.LIGHT_PURPLE : ChatFormatting.AQUA;
		return tag.copy().append(Component.literal(" " + agent.modelSuffix()).withStyle(color));
	}
}
