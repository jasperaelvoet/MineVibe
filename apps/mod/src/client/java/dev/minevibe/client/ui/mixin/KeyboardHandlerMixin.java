package dev.minevibe.client.ui.mixin;

import dev.minevibe.client.ui.input.UiKeys;
import net.minecraft.client.KeyboardHandler;
import net.minecraft.client.input.KeyEvent;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Observes key presses for Alt+1-4 (PLAN §7.8). It never cancels anything: the hotbar keys keep selecting slots, as the
 * plan requires ("the hotbar keys are never consumed").
 */
@Mixin(KeyboardHandler.class)
public abstract class KeyboardHandlerMixin {
	@Inject(method = "keyPress", at = @At("HEAD"))
	private void minevibe$answerHotkeys(long handle, int action, KeyEvent event, CallbackInfo ci) {
		UiKeys.onKey(action, event);
	}
}
