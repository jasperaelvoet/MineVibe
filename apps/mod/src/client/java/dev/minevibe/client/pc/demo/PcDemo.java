package dev.minevibe.client.pc.demo;

import dev.minevibe.pc.PcClientHooks;
import dev.minevibe.pc.PcDeskBlock;
import dev.minevibe.pc.PcWorkstation;
import dev.minevibe.world.seat.OfficeChairBlock;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;
import org.lwjgl.sdl.SDLEvents;
import org.lwjgl.sdl.SDLVideo;
import org.lwjgl.sdl.SDL_Event;
import org.lwjgl.system.MemoryUtil;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * A scripted monitor demo for spike S4 (development only; off unless {@code MINEVIBE_PC_DEMO=<pcId>} is set). Once the
 * player stands in a world it places a workstation bound to that PC three blocks ahead and looks at it, then runs the
 * phases of {@code MINEVIBE_PC_DEMO_PHASES} (default {@code baseline:12,watch:50,seat:50,type:8,stand:6,config:6,watchscreen:6}), logging
 * {@code [pc-demo] phase=<name>} at each start and {@code [pc-demo] done} at the end:
 *
 * <ul>
 *   <li>{@code baseline} (or any other unknown name): just waits.</li>
 *   <li>{@code watch}: the monitor in the world (frame tier visible).</li>
 *   <li>{@code seat}: the player sits at the PC (PcControlScreen, frame tier focus).</li>
 *   <li>{@code type}: synthetic SDL3 key and text events pushed onto SDL's queue (never drained), so the real input
 *       path (SDLEventHandler, KeyboardHandler, PcControlScreen) logs {@code [pc-input]} lines and sends
 *       {@code pc.input}.</li>
 *   <li>{@code stand}: a synthetic Shift+Esc (the reserved stand-up chord).</li>
 *   <li>{@code config} / {@code watchscreen}: PcConfigScreen / Watch mode for the PC, a screenshot halfway, then
 *       closed.</li>
 * </ul>
 * {@code watch} and {@code seat} take a screenshot (F2) at a quarter and three quarters of their time, {@code baseline}
 * halfway (the monitor's status screen). The player is made invulnerable for the demo (it runs in a real hardcore
 * world).
 */
public final class PcDemo {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/PC");
	private static final @Nullable String PC_ID = blankToNull(System.getenv("MINEVIBE_PC_DEMO"));
	private static final String PHASES = System.getenv().getOrDefault("MINEVIBE_PC_DEMO_PHASES", "baseline:12,watch:50,seat:50,type:8,stand:6,config:6,watchscreen:6");

	private record Phase(String name, int ticks) {}

	private static final List<Phase> SCRIPT = new ArrayList<>();
	private static int readyTicks;
	private static int phase = -1;
	private static int phaseTicks;
	private static @Nullable BlockPos origin;
	private static @Nullable Direction facing;
	private static final List<ByteBuffer> TEXT_BUFFERS = new ArrayList<>();

	private PcDemo() {}

	private static @Nullable String blankToNull(final @Nullable String s) {
		return s == null || s.isBlank() ? null : s.trim();
	}

	public static void init() {
		if (PC_ID == null) {
			return;
		}
		System.setProperty("minevibe.pcInputLog", "true");
		for (String part : PHASES.split(",")) {
			String[] kv = part.trim().split(":");
			if (kv.length == 2) {
				SCRIPT.add(new Phase(kv[0].trim(), Math.max(1, Integer.parseInt(kv[1].trim())) * 20));
			}
		}
		LOG.info("[pc-demo] enabled for PC {} with phases {}", PC_ID, PHASES);
	}

	public static void tick(final Minecraft mc) {
		if (PC_ID == null || phase >= SCRIPT.size()) {
			return;
		}
		IntegratedServer server = mc.getSingleplayerServer();
		if (mc.level == null || mc.player == null || server == null || mc.gui.overlay() != null) {
			return;
		}
		if (phase < 0) {
			if (++readyTicks == 40) {
				place(mc, server);
			} else if (readyTicks == 60) {
				lookAtMonitor(mc);
				next(mc, server);
			}
			return;
		}
		Phase current = SCRIPT.get(phase);
		boolean screens = "config".equals(current.name()) || "watchscreen".equals(current.name());
		if (++phaseTicks >= current.ticks()) {
			if (screens) {
				mc.gui.setScreen(null);
			}
			next(mc, server);
		} else if ("type".equals(current.name()) && phaseTicks == 40) {
			typeTest(mc);
		} else if (("watch".equals(current.name()) || "seat".equals(current.name()))
			&& (phaseTicks == current.ticks() / 4 || phaseTicks == current.ticks() * 3 / 4)
			|| ("baseline".equals(current.name()) || screens) && phaseTicks == current.ticks() / 2) {
			// F2 (Minecraft's screenshot key, global even on PcControlScreen): one picture per codec window.
			LOG.info("[pc-demo] screenshot phase={} at={}s", current.name(), phaseTicks / 20);
			int window = SDLVideo.SDL_GetWindowID(mc.getWindow().handle());
			key(window, 59, 0x4000003B, 0, true);
			key(window, 59, 0x4000003B, 0, false);
		}
	}

