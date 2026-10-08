package dev.minevibe.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.minevibe.agent.skill.SkillBridge;
import dev.minevibe.bridge.BridgeClient;
import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.msg.Org;
import dev.minevibe.bridge.msg.Pc;
import dev.minevibe.bridge.msg.Seats;
import dev.minevibe.bridge.msg.Skills;
import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.client.org.OrgClientInit;
import dev.minevibe.client.ui.UiClientInit;
import dev.minevibe.pc.PcBridge;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

/**
 * One bridge handler per message type (integration track I2): every module that registers handlers does so on a
 * bridge that has not started (MineVibeClient attaches them all before {@code start()}), no two modules claim the same
 * type, and the pushes other modules need too are read from the owner's state ({@code UiState}, {@code PcStates},
 * {@code OrgClientState}) or observed, never registered twice.
 */
class BridgeOwnershipTest {
	/** The modules in MineVibeClient's order (the PC and skill groups come in through {@code MineVibeBridge.onInstall}). */
	private static Map<String, Consumer<BridgeClient>> modules() {
		Map<String, Consumer<BridgeClient>> m = new LinkedHashMap<>();
		m.put("pc", PcBridge::register);
		m.put("skills", SkillBridge::attach);
		m.put("session", ClientBridge::register);
		m.put("world", WorldTicker::attach);
		m.put("ui", UiClientInit::attach);
		m.put("org", OrgClientInit::attach);
		return m;
	}

	private static BridgeClient unstarted() {
		return BridgeClient.builder()
			.config(() -> {
				throw new IllegalStateException("never started");
			})
			.hello(() -> {
				throw new IllegalStateException("never started");
			})
			.build();
	}

	@Test
	void everyModuleOwnsItsOwnTypesAndTheyAllFitOnOneBridge() {
		Map<String, Set<String>> owned = new LinkedHashMap<>();
		List<BridgeClient> bridges = new ArrayList<>();
		try {
			for (Map.Entry<String, Consumer<BridgeClient>> e : modules().entrySet()) {
				BridgeClient alone = unstarted();
				bridges.add(alone);
				e.getValue().accept(alone);
				owned.put(e.getKey(), alone.handledTypes());
			}
			Set<String> union = new HashSet<>();
			for (Map.Entry<String, Set<String>> e : owned.entrySet()) {
				for (String type : e.getValue()) {
					assertTrue(union.add(type), type + " is claimed by " + e.getKey() + " and another module");
				}
			}
			BridgeClient all = unstarted();
			bridges.add(all);
			for (Consumer<BridgeClient> attach : modules().values()) {
				attach.accept(all);
			}
			assertEquals(union, all.handledTypes(), "attached together, every module keeps every handler (nothing was refused)");

			// The owners the other modules read from.
			assertOwner(owned, "ui", Bodies.CREW_STATE, Ui.AGENT_BRAIN, Ui.AGENT_PENDING, Ui.CHAT_APPEND, Ui.BRAINS_STATE, Messages.AGENT_SAY,
				Messages.UI_TOAST);
			assertOwner(owned, "org", Org.CODEX_INDEX, Org.CALENDAR_STATE, Org.MEETING_STATE);
			assertOwner(owned, "pc", Pc.PC_STATE, Pc.BUDGET_STATE, Pc.PC_CURSOR);
			assertOwner(owned, "session", Messages.HELLO_OK, Messages.WORLD_OPEN, Messages.WORLD_NEXT);
			assertOwner(owned, "skills", Skills.SKILL_RUN, Skills.SKILL_CANCEL, Skills.OBS_QUERY, Bodies.AGENT_SPAWN, Bodies.AGENT_DESPAWN, Bodies.AGENT_MODE,
				Seats.AGENT_SEAT, Seats.AGENT_UNSEAT);
			// Pushes several modules act on are observed, never owned.
			assertFalse(union.contains(Ui.AGENT_APPROACH.name()), "agent.approach is observed (the body walks; the UI reads the cards)");
			assertFalse(union.contains(Org.CALENDAR_FIRED.name()), "calendar.fired is observed");
		} finally {
			for (BridgeClient b : bridges) {
				b.close("test");
			}
		}
	}

	private static void assertOwner(final Map<String, Set<String>> owned, final String module, final MessageType<?>... types) {
		for (MessageType<?> type : types) {
			assertTrue(owned.get(module).contains(type.name()), type + " belongs to " + module + " (has " + owned.get(module) + ")");
		}
	}
}
