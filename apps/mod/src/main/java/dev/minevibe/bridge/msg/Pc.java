package dev.minevibe.bridge.msg;

import static dev.minevibe.bridge.msg.Types.ABS_PATH;
import static dev.minevibe.bridge.msg.Types.AGENT_ID;
import static dev.minevibe.bridge.msg.Types.BLOCK_POS;
import static dev.minevibe.bridge.msg.Types.CONSENT_ID;
import static dev.minevibe.bridge.msg.Types.FRACTION;
import static dev.minevibe.bridge.msg.Types.NON_NEG_INT;
import static dev.minevibe.bridge.msg.Types.OCCUPANT;
import static dev.minevibe.bridge.msg.Types.PC_ID;
import static dev.minevibe.bridge.msg.Types.PIXEL;
import static dev.minevibe.bridge.msg.Types.UINT32;
import static dev.minevibe.bridge.msg.Types.type;
import static dev.minevibe.bridge.protocol.Schema.MAX_SAFE_INTEGER;
import static dev.minevibe.bridge.protocol.Schema.array;
import static dev.minevibe.bridge.protocol.Schema.bool;
import static dev.minevibe.bridge.protocol.Schema.decimal;
import static dev.minevibe.bridge.protocol.Schema.integer;
import static dev.minevibe.bridge.protocol.Schema.literal;
import static dev.minevibe.bridge.protocol.Schema.nullable;
import static dev.minevibe.bridge.protocol.Schema.object;
import static dev.minevibe.bridge.protocol.Schema.oneOf;
import static dev.minevibe.bridge.protocol.Schema.string;
import static dev.minevibe.bridge.protocol.Schema.union;

import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.MessageType.Direction;
import dev.minevibe.bridge.protocol.Messages.BlockPos;
import dev.minevibe.bridge.protocol.Schema;
import java.util.List;
import org.jspecify.annotations.Nullable;

/** PC group (PLAN §5, §7.5-7.7, §8): PC state, budget, frame tiers, input, config and actions. Mirrors {@code pc.ts}. */
public final class Pc {
	private Pc() {}

	public static final List<String> TYPES_OF_PC = List.of("linux", "linux-slim", "macos");

	/** {@code PcStatus} values. */
	public static final List<String> STATUSES = List.of(
			"off", "downloading", "awaiting_consent", "booting", "running", "stopping", "remounting", "reimaging", "no_capacity",
			"macos_slots_full", "engine_down", "error", "decommissioned");

	/** {@code pc.action} actions. */
	public static final List<String> ACTIONS = List.of(
			"create", "start", "stop", "restart", "reimage", "decommission", "reissue", "unplug", "plug", "kick", "watch", "unwatch");

	// -----------------------------------------------------------------------------------------
	// Records
	// -----------------------------------------------------------------------------------------

	/** {@code mode}: rw or ro. */
	public record VaultMount(String hostPath, String mode) {}

	/** {@code kind}: coming or away. */
	public record Reservation(String agentId, String kind) {}

	public record Screen(int w, int h) {}

	public record ConsentPrompt(String consentId, String what, long bytes, long freeBytes) {}

	/** {@code PhoneStatus} values: the Android phone of a PC (PLAN §8.8). */
	public static final List<String> PHONE_STATUSES = List.of("off", "preparing", "starting", "running", "error");

	/** Nested virtualization; {@code unavailable} says why this Mac cannot have it (null when it can). */
	public record VirtualizationCapability(boolean enabled, @Nullable String unavailable) {}

	/** The Android phone; {@code status} is one of {@link #PHONE_STATUSES}, {@code progress} set while preparing. */
	public record AndroidCapability(
			boolean enabled, @Nullable String unavailable, String status, @Nullable Double progress, @Nullable String detail) {}

	/** What a Linux PC can do beyond the stock container (PLAN §8.8). */
	public record Capabilities(VirtualizationCapability virtualization, AndroidCapability android) {}

