package dev.minevibe.client.progression;

import dev.minevibe.MineVibeMod;
import java.util.List;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.item.v1.ItemTooltipCallback;
import net.minecraft.ChatFormatting;
import net.minecraft.client.Minecraft;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.locale.Language;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.item.ItemStack;
import org.jspecify.annotations.Nullable;

/**
 * Client side of the survival start (PLAN 7.5 "Agent Core"): every MineVibe item says what it is for in its tooltip.
 * One grey line ({@code item.minevibe.<id>.tooltip}, or {@code block.minevibe.<id>.tooltip} for block items), and,
 * while Shift is held, how to use it ({@code ….tooltip.detail}); otherwise a "Hold Shift" hint. Items without those
 * lang keys get nothing.
 */
public final class ProgressionClientInit implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		ItemTooltipCallback.EVENT.register((stack, context, flag, lines) -> append(stack, lines));
	}

	static void append(final ItemStack stack, final List<Component> lines) {
		Identifier id = BuiltInRegistries.ITEM.getKey(stack.getItem());
		if (!MineVibeMod.MOD_ID.equals(id.getNamespace())) {
			return;
		}
		String key = tooltipKey(id.getPath());
		if (key == null) {
			return;
		}
		// Right under the name: the first line is the name itself.
		int at = Math.min(1, lines.size());
		lines.add(at, Component.translatable(key).withStyle(ChatFormatting.GRAY));
		String detail = key + ".detail";
		if (!Language.getInstance().has(detail)) {
			return;
		}
		if (Minecraft.getInstance().hasShiftDown()) {
			lines.add(at + 1, Component.translatable(detail).withStyle(ChatFormatting.DARK_AQUA));
		} else {
			lines.add(at + 1, Component.translatable("tooltip.minevibe.hold_shift").withStyle(ChatFormatting.DARK_GRAY, ChatFormatting.ITALIC));
		}
	}

	/** The tooltip key of the item {@code minevibe:<path>}, or null when the lang file has none. */
	static @Nullable String tooltipKey(final String path) {
		Language language = Language.getInstance();
		for (String prefix : new String[] {"item.minevibe.", "block.minevibe."}) {
			String key = prefix + path + ".tooltip";
			if (language.has(key)) {
				return key;
			}
		}
		return null;
	}
}
