package dev.minevibe.client.pc.frame;

import com.mojang.blaze3d.platform.NativeImage;
import dev.minevibe.MineVibeMod;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.resources.Identifier;
import org.jspecify.annotations.Nullable;

/**
 * One {@link MonitorFrame} (CPU) and {@link MonitorTexture} (GPU, registered as {@code minevibe:pc/<pcId>}) per PC
 * (PLAN 7.6). Decoder threads write frames; the render thread calls {@link #prepare} wherever it draws a monitor (the
 * block entity renderer, PcControlScreen, Watch mode), which uploads at most once per PC per rendered frame.
 */
public final class MonitorTextures {
	private static final Map<String, Entry> ENTRIES = new ConcurrentHashMap<>();
	private static @Nullable Identifier white;

	private MonitorTextures() {}

	private static final class Entry {
		final Identifier id;
		final MonitorFrame frame = new MonitorFrame();
		@Nullable MonitorTexture texture;
		long lastAttemptToken = Long.MIN_VALUE;

		Entry(final String pcId) {
			this.id = MineVibeMod.id("pc/" + pcId);
		}
	}

	/** The CPU frame of {@code pcId} (any thread; created on first use). */
	public static MonitorFrame frameFor(final String pcId) {
		return ENTRIES.computeIfAbsent(pcId, Entry::new).frame;
	}

	/**
	 * Render thread: uploads what the decoders produced since the last upload (once per rendered frame per PC) and
	 * returns the texture to draw, or null while the PC has never sent a frame.
	 */
	public static @Nullable Identifier prepare(final String pcId) {
		Entry e = ENTRIES.get(pcId);
		if (e == null) {
			return null;
		}
		// The previous frame's duration: constant during one frame's extraction, different from frame to frame except
		// when two frames take exactly as long (then one upload waits a frame; the dirty rows are kept).
		long token = Minecraft.getInstance().getFrameTimeNs();
		if (e.lastAttemptToken != token) {
			e.lastAttemptToken = token;
			long t0 = System.nanoTime();
			long[] bytes = {0};
			boolean uploaded = e.frame.tryUpload((rows, y, height, width, frameHeight, resized) -> {
				MonitorTexture tex = e.texture;
				if (tex == null) {
					tex = new MonitorTexture("MineVibe PC " + pcId);
					e.texture = tex;
					tex.ensureSize(width, frameHeight);
					Minecraft.getInstance().getTextureManager().register(e.id, tex);
				} else {
					tex.ensureSize(width, frameHeight);
				}
				tex.writeRows(rows, y, height);
				bytes[0] = (long) width * height * 4;
			});
			if (uploaded) {
				PcStats.upload(bytes[0], System.nanoTime() - t0);
			}
		}
		MonitorTexture tex = e.texture;
		return tex != null && tex.hasTexture() ? e.id : null;
	}

	/** Frame size in pixels ({@code [w, h]}), or null before the first frame. */
	public static int @Nullable [] size(final String pcId) {
		Entry e = ENTRIES.get(pcId);
		return e == null ? null : e.frame.size();
	}

	/** Nanoseconds since the last decoded frame of {@code pcId}, or {@link Long#MAX_VALUE} without one. */
	public static long ageNanos(final String pcId) {
		Entry e = ENTRIES.get(pcId);
		long at = e == null ? 0 : e.frame.lastPatchNanos();
		return at == 0 ? Long.MAX_VALUE : System.nanoTime() - at;
	}

	/**
	 * Every frame held, for the E2E {@code debug.state} snapshot: {@code pcId}, {@code w}, {@code h}, {@code seq},
	 * {@code patches}, {@code ageMs} and {@code hash} (CRC32 of the pixels, hex).
	 */
	public static java.util.List<Map<String, Object>> debugSnapshot() {
		java.util.List<Map<String, Object>> out = new java.util.ArrayList<>();
		for (Map.Entry<String, Entry> en : new java.util.TreeMap<>(ENTRIES).entrySet()) {
			MonitorFrame f = en.getValue().frame;
			int[] wh = f.size();
			long crc = f.contentCrc();
			long at = f.lastPatchNanos();
			Map<String, Object> m = new java.util.LinkedHashMap<>();
			m.put("pcId", en.getKey());
			m.put("w", wh == null ? 0 : wh[0]);
			m.put("h", wh == null ? 0 : wh[1]);
			m.put("seq", f.seq());
			m.put("patches", f.patches());
			m.put("ageMs", at == 0 ? null : Math.max(0, (System.nanoTime() - at) / 1_000_000));
			m.put("hash", crc < 0 ? null : String.format("%08x", crc));
			out.add(m);
		}
		return out;
	}

	/** Render thread: frees one PC's texture and frame. */
	public static void release(final String pcId) {
		Entry e = ENTRIES.remove(pcId);
		if (e != null && e.texture != null) {
			Minecraft.getInstance().getTextureManager().release(e.id);
		}
	}

	/** Render thread: frees everything (leaving the world). */
	public static void releaseAll() {
		for (String pcId : ENTRIES.keySet()) {
			release(pcId);
		}
	}

	/** A 1x1 white texture for coloured quads on monitors (render thread). */
	public static Identifier white() {
		Identifier id = white;
		if (id == null) {
			NativeImage image = new NativeImage(1, 1, false);
			image.setPixel(0, 0, 0xFFFFFFFF);
			id = MineVibeMod.id("pc/white");
			Minecraft.getInstance().getTextureManager().register(id, new DynamicTexture(() -> "MineVibe white", image));
			white = id;
		}
		return id;
	}
}
