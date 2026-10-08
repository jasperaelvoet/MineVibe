package dev.minevibe.client.pc.input;

import dev.minevibe.bridge.msg.Pc;
import java.util.ArrayList;
import java.util.List;

/**
 * Collects input events for one PC between two {@code pc.input} batches (PLAN 5: batched at most 60 times a second).
 * Consecutive moves collapse into the latest one and consecutive text joins up (to {@link #MAX_TEXT} UTF-16 units);
 * everything else keeps its order. {@link #drain} splits into batches of at most {@link #MAX_EVENTS}, each with the
 * next sequence number.
 */
public final class PcInputBatcher {
	public static final int MAX_EVENTS = 256;
	public static final int MAX_TEXT = 256;

	private final List<Pc.InputEvent> pending = new ArrayList<>();
	private long seq;

	public void add(final Pc.InputEvent event) {
		if (!this.pending.isEmpty()) {
			Pc.InputEvent last = this.pending.getLast();
			if ("move".equals(event.k()) && "move".equals(last.k())) {
				this.pending.set(this.pending.size() - 1, event);
				return;
			}
			if ("text".equals(event.k()) && "text".equals(last.k()) && last.text() != null && event.text() != null
				&& last.text().length() + event.text().length() <= MAX_TEXT) {
				this.pending.set(this.pending.size() - 1, Pc.InputEvent.text(last.text() + event.text()));
				return;
			}
		}
		this.pending.add(event);
	}

	public boolean isEmpty() {
		return this.pending.isEmpty();
	}

	public int size() {
		return this.pending.size();
	}

	/** The pending events as {@code pc.input} batches (empty when nothing is pending). */
	public List<Pc.PcInput> drain(final String pcId) {
		List<Pc.PcInput> out = new ArrayList<>();
		for (int i = 0; i < this.pending.size(); i += MAX_EVENTS) {
			List<Pc.InputEvent> chunk = List.copyOf(this.pending.subList(i, Math.min(this.pending.size(), i + MAX_EVENTS)));
			this.seq = (this.seq + 1) & 0xFFFF_FFFFL;
			out.add(new Pc.PcInput(pcId, this.seq, chunk));
		}
		this.pending.clear();
		return out;
	}
}
