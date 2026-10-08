package dev.minevibe.org.calendar;

import dev.minevibe.org.OrgScreens;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.Level;

/**
 * {@code minevibe:calendar} (PLAN §6.6, §7.5): the handheld calendar. Using it opens the same CalendarScreen as a
 * wall calendar, anywhere in the world.
 */
public final class CalendarItem extends Item {
	public CalendarItem(final Item.Properties properties) {
		super(properties);
	}

	@Override
	public InteractionResult use(final Level level, final Player player, final InteractionHand hand) {
		if (level.isClientSide()) {
			OrgScreens.openCalendar();
		}
		return InteractionResult.SUCCESS;
	}
}
