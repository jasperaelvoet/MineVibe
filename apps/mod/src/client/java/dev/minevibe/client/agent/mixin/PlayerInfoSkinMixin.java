package dev.minevibe.client.agent.mixin;

import com.mojang.authlib.GameProfile;
import dev.minevibe.client.agent.AgentSkins;
import net.minecraft.client.multiplayer.PlayerInfo;
import net.minecraft.world.entity.player.PlayerSkin;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Agents wear their role skin. An agent's profile (sent in the player-info packet) carries a
 * {@code minevibe:role} property; for those profiles the skin lookup (which would otherwise try Mojang's
 * skin service for an offline UUID) is replaced by {@code minevibe:textures/entity/agent/<role>.png}.
 */
@Mixin(PlayerInfo.class)
public abstract class PlayerInfoSkinMixin {
	@Shadow
	@Final
	private GameProfile profile;

	@Inject(method = "getSkin", at = @At("HEAD"), cancellable = true)
	private void minevibe$agentSkin(final CallbackInfoReturnable<PlayerSkin> cir) {
		PlayerSkin skin = AgentSkins.forProfile(this.profile);
		if (skin != null) {
			cir.setReturnValue(skin);
		}
	}
}