	/** Everything about one PC: the payload of {@code pc.state} and the items of {@code hello.ok.pcs}. */
	public record PcInfo(
			String pcId,
			String type,
			String name,
			String status,
			@Nullable Double progress,
			@Nullable String detail,
			long slot,
			int cpus,
			int memoryMiB,
			int diskGiB,
			boolean plugged,
			boolean pinned,
			boolean wipeOnDeath,
			List<VaultMount> mounts,
			Types.@Nullable Occupant occupant,
			@Nullable Reservation reservation,
			@Nullable String banner,
			@Nullable Screen screen,
			@Nullable ConsentPrompt consent,
			@Nullable Capabilities capabilities) {
		/** A PC without capabilities (macOS, tests). */
		public PcInfo(
				String pcId,
				String type,
				String name,
				String status,
				@Nullable Double progress,
				@Nullable String detail,
				long slot,
				int cpus,
				int memoryMiB,
				int diskGiB,
				boolean plugged,
				boolean pinned,
				boolean wipeOnDeath,
				List<VaultMount> mounts,
				Types.@Nullable Occupant occupant,
				@Nullable Reservation reservation,
				@Nullable String banner,
				@Nullable Screen screen,
				@Nullable ConsentPrompt consent) {
			this(pcId, type, name, status, progress, detail, slot, cpus, memoryMiB, diskGiB, plugged, pinned, wipeOnDeath, mounts, occupant,
					reservation, banner, screen, consent, null);
		}
	}

	public record CpuBudget(long total, long used, long free, double maxOvercommit) {}

	public record MemoryBudget(long pool, long used, long free) {}

	public record MacosSlots(long running, long max) {}

	/** Host budget: the payload of {@code budget.state} and {@code hello.ok.budget}. */
	public record Budget(CpuBudget cpu, MemoryBudget memoryMiB, long diskFreeGiB, MacosSlots macos, long crewCap) {}

	/** M→N. {@code tier}: focus, visible, none. */
	public record PcView(String pcId, String tier) {}

	/**
	 * One input event, flattened over {@code k}: {@code move} (x, y), {@code button} (button, down, x, y), {@code scroll}
	 * (dx, dy, x, y), {@code key} (key, down), {@code text} (text), {@code release_all}.
	 */
	public record InputEvent(
			String k,
			@Nullable Integer x,
			@Nullable Integer y,
			@Nullable String button,
			@Nullable Boolean down,
			@Nullable Integer dx,
			@Nullable Integer dy,
			@Nullable String key,
			@Nullable String text) {
		public static InputEvent move(int x, int y) {
			return new InputEvent("move", x, y, null, null, null, null, null, null);
		}

		public static InputEvent button(String button, boolean down, int x, int y) {
			return new InputEvent("button", x, y, button, down, null, null, null, null);
		}

		public static InputEvent scroll(int dx, int dy, int x, int y) {
			return new InputEvent("scroll", x, y, null, null, dx, dy, null, null);
		}

		public static InputEvent key(String key, boolean down) {
			return new InputEvent("key", null, null, null, down, null, null, key, null);
		}

		public static InputEvent text(String text) {
			return new InputEvent("text", null, null, null, null, null, null, null, text);
		}

		public static InputEvent releaseAll() {
			return new InputEvent("release_all", null, null, null, null, null, null, null, null);
		}
	}

	/** M→N, batched at most 60 times a second. */
	public record PcInput(String pcId, long seq, List<InputEvent> events) {}

	/** M→N. */
	public record PcFrameAck(String pcId, long seq) {}

	/** N→M. */
	public record PcCursor(String pcId, int x, int y, boolean visible) {}

	/**
	 * M→N request; absent keys are unchanged. Reply: {@link PcConfigResult}. {@code virtualization} recreates the PC;
	 * {@code android} starts or removes its phone and leaves the PC running.
	 */
	public record PcConfig(
			String pcId,
			@Nullable String name,
			@Nullable String type,
			@Nullable Integer cpus,
			@Nullable Integer memoryMiB,
			@Nullable List<VaultMount> mounts,
			@Nullable Boolean pinned,
			@Nullable Boolean wipeOnDeath,
			@Nullable Boolean virtualization,
			@Nullable Boolean android) {
		/** A change without capabilities. */
		public PcConfig(
				String pcId,
				@Nullable String name,
				@Nullable String type,
				@Nullable Integer cpus,
				@Nullable Integer memoryMiB,
				@Nullable List<VaultMount> mounts,
				@Nullable Boolean pinned,
				@Nullable Boolean wipeOnDeath) {
			this(pcId, name, type, cpus, memoryMiB, mounts, pinned, wipeOnDeath, null, null);
		}
	}

	public record PcConfigResult(boolean recreate) {}

