package dev.minevibe.client.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import dev.minevibe.client.menu.NonPausingScreens;
import net.minecraft.client.gui.Gui;
import net.minecraft.client.gui.screens.Screen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

/**
 * {@code Gui#isPausing} is the only place the screen decides whether the game (and the integrated server) pauses.
 * Screens opened from the MineVibe menu, e.g. vanilla's Options, are pause screens by default; here they are not
 * ({@link NonPausingScreens}). Wrapping the call rather than {@code Screen#isPauseScreen} also covers subclasses that
 * override it.
 */
@Mixin(Gui.class)
public abstract class GuiIsPausingMixin {
	@WrapOperation(
		method = "isPausing",
		at = @At(value = "INVOKE", target = "Lnet/minecraft/client/gui/screens/Screen;isPauseScreen()Z")
	)
	private boolean minevibe$neverPauseFromTheMineVibeMenu(final Screen screen, final Operation<Boolean> original) {
		return !NonPausingScreens.isMarked(screen) && original.call(screen);
	}
}
