package dev.minevibe.org.office;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

/**
 * Where a built office is (world coordinates): its origin (local 0,0,0, the north-west floor corner), the spawn cell
 * and the slots other parts of MineVibe care about. {@link #toWorldState()} is the {@code office} object of
 * {@code world.state} (protocol §6.4): Node learns where the workstations, the meeting table and the door are.
 *
 * <p>Slot kinds: {@code workstation} (the desk's main column, see {@link OfficeBuilder.WorkstationPlacer}; {@code pcId}
 * once a PC is bound), {@code meeting_table} (primary table block), {@code codex} (anchor), {@code wall_calendar},
 * {@code chest}, {@code bed}, {@code door} (the porch cell in front of it: agents without a spawn position appear here),
 * {@code spawn}.
 */
public record OfficeLayout(BlockPos origin, BlockPos spawn, float spawnYaw, List<Slot> slots) {
	public static final String WORKSTATION = "workstation";
	public static final String MEETING_TABLE = "meeting_table";
	public static final String CODEX = "codex";
	public static final String WALL_CALENDAR = "wall_calendar";
	public static final String CHEST = "chest";
	public static final String BED = "bed";
	public static final String DOOR = "door";
	public static final String SPAWN = "spawn";

	public record Slot(String kind, BlockPos pos, @Nullable String pcId) {}

	public OfficeLayout {
		slots = List.copyOf(slots);
	}

	public List<Slot> slotsOf(final String kind) {
		return this.slots.stream().filter(s -> s.kind().equals(kind)).toList();
	}

	public @Nullable Slot firstSlot(final String kind) {
		for (Slot slot : this.slots) {
			if (slot.kind().equals(kind)) {
				return slot;
			}
		}
		return null;
	}

	/**
	 * Whether {@code pos} is part of the built office: its footprint and porch row, from the floor up to the roof. Agents
	 * never pick such blocks when they look for something to mine (the corner posts are stripped spruce logs, and
	 * {@code mine #minecraft:logs} took them apart in the acceptance run).
	 */
	public boolean covers(final BlockPos pos) {
		int x = pos.getX() - this.origin.getX();
		int y = pos.getY() - this.origin.getY();
		int z = pos.getZ() - this.origin.getZ();
		return x >= 0 && x < OfficePlan.WIDTH && z >= 0 && z <= OfficePlan.PORCH_Z && y >= 0 && y <= OfficePlan.ROOF;
	}

	/** The {@code world.state.office} object: {@code { origin, slots: [{ kind, pos, pcId? }] }}. */
	public JsonObject toWorldState() {
		JsonObject office = new JsonObject();
		office.add("origin", pos(this.origin));
		JsonArray slotArray = new JsonArray();
		for (Slot slot : this.slots) {
			JsonObject s = new JsonObject();
			s.addProperty("kind", slot.kind());
			s.add("pos", pos(slot.pos()));
			if (slot.pcId() != null) {
				s.addProperty("pcId", slot.pcId());
			}
			slotArray.add(s);
		}
		office.add("slots", slotArray);
		return office;
	}

	/** The saved form ({@code office.json}): the world-state object plus spawn and yaw. */
	public JsonObject toJson() {
		JsonObject json = this.toWorldState();
		json.add("spawn", pos(this.spawn));
		json.addProperty("spawnYaw", this.spawnYaw);
		return json;
	}

	public static OfficeLayout fromJson(final JsonObject json) {
		List<Slot> slots = new ArrayList<>();
		for (JsonElement e : json.getAsJsonArray("slots")) {
			JsonObject s = e.getAsJsonObject();
			JsonElement pcId = s.get("pcId");
			slots.add(new Slot(s.get("kind").getAsString(), readPos(s.getAsJsonObject("pos")), pcId == null || pcId.isJsonNull() ? null : pcId.getAsString()));
		}
		return new OfficeLayout(
			readPos(json.getAsJsonObject("origin")), readPos(json.getAsJsonObject("spawn")), json.get("spawnYaw").getAsFloat(), slots);
	}

	private static JsonObject pos(final BlockPos pos) {
		JsonObject o = new JsonObject();
		o.addProperty("x", pos.getX());
		o.addProperty("y", pos.getY());
		o.addProperty("z", pos.getZ());
		return o;
	}

	private static BlockPos readPos(final JsonObject o) {
		return new BlockPos(o.get("x").getAsInt(), o.get("y").getAsInt(), o.get("z").getAsInt());
	}
}
