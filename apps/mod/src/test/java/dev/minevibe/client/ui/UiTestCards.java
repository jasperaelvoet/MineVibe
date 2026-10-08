package dev.minevibe.client.ui;

import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.bridge.protocol.MessageType;
import dev.minevibe.bridge.protocol.ProtocolCodec;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;

/** Card builders and fixture loading for the UI tests. */
final class UiTestCards {
	private UiTestCards() {}

	static Ui.QuestionOption option(String label) {
		return new Ui.QuestionOption(label, null);
	}

	static Ui.CardQuestion single(String question, String... labels) {
		return new Ui.CardQuestion(question, null, Arrays.stream(labels).map(UiTestCards::option).toList(), false);
	}

	static Ui.CardQuestion multi(String question, String... labels) {
		return new Ui.CardQuestion(question, null, Arrays.stream(labels).map(UiTestCards::option).toList(), true);
	}

	static Ui.PendingCard question(String id, String agentId, long createdAt, List<Ui.CardQuestion> questions, List<String> answers) {
		return new Ui.PendingCard(id, agentId, createdAt, false, false, "question", questions, answers, null, null, null, null, null, null, null, null);
	}

	static Ui.PendingCard presenting(Ui.PendingCard c) {
		return new Ui.PendingCard(c.id(), c.agentId(), c.createdAt(), false, true, c.kind(), c.questions(), c.answers(), c.plan(), c.role(),
				c.name(), c.handle(), c.reason(), c.firstTask(), c.eventId(), c.summary());
	}

	static Ui.PendingCard parked(Ui.PendingCard c) {
		return new Ui.PendingCard(c.id(), c.agentId(), c.createdAt(), true, c.presenting(), c.kind(), c.questions(), c.answers(), c.plan(),
				c.role(), c.name(), c.handle(), c.reason(), c.firstTask(), c.eventId(), c.summary());
	}

	static Ui.PendingCard plan(String id, String agentId, long createdAt, String plan) {
		return new Ui.PendingCard(id, agentId, createdAt, false, false, "plan", null, null, plan, null, null, null, null, null, null, null);
	}

	static Ui.PendingCard hire(String id, String agentId, long createdAt) {
		return new Ui.PendingCard(id, agentId, createdAt, false, false, "hire", null, null, null, "miner", "Dana", "dana", "We need iron.",
				"Mine iron.", null, null);
	}

	static Ui.PendingCard calendar(String id, String agentId, long createdAt) {
		return new Ui.PendingCard(id, agentId, createdAt, false, false, "calendar", null, null, null, null, null, null, null, null, "ev-1",
				"Daily standup");
	}

	static String fixture(String group, String name) {
		String dir = System.getProperty("minevibe.protocolFixtures");
		assertNotNull(dir, "minevibe.protocolFixtures is not set (run through Gradle)");
		try {
			return Files.readString(Path.of(dir, group, name), StandardCharsets.UTF_8);
		} catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	static <P> P parse(MessageType<P> type, String group, String name) {
		ProtocolCodec.Parsed parsed = ProtocolCodec.parse(fixture(group, name));
		return assertInstanceOf(ProtocolCodec.Valid.class, parsed, () -> name + ": " + parsed).payloadAs(type);
	}
}
