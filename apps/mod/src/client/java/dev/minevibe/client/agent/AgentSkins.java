package dev.minevibe.client.agent;

import dev.minevibe.MineVibeMod;
import dev.minevibe.agent.AgentRole;
import dev.minevibe.agent.AgentService;
import com.mojang.authlib.GameProfile;
import java.util.EnumMap;
import java.util.Map;
import net.minecraft.core.ClientAsset;
import net.minecraft.world.entity.player.PlayerModelType;
import net.minecraft.world.entity.player.PlayerSkin;
import org.jspecify.annotations.Nullable;

/** Role skins for agents: {@code assets/minevibe/textures/entity/agent/<role>.png} (64x64, wide arms). */
public final class AgentSkins {
	private static final Map<AgentRole, PlayerSkin> SKINS = new EnumMap<>(AgentRole.class);

	private AgentSkins() {
	}

	public static PlayerSkin forRole(final AgentRole role) {
		return SKINS.computeIfAbsent(role, r -> PlayerSkin.insecure(
			new ClientAsset.ResourceTexture(MineVibeMod.id("entity/agent/" + r.id())), null, null, PlayerModelType.WIDE
		));
	}

	/** The role skin when {@code profile} is an agent profile (it carries the role property), else null. */
	public static @Nullable PlayerSkin forProfile(final GameProfile profile) {
		AgentRole role = AgentService.roleOf(profile);
		return role == null ? null : forRole(role);
	}
}
