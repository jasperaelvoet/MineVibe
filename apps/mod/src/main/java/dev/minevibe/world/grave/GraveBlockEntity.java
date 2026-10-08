package dev.minevibe.world.grave;

import dev.minevibe.world.MvWorldContent;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.NonNullList;
import net.minecraft.network.chat.Component;
import net.minecraft.world.ContainerHelper;
import net.minecraft.world.Containers;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.storage.ValueInput;
import net.minecraft.world.level.storage.ValueOutput;

/**
 * Holds a dead agent's inventory and epitaph ("Name", "Role", "Day N"). Using or breaking the grave
 * drops the items.
 */
public final class GraveBlockEntity extends BlockEntity {
	public static final int SIZE = 54;

	private final NonNullList<ItemStack> items = NonNullList.withSize(SIZE, ItemStack.EMPTY);
	private String agentId = "";
	private String name = "";
	private String role = "";
	private int day;

	public GraveBlockEntity(final BlockPos pos, final BlockState state) {
		super(MvWorldContent.GRAVE_BLOCK_ENTITY, pos, state);
	}

	public void fill(final String agentId, final String name, final String role, final int day, final List<ItemStack> stacks) {
		this.agentId = agentId;
		this.name = name;
		this.role = role;
		this.day = day;
		int slot = 0;
		for (ItemStack stack : stacks) {
			if (stack.isEmpty()) {
				continue;
			}
			if (slot >= SIZE) {
				break;
			}
			this.items.set(slot++, stack);
		}
		this.setChanged();
	}

	public String agentId() {
		return this.agentId;
	}

	public String name() {
		return this.name;
	}

	public String role() {
		return this.role;
	}

	public int day() {
		return this.day;
	}

	/** The three epitaph lines, also written on the sign: name, role, "Day N". */
	public List<Component> epitaph() {
		return List.of(Component.literal(this.name), Component.literal(this.role), Component.literal("Day " + this.day));
	}

	public List<ItemStack> items() {
		return this.items;
	}

	public int itemCount() {
		int count = 0;
		for (ItemStack stack : this.items) {
			count += stack.getCount();
		}
		return count;
	}

	public void dropItems() {
		if (this.level != null) {
			Containers.dropContents(this.level, this.worldPosition, this.items);
			this.items.replaceAll(s -> ItemStack.EMPTY);
			this.setChanged();
		}
	}

	@Override
	public void preRemoveSideEffects(final BlockPos pos, final BlockState state) {
		this.dropItems();
	}

	@Override
	protected void saveAdditional(final ValueOutput output) {
		super.saveAdditional(output);
		ContainerHelper.saveAllItems(output, this.items);
		output.putString("agent_id", this.agentId);
		output.putString("name", this.name);
		output.putString("role", this.role);
		output.putInt("day", this.day);
	}

	@Override
	protected void loadAdditional(final ValueInput input) {
		super.loadAdditional(input);
		this.items.replaceAll(s -> ItemStack.EMPTY);
		ContainerHelper.loadAllItems(input, this.items);
		this.agentId = input.getStringOr("agent_id", "");
		this.name = input.getStringOr("name", "");
		this.role = input.getStringOr("role", "");
		this.day = input.getIntOr("day", 0);
	}
}
