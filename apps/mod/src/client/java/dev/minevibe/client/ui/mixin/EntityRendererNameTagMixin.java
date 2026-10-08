package dev.minevibe.client.ui.mixin;

import dev.minevibe.client.ui.NameTags;
import net.minecraft.client.renderer.entity.EntityRenderer;
import net.minecraft.network.chat.Component;
import net.minecraft.world.entity.Entity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Adds the {@code [H]}/{@code [O]} model suffix to agent name tags (PLAN §7.8). */
@Mixin(EntityRenderer.class)
public abstract class EntityRendererNameTagMixin {
	@Inject(method = "getNameTag", at = @At("RETURN"), cancellable = true)
	private void minevibe$modelSuffix(Entity entity, CallbackInfoReturnable<Component> cir) {
		Component tag = cir.getReturnValue();
		Component decorated = NameTags.decorate(entity, tag);
		if (decorated != tag) cir.setReturnValue(decorated);
	}
}
