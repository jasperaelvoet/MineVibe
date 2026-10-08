package dev.minevibe.client.ui.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import dev.minevibe.client.chat.ChatInterceptor;
import net.minecraft.client.gui.screens.ChatScreen;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.util.StringUtil;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.ModifyArg;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * The intercepted chat box (PLAN §6.5): when MineVibe routes chat, a line may be up to 2000 characters (vanilla's
 * 256-character box and trim stay for {@code /} commands, which the server still limits), and a line the interceptor
 * refused keeps the box open with its text, so the inline hint can be acted on.
 */
@Mixin(ChatScreen.class)
public abstract class ChatScreenMixin {
	@ModifyArg(
			method = "init",
			at = @At(value = "INVOKE", target = "Lnet/minecraft/client/gui/components/EditBox;setMaxLength(I)V"))
	private int minevibe$maxLength(int vanilla) {
		return ChatInterceptor.active() ? Math.max(vanilla, ChatInterceptor.MAX_LENGTH) : vanilla;
	}

	@WrapOperation(
			method = "normalizeChatMessage",
			at = @At(value = "INVOKE", target = "Lnet/minecraft/util/StringUtil;trimChatMessage(Ljava/lang/String;)Ljava/lang/String;"))
	private String minevibe$trim(String message, Operation<String> original) {
		if (ChatInterceptor.active() && !message.startsWith("/")) {
			return StringUtil.truncateStringIfNecessary(message, ChatInterceptor.MAX_LENGTH, false);
		}
		return original.call(message);
	}

	/** A refusal left over from a line sent some other way (another mod calling sendChat) must not keep this box open. */
	@Inject(
			method = "keyPressed",
			at = @At(value = "INVOKE", target = "Lnet/minecraft/client/gui/screens/ChatScreen;handleChatInput(Ljava/lang/String;Z)V"))
	private void minevibe$forgetStaleRefusal(KeyEvent event, CallbackInfoReturnable<Boolean> cir) {
		ChatInterceptor.consumeKeepOpen();
	}

	@Inject(
			method = "keyPressed",
			at = @At(
					value = "INVOKE",
					target = "Lnet/minecraft/client/gui/screens/ChatScreen;handleChatInput(Ljava/lang/String;Z)V",
					shift = At.Shift.AFTER),
			cancellable = true)
	private void minevibe$keepRefusedLine(KeyEvent event, CallbackInfoReturnable<Boolean> cir) {
		if (ChatInterceptor.consumeKeepOpen()) cir.setReturnValue(true);
	}
}
