package dev.minevibe.client.pc.frame;

import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.renderpearl.api.GpuFormat;
import com.mojang.renderpearl.api.device.GpuDevice;
import com.mojang.renderpearl.api.textures.FilterMode;
import com.mojang.renderpearl.api.textures.GpuTexture;
import java.nio.ByteBuffer;
import net.minecraft.client.renderer.texture.AbstractTexture;

/**
 * The GPU texture of one PC's screen (PLAN 7.6): RGBA8, sampled clamped and linear, written row bands at a time with
 * {@code CommandEncoder#writeToTexture} (Blaze3D only, no raw GL). Created and written on the render thread.
 */
public final class MonitorTexture extends AbstractTexture {
	private final String label;
	private int width;
	private int height;

	public MonitorTexture(final String label) {
		this.label = label;
		this.sampler = RenderSystem.getSamplerCache().getClampToEdge(FilterMode.LINEAR);
	}

	public int width() {
		return this.width;
	}

	public int height() {
		return this.height;
	}

	public boolean hasTexture() {
		return this.texture != null;
	}

	/** (Re)creates the GPU texture at {@code w x h} when it has another size or none yet. */
	public void ensureSize(final int w, final int h) {
		if (this.texture != null && w == this.width && h == this.height) {
			return;
		}
		this.releaseTextures();
		GpuDevice device = RenderSystem.getDevice();
		this.texture = device.createTexture(this.label, GpuTexture.USAGE_COPY_DST | GpuTexture.USAGE_TEXTURE_BINDING, GpuFormat.RGBA8_UNORM, w, h, 1, 1);
		this.textureView = device.createTextureView(this.texture);
		this.width = w;
		this.height = h;
	}

	/** Writes rows {@code y .. y + rows} (full width, tightly packed RGBA8). */
	public void writeRows(final ByteBuffer pixels, final int y, final int rows) {
		if (this.texture == null) {
			return;
		}
		RenderSystem.getDevice().createCommandEncoder().writeToTexture(this.texture, pixels, 0, 0, 0, y, this.width, rows);
	}
}