	/** M→N request. {@code create} takes {@code type} and no {@code pcId}; other actions take {@code pcId}. */
	/**
	 * {@code placed} ({@code create} only): the PCs with a desk in this world as far as the mod knows; Node plugs one of
	 * the others of the same family before it creates a new PC (PLAN 7.5).
	 */
	public record PcAction(String action, @Nullable String pcId, @Nullable String type, @Nullable BlockPos pos, @Nullable List<String> placed) {
		public PcAction(String action, @Nullable String pcId, @Nullable String type, @Nullable BlockPos pos) {
			this(action, pcId, type, pos, null);
		}
	}

	public record PcActionResult(String pcId) {}

	/** M→N request. */
	public record PcConsent(String pcId, String consentId, boolean accept) {}

	/** M→N request. {@code purpose} is {@code vault}. Reply: {@link PickFolderResult}. */
	public record HostPickFolder(String purpose, @Nullable String pcId, @Nullable String prompt) {}

	/** {@code path} is null when the player cancelled. */
	public record PickFolderResult(@Nullable String path) {}

	// -----------------------------------------------------------------------------------------
	// Schemas
	// -----------------------------------------------------------------------------------------

	static final Schema.Node PC_TYPE = oneOf(TYPES_OF_PC.toArray(String[]::new));
	static final Schema.Obj VAULT_MOUNT = object().req("hostPath", ABS_PATH).req("mode", oneOf("rw", "ro"));
	static final Schema.Node CPUS = integer(1, 64);
	static final Schema.Node MEMORY_MIB = integer(256, 1_048_576);
	static final Schema.Obj CAPABILITIES = object()
			.req("virtualization", object().req("enabled", bool()).req("unavailable", nullable(string(1, 200))))
			.req("android", object()
					.req("enabled", bool())
					.req("unavailable", nullable(string(1, 200)))
					.req("status", oneOf(PHONE_STATUSES.toArray(String[]::new)))
					.req("progress", nullable(FRACTION))
					.req("detail", nullable(string(1, 256))));

	/** {@code PcInfo} (also the items of {@code hello.ok.pcs}). */
	public static final Schema.Obj PC_INFO = object()
			.req("pcId", PC_ID)
			.req("type", PC_TYPE)
			.req("name", string(1, 32))
			.req("status", oneOf(STATUSES.toArray(String[]::new)))
			.req("progress", nullable(FRACTION))
			.req("detail", nullable(string(1, 256)))
			.req("slot", UINT32)
			.req("cpus", CPUS)
			.req("memoryMiB", MEMORY_MIB)
			.req("diskGiB", integer(1, 16_384))
			.req("plugged", bool())
			.req("pinned", bool())
			.req("wipeOnDeath", bool())
			.req("mounts", array(VAULT_MOUNT, 0, 16))
			.req("occupant", nullable(OCCUPANT))
			.req("reservation", nullable(object().req("agentId", AGENT_ID).req("kind", oneOf("coming", "away"))))
			.req("banner", nullable(string(1, 80)))
			.req("screen", nullable(object().req("w", integer(1, 65_535)).req("h", integer(1, 65_535))))
			.req("consent", nullable(object()
					.req("consentId", CONSENT_ID)
					.req("what", string(1, 200))
					.req("bytes", NON_NEG_INT)
					.req("freeBytes", NON_NEG_INT)))
			.opt("capabilities", CAPABILITIES);

	/** {@code Budget} (also {@code hello.ok.budget}). */
	public static final Schema.Obj BUDGET = object()
			.req("cpu", object()
					.req("total", NON_NEG_INT)
					.req("used", NON_NEG_INT)
					.req("free", integer(-MAX_SAFE_INTEGER, MAX_SAFE_INTEGER))
					.req("maxOvercommit", decimal(1, 4)))
			.req("memoryMiB", object()
					.req("pool", NON_NEG_INT)
					.req("used", NON_NEG_INT)
					.req("free", integer(-MAX_SAFE_INTEGER, MAX_SAFE_INTEGER)))
			.req("diskFreeGiB", NON_NEG_INT)
			.req("macos", object().req("running", NON_NEG_INT).req("max", NON_NEG_INT))
			.req("crewCap", NON_NEG_INT);

