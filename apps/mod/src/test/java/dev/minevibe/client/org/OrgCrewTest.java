package dev.minevibe.client.org;

import static org.junit.jupiter.api.Assertions.assertEquals;

import dev.minevibe.bridge.msg.Bodies;
import dev.minevibe.bridge.protocol.Messages;
import dev.minevibe.client.ui.UiState;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The org screens' crew comes from the UI's state (which owns {@code crew.state}: one handler per type), so a hire or a
 * death since the last handshake shows up in the calendar and the meeting HUD (integration track I2).
 */
class OrgCrewTest {
	@Test
	void theCrewDirectoryMirrorsTheUiCrew() {
		UiState ui = UiState.create(() -> 0);
		org.junit.jupiter.api.Assertions.assertFalse(ui.crewKnown(), "no crew.state yet: hello.ok's crew stays");
		ui.applyCrew(new Bodies.CrewState(List.of(
			new Messages.CrewMember("bram", "bram", "Bram", "engineer", false, "alive"),
			new Messages.CrewMember("ada", "ada", "Ada", "ceo", true, "alive"),
			new Messages.CrewMember("cleo", "cleo", "Cleo", "farmer", false, "dead"))));
		CrewDirectory crew = new CrewDirectory();
		crew.setBodies(List.of(new CrewDirectory.Member("dev1", "Dev", null, "miner", false, "alive")));
		crew.setNodeMembers(OrgClientInit.nodeCrew(ui));
		assertEquals(List.of("ada", "bram", "cleo", "dev1"), crew.order(), "the CEO first, then by name; dev bodies stay");
		assertEquals(List.of("ada", "bram", "dev1"), crew.alive().stream().map(CrewDirectory.Member::agentId).toList());
		assertEquals("Ada", crew.name("ada"));
		// A hire arrives as a new crew.state: the directory follows.
		ui.applyCrew(new Bodies.CrewState(List.of(
			new Messages.CrewMember("ada", "ada", "Ada", "ceo", true, "alive"),
			new Messages.CrewMember("dana", "dana", "Dana", "builder", false, "alive"))));
		crew.setNodeMembers(OrgClientInit.nodeCrew(ui));
		assertEquals(List.of("ada", "dana", "dev1"), crew.order());
		// A new world before its CEO arrives: an empty crew list is really empty.
		ui.applyCrew(new Bodies.CrewState(List.of()));
		org.junit.jupiter.api.Assertions.assertTrue(ui.crewKnown());
		crew.setNodeMembers(OrgClientInit.nodeCrew(ui));
		assertEquals(List.of("dev1"), crew.order());
	}
}
