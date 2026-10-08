package dev.minevibe.pc;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.GlobalPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.context.UseOnContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.gameevent.GameEvent;
import org.jspecify.annotations.Nullable;

/**
 * {@code linux_workstation} and {@code mac_workstation} (PLAN 7.5): place a desk, monitor and chair in one use.
 *
 * <ul>
 *   <li>Without a {@code minevibe:pc_id} component the item creates a new PC of its type: the desk is placed unbound
 *       and sends {@code pc.action{create}} (Node admits it against the budget or refuses, and the monitor shows
 *       why).</li>
 *   <li>With one, the desk binds that PC and sends {@code pc.action{plug}} (breaking it unplugged the PC). A PC that
 *       already has a desk in the world is not placed twice.</li>
 * </ul>
 * The desk faces the player; the chair stands between them.
 */
public final class WorkstationItem extends Item {
	private final String pcType;

	public WorkstationItem(final String pcType, final Item.Properties properties) {
		super(properties);
		this.pcType = pcType;
	}

	/** The PC type a fresh item creates: {@code linux} or {@code macos}. */
	public String pcType() {
		return this.pcType;
	}

	/** The item for a PC of {@code type}, bound to {@code pcId} when given. */
	public static ItemStack stackFor(final String type, final @Nullable String pcId) {
		ItemStack stack = new ItemStack("macos".equals(type) ? PcContent.MAC_WORKSTATION : PcContent.LINUX_WORKSTATION);
		if (pcId != null) {
			stack.set(PcContent.PC_ID, pcId);
		}
		return stack;
	}

	@Override
	public InteractionResult useOn(final UseOnContext context) {
		Level level = context.getLevel();
		BlockPos clicked = context.getClickedPos();
		BlockPos origin = level.getBlockState(clicked).canBeReplaced() ? clicked : clicked.relative(context.getClickedFace());
		Direction facing = context.getHorizontalDirection().getOpposite();
		Player player = context.getPlayer();
		if (!PcWorkstation.canPlace(level, origin, facing)) {
			if (player != null && !level.isClientSide()) {
				player.sendOverlayMessage(Component.translatable("message.minevibe.workstation.no_room"));
			}
			return InteractionResult.FAIL;
		}
		ItemStack stack = context.getItemInHand();
		String pcId = stack.get(PcContent.PC_ID);
		if (!(level instanceof ServerLevel serverLevel)) {
			return InteractionResult.SUCCESS;
		}
		if (pcId != null) {
			GlobalPos existing = PcRegistry.deskOf(pcId);
			if (existing != null && serverLevel.getServer().getLevel(existing.dimension()) != null) {
				if (player != null) {
					player.sendOverlayMessage(Component.translatable("message.minevibe.workstation.already_placed", pcId));
				}
				return InteractionResult.FAIL;
			}
		}
		String type = pcId != null && PcStates.get(pcId) != null ? PcStates.get(pcId).type() : this.pcType;
		PcBlockEntity be = PcWorkstation.place(serverLevel, origin, facing, type, pcId);
		if (be == null) {
			return InteractionResult.FAIL;
		}
		level.gameEvent(player, GameEvent.BLOCK_PLACE, origin);
		if (pcId != null) {
			be.requestPlug(serverLevel);
		} else {
			be.requestCreate(serverLevel);
		}
		if (player == null || !player.hasInfiniteMaterials()) {
			stack.shrink(1);
		}
		return InteractionResult.SUCCESS_SERVER;
	}
}