	private static void next(final Minecraft mc, final IntegratedServer server) {
		phase++;
		phaseTicks = 0;
		if (phase >= SCRIPT.size()) {
			LOG.info("[pc-demo] done");
			for (ByteBuffer b : TEXT_BUFFERS) {
				MemoryUtil.memFree(b);
			}
			TEXT_BUFFERS.clear();
			return;
		}
		String name = SCRIPT.get(phase).name();
		LOG.info("[pc-demo] phase={}", name);
		switch (name) {
			case "seat" -> seat(mc, server);
			case "stand" -> pushShiftEscape(mc);
			case "watch" -> lookAtMonitor(mc);
			case "config" -> PcClientHooks.get().openConfig(PC_ID);
			case "watchscreen" -> PcClientHooks.get().openWatch(PC_ID);
			default -> {
			}
		}
	}

	private static void place(final Minecraft mc, final IntegratedServer server) {
		Direction dir = mc.player.getDirection();
		BlockPos feet = mc.player.blockPosition();
		BlockPos o = feet.relative(dir, 3);
		Direction f = dir.getOpposite();
		origin = o;
		facing = f;
		java.util.UUID id = mc.player.getUUID();
		String pcId = PC_ID;
		server.execute(() -> {
			ServerPlayer player = server.getPlayerList().getPlayer(id);
			if (player == null) {
				return;
			}
			player.getAbilities().invulnerable = true;
			player.onUpdateAbilities();
			ServerLevel level = player.level();
			for (BlockPos p : PcWorkstation.footprint(o, f)) {
				for (int dy = 0; dy <= 2; dy++) {
					level.setBlock(p.above(dy), Blocks.AIR.defaultBlockState(), Block.UPDATE_ALL);
				}
				if (!level.getBlockState(p.below()).isSolid()) {
					level.setBlock(p.below(), Blocks.SMOOTH_STONE.defaultBlockState(), Block.UPDATE_ALL);
				}
			}
			PcWorkstation.place(level, o, f, "linux", pcId);
			LOG.info("[pc-demo] placed PC {} at {} facing {}", pcId, o, f);
		});
	}

	private static void lookAtMonitor(final Minecraft mc) {
		if (origin == null || facing == null || mc.player == null) {
			return;
		}
		Direction side = PcDeskBlock.sideDirection(facing);
		Vec3 screen = Vec3.atCenterOf(origin.above()).add(side.getStepX() * 0.5, 0, side.getStepZ() * 0.5);
		Vec3 eye = mc.player.getEyePosition();
		Vec3 d = screen.subtract(eye);
		float yaw = (float) (Math.toDegrees(Math.atan2(d.z, d.x)) - 90.0);
		float pitch = (float) -Math.toDegrees(Math.atan2(d.y, Math.sqrt(d.x * d.x + d.z * d.z)));
		mc.player.setYRot(yaw);
		mc.player.setXRot(pitch);
		mc.player.setYHeadRot(yaw);
	}

	private static void seat(final Minecraft mc, final IntegratedServer server) {
		if (origin == null || facing == null || mc.player == null) {
			return;
		}
		BlockPos chair = PcDeskBlock.chairPos(origin, facing);
		java.util.UUID id = mc.player.getUUID();
		server.execute(() -> {
			ServerPlayer player = server.getPlayerList().getPlayer(id);
			if (player != null) {
				boolean sat = OfficeChairBlock.trySit(player.level(), chair, player);
				LOG.info("[pc-demo] seat at {}: {}", chair, sat ? "seated" : "refused");
			}
		});
	}

	/** Pushes key and text events the way SDL would deliver real typing. */
	private static void typeTest(final Minecraft mc) {
		int window = SDLVideo.SDL_GetWindowID(mc.getWindow().handle());
		LOG.info("[pc-demo] pushing synthetic SDL input (window {})", window);
		key(window, 4, 'a', 0, true);
		text(window, "a");
		key(window, 4, 'a', 0, false);
		text(window, "Hé AZERTY ü");
		key(window, 43, '\t', 0, true);
		key(window, 43, '\t', 0, false);
		key(window, 224, 0x400000E0, 0x0040, true);
		key(window, 6, 'c', 0x0040, true);
		key(window, 6, 'c', 0x0040, false);
		key(window, 224, 0x400000E0, 0, false);
		key(window, 40, '\r', 0, true);
		key(window, 40, '\r', 0, false);
		key(window, 82, 0x40000052, 0, true);
		key(window, 82, 0x40000052, 0, false);
	}

	private static void pushShiftEscape(final Minecraft mc) {
		int window = SDLVideo.SDL_GetWindowID(mc.getWindow().handle());
		LOG.info("[pc-demo] pushing Shift+Esc");
		key(window, 225, 0x400000E1, 0x0001, true);
		key(window, 41, 0x1B, 0x0001, true);
		key(window, 41, 0x1B, 0x0001, false);
		key(window, 225, 0x400000E1, 0, false);
	}

	private static void key(final int window, final int scancode, final int keycode, final int mod, final boolean down) {
		try (SDL_Event event = SDL_Event.calloc()) {
			int type = down ? SDLEvents.SDL_EVENT_KEY_DOWN : SDLEvents.SDL_EVENT_KEY_UP;
			event.key(k -> k.set(type, 0L, window, 0, scancode, keycode, (short) mod, (short) 0, down, false));
			SDLEvents.SDL_PushEvent(event);
		}
	}

	private static void text(final int window, final String s) {
		ByteBuffer utf8 = MemoryUtil.memUTF8(s);
		TEXT_BUFFERS.add(utf8);
		try (SDL_Event event = SDL_Event.calloc()) {
			event.text(t -> t.set(SDLEvents.SDL_EVENT_TEXT_INPUT, 0L, window, utf8));
			SDLEvents.SDL_PushEvent(event);
		}
	}

	/** The PC the demo placed, for tests and logs. */
	public static @Nullable String pcId() {
		return PC_ID;
	}
}