	static final Schema.Node INPUT_EVENT = union(
			object().req("k", literal("move")).req("x", PIXEL).req("y", PIXEL),
			object()
					.req("k", literal("button"))
					.req("button", oneOf("left", "right", "middle"))
					.req("down", bool())
					.req("x", PIXEL)
					.req("y", PIXEL),
			object()
					.req("k", literal("scroll"))
					.req("dx", integer(-10_000, 10_000))
					.req("dy", integer(-10_000, 10_000))
					.req("x", PIXEL)
					.req("y", PIXEL),
			object().req("k", literal("key")).req("key", string(1, 32, "[A-Za-z0-9_]{1,32}", "cua key name")).req("down", bool()),
			object().req("k", literal("text")).req("text", string(1, 512)),
			object().req("k", literal("release_all")));

	public static final MessageType<PcInfo> PC_STATE = type("pc.state", Direction.NODE_TO_MOD, PcInfo.class, object().extend(PC_INFO));

	public static final MessageType<Budget> BUDGET_STATE = type("budget.state", Direction.NODE_TO_MOD, Budget.class, object().extend(BUDGET));

	public static final MessageType<PcView> PC_VIEW = type("pc.view", Direction.MOD_TO_NODE, PcView.class, object()
			.req("pcId", PC_ID)
			.req("tier", oneOf("focus", "visible", "none")));

	public static final MessageType<PcInput> PC_INPUT = type("pc.input", Direction.MOD_TO_NODE, PcInput.class, object()
			.req("pcId", PC_ID)
			.req("seq", UINT32)
			.req("events", array(INPUT_EVENT, 1, 256)));

	public static final MessageType<PcFrameAck> PC_FRAME_ACK = type("pc.frame.ack", Direction.MOD_TO_NODE, PcFrameAck.class, object()
			.req("pcId", PC_ID)
			.req("seq", UINT32));

	public static final MessageType<PcCursor> PC_CURSOR = type("pc.cursor", Direction.NODE_TO_MOD, PcCursor.class, object()
			.req("pcId", PC_ID)
			.req("x", PIXEL)
			.req("y", PIXEL)
			.req("visible", bool()));

	public static final MessageType<PcConfig> PC_CONFIG = type("pc.config", Direction.MOD_TO_NODE, PcConfig.class, object()
			.req("pcId", PC_ID)
			.opt("name", string(1, 32))
			.opt("type", PC_TYPE)
			.opt("cpus", CPUS)
			.opt("memoryMiB", MEMORY_MIB)
			.opt("mounts", array(VAULT_MOUNT, 0, 16))
			.opt("pinned", bool())
			.opt("wipeOnDeath", bool())
			.opt("virtualization", bool())
			.opt("android", bool()));

	public static final MessageType<PcAction> PC_ACTION = type("pc.action", Direction.MOD_TO_NODE, PcAction.class, object()
			.req("action", oneOf(ACTIONS.toArray(String[]::new)))
			.opt("pcId", PC_ID)
			.opt("type", PC_TYPE)
			.opt("pos", BLOCK_POS)
			.opt("placed", array(PC_ID, 0, 64))
			.refine(o -> "create".equals(Ui.str(o.get("action"))) ? o.has("type") && !o.has("pcId") : o.has("pcId"),
					"create needs type and no pcId; other actions need pcId"));

	public static final MessageType<PcConsent> PC_CONSENT = type("pc.consent", Direction.MOD_TO_NODE, PcConsent.class, object()
			.req("pcId", PC_ID)
			.req("consentId", CONSENT_ID)
			.req("accept", bool()));

	public static final MessageType<HostPickFolder> HOST_PICK_FOLDER = type("host.pick_folder", Direction.MOD_TO_NODE, HostPickFolder.class, object()
			.req("purpose", literal("vault"))
			.opt("pcId", PC_ID)
			.opt("prompt", string(1, 120)));

	public static final Schema.Obj PC_CONFIG_RESULT = object().req("recreate", bool());
	public static final Schema.Obj PC_ACTION_RESULT = object().req("pcId", PC_ID);
	public static final Schema.Obj PICK_FOLDER_RESULT = object().req("path", nullable(ABS_PATH));

	public static final List<MessageType<?>> TYPES = List.of(
			PC_STATE, BUDGET_STATE, PC_VIEW, PC_INPUT, PC_FRAME_ACK, PC_CURSOR, PC_CONFIG, PC_ACTION, PC_CONSENT, HOST_PICK_FOLDER);
}
