package dev.minevibe.client.org;

import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.MineVibeBridge;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.client.ClientSession;
import dev.minevibe.org.office.OfficeService;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.client.Minecraft;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Tells Node where the office is (protocol §6.4 {@code world.state.office}): once the world is ready and has an office,
 * and again after every reconnect, the client sends one {@code world.state{ready}} carrying the office layout. It is
 * an extra {@code ready} next to the 1 Hz clock pushes, which Node treats as an update. Client thread only.
 */
public final class OfficeReporter {
	private static final Logger LOG = LoggerFactory.getLogger("MineVibe/Office");

	/** Bumped on every handshake (bridge threads), so the office is sent again on each new connection. */
	private final AtomicInteger connection = new AtomicInteger();
	private String reported = "";
	private int ticks;

	public void onHandshake() {
		this.connection.incrementAndGet();
	}

	public void tick(final Minecraft mc) {
		if (++this.ticks % 20 != 0 || mc.level == null) {
			return;
		}
		OfficeService.Published office = OfficeService.published();
		BridgeClient bridge = MineVibeBridge.get();
		if (office == null || bridge == null || !bridge.isHandshaken() || !Messages.isWorldId(office.levelId())
			|| !ClientSession.get().isReady(office.levelId())) {
			return;
		}
		String key = office.levelId() + "#" + this.connection.get() + "#" + office.layout().hashCode();
		if (key.equals(this.reported)) {
			return;
		}
		boolean sent = bridge.send(Messages.WORLD_STATE, new Messages.WorldState(
			office.levelId(), Messages.WorldState.READY, null, null, office.layout().toWorldState(), Math.max(0L, mc.level.getOverworldClockTime())));
		if (sent) {
			this.reported = key;
			LOG.info("Told Node where the office of {} is ({} slots)", office.levelId(), office.layout().slots().size());
		}
	}
}
