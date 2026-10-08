package dev.minevibe.client.ui.mixin;

import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.ChatScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** Reads the chat box, so the inline hint is shown only while it still holds the refused line. */
@Mixin(ChatScreen.class)
public interface ChatScreenAccessor {
	@Accessor("input")
	EditBox minevibe$input();
}
