package dev.minevibe.bridge.protocol;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.minevibe.org.office.OfficeLayout;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * {@code world.state.office} slot kinds (protocol §6.4): the schema accepts exactly the kinds the mod's OfficeLayout
 * produces (a PC desk is a {@code workstation}, never {@code pc}), so the two cannot drift apart.
 */
class WorldStateOfficeTest {
	/** Every {@code public static final String} constant of OfficeLayout: its slot kinds. */
	private static Set<String> layoutKinds() throws IllegalAccessException {
		Set<String> kinds = new TreeSet<>();
		for (Field f : OfficeLayout.class.getDeclaredFields()) {
			int m = f.getModifiers();
			if (Modifier.isPublic(m) && Modifier.isStatic(m) && Modifier.isFinal(m) && f.getType() == String.class) {
				kinds.add((String) f.get(null));
			}
		}
		return kinds;
	}

	private static JsonObject officeState(final List<OfficeLayout.Slot> slots) {
		OfficeLayout layout = new OfficeLayout(new BlockPos(-6, 63, -6), new BlockPos(0, 64, 0), 180.0F, slots);
		JsonObject message = new JsonObject();
		message.addProperty("t", "world.state");
		message.addProperty("v", 1);
		message.addProperty("worldId", "world-7");
		message.addProperty("phase", "ready");
		message.add("office", layout.toWorldState());
		return message;
	}

	@Test
	void theSchemaKnowsExactlyTheLayoutsSlotKinds() throws IllegalAccessException {
		assertEquals(layoutKinds(), new TreeSet<>(Messages.WorldState.OFFICE_SLOT_KINDS));
		assertTrue(Messages.WorldState.OFFICE_SLOT_KINDS.contains(OfficeLayout.WORKSTATION));
	}

	@Test
	void anOfficeWithEveryKindValidates() throws IllegalAccessException {
		List<OfficeLayout.Slot> slots = new ArrayList<>();
		int x = 0;
		for (String kind : layoutKinds()) {
			slots.add(new OfficeLayout.Slot(kind, new BlockPos(x++, 64, 0), OfficeLayout.WORKSTATION.equals(kind) ? "linux-1" : null));
		}
		assertEquals(List.of(), Messages.WORLD_STATE.schema().validate(officeState(slots)));
	}

	@Test
	void aPcSlotKindOrABadPcIdIsRejected() {
		JsonObject pc = officeState(List.of(new OfficeLayout.Slot("pc", new BlockPos(1, 64, 1), "linux-1")));
		assertFalse(Messages.WORLD_STATE.schema().validate(pc).isEmpty(), "the old name \"pc\" is not a slot kind");

		JsonObject badId = officeState(List.of(new OfficeLayout.Slot(OfficeLayout.WORKSTATION, new BlockPos(1, 64, 1), "Linux 1")));
		assertFalse(Messages.WORLD_STATE.schema().validate(badId).isEmpty(), "pcId is a PcId");

		JsonObject empty = officeState(List.of());
		JsonArray slots = empty.getAsJsonObject("office").getAsJsonArray("slots");
		assertEquals(0, slots.size());
		assertEquals(List.of(), Messages.WORLD_STATE.schema().validate(empty));
	}
}
