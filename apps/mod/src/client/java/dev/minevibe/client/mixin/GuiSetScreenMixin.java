package dev.minevibe.client.mixin;

import dev.minevibe.client.boot.ScreenRouter;
import net.minecraft.client.gui.Gui;
import net.minecraft.client.gui.screens.Screen;
import org.jspecify.annotations.Nullable;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.ModifyVariable;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * The single screen choke point (PLAN §7.9, API_MAP 1.1): every screen goes through {@code Gui#setScreen(Screen)}.
 *
 * <ul>
 *   <li>{@code HEAD}: the screen the caller asked for (TitleScreen, DisconnectedScreen, DeathScreen, PauseScreen).</li>
 *   <li>{@code STORE}: the screens {@code setScreen(null)} makes up itself before storing them in the same local
 *       (TitleScreen when there is no level, DeathScreen when the player is dead).</li>
 *   <li>{@code TAIL}: logs the screen that really ended up in {@code Gui.screen}.</li>
 * </ul>
 * Both rewrites happen before {@code this.screen = screen} loads the local, so the field, {@code added()} and
 * {@code init()} all see the replacement.
 */
@Mixin(Gui.class)
public abstract class GuiSetScreenMixin {
	@Shadow
	private @Nullable Screen screen;

	@ModifyVariable(method = "setScreen", at = @At("HEAD"), argsOnly = true)
	private @Nullable Screen minevibe$routeRequested(@Nullable Screen requested) {
		return ScreenRouter.route(requested, true);
	}

	@ModifyVariable(method = "setScreen", at = @At("STORE"), argsOnly = true)
	private @Nullable Screen minevibe$routeSubstitute(@Nullable Screen substitute) {
		return ScreenRouter.route(substitute, false);
	}

	@Inject(method = "setScreen", at = @At("TAIL"))
	private void minevibe$logScreen(@Nullable Screen ignored, CallbackInfo ci) {
		ScreenRouter.shown(this.screen);
	}
}
