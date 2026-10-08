package dev.minevibe.client.mixin;

import net.minecraft.client.gui.screens.DeathScreen;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** Reads the cause of death the server sent, so GameOverScreen can show it. */
@Mixin(DeathScreen.class)
public interface DeathScreenAccessor {
	@Accessor("causeOfDeath")
	@Nullable Component minevibe$causeOfDeath();
}
