package dev.minevibe.client.chat;

import dev.minevibe.bridge.msg.Ui;
import dev.minevibe.client.ui.AgentView;
import dev.minevibe.client.ui.FrontCards;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * Client-side pre-check of a chat line (PLAN §6.4, §6.5), so the common mistakes keep the text in the chat box with an
 * inline hint at once, without a round trip. It mirrors Node's {@code ChatRouter} / {@code handles.ts} /
 * {@code answerGrammar.ts} and uses the same hint texts. Node stays authoritative: a line that passes here can still be
 * refused there (the hint then arrives with the {@code err} reply).
 *
 * <p>Checked here: empty and over-long lines, malformed leading mentions ({@code @ada,@bram}), unknown, ambiguous and
 * too-short names, mixing {@code @all}/{@code @meeting} with names, nothing after a mention, and whole-message option
 * numbers against the addressed agent's front question (out of range, several on a single-select question).
 * Dead or dismissed names are left to Node, which also shows a toast for them.
 */
public final class MentionCheck {
	private MentionCheck() {}

	public static final int MAX_LENGTH = Ui.CHAT_MAX_LENGTH;
	private static final Pattern TOKEN = Pattern.compile("^@([A-Za-z][A-Za-z0-9_]*)([!?.,:;]*)");
	private static final Pattern NUMBERS = Pattern.compile("^\\d+(\\s*,\\s*\\d+)*$");
	private static final List<String> RESERVED = List.of("all", "ceo", "everyone", "meeting");

	/** A parsed leading mention. */
	record Mention(String raw, String name) {}

	/** Returns the inline hint for a line that cannot be sent as written, or null when it may go to Node. */
	public static @Nullable String check(String line, Collection<AgentView> crew) {
		String text = line.trim();
		if (text.isEmpty()) return "Type a message first";
		if (text.length() > MAX_LENGTH) return "Messages are limited to " + MAX_LENGTH + " characters";

		List<Mention> mentions = new ArrayList<>();
		String rest = text;
		while (rest.startsWith("@")) {
			Matcher m = TOKEN.matcher(rest);
			if (!m.lookingAt()) break; // "@ " or "@123": not a mention
			if (m.end() < rest.length() && !Character.isWhitespace(rest.charAt(m.end()))) {
				String token = rest.split("\\s", 2)[0];
				return "Put a space after each @name (" + clip(token, 40) + ")";
			}
			mentions.add(new Mention(m.group(0), m.group(1).toLowerCase(Locale.ROOT)));
			rest = rest.substring(m.end()).stripLeading();
		}
		String body = rest.trim();
		if (mentions.isEmpty() || crew.isEmpty()) return null;

		List<AgentView> targets = new ArrayList<>();
		boolean broadcast = false;
		boolean meeting = false;
		for (Mention mention : mentions) {
			Resolution r = resolve(mention.name(), crew);
			switch (r.kind) {
				case "error" -> {
					return r.hint;
				}
				case "word" -> {
					if ("meeting".equals(r.word)) meeting = true;
					else broadcast = true;
				}
				case "agent" -> {
					if (r.agent != null && !targets.contains(r.agent)) targets.add(r.agent);
				}
				default -> {
					return null; // dead or dismissed: Node answers (with a toast)
				}
			}
		}
		int kinds = (broadcast ? 1 : 0) + (meeting ? 1 : 0) + (targets.isEmpty() ? 0 : 1);
		if (kinds > 1) return "@all and @meeting cannot be combined with other names";
		if (meeting) return null; // "@meeting end", or nothing running: Node knows
		if (body.isEmpty()) return "Say something after " + mentions.getFirst().raw().replaceAll("[!?.,:;]+$", "");
		if (targets.size() == 1) return checkAnswer(targets.getFirst(), body);
		return null;
	}

	/** Whole-message option numbers against the agent's front question. */
	static @Nullable String checkAnswer(AgentView agent, String body) {
		Ui.PendingCard card = agent.frontCard();
		if (card == null || !Ui.PendingCard.QUESTION.equals(card.kind())) return null;
		Ui.CardQuestion q = FrontCards.currentQuestion(card);
		if (q == null || !NUMBERS.matcher(body.trim()).matches()) return null;
		TreeSet<Integer> picks = new TreeSet<>();
		for (String part : body.split(",")) {
			try {
				picks.add(Integer.parseInt(part.trim()));
			} catch (NumberFormatException e) {
				return null;
			}
		}
		String label = "Q" + (FrontCards.questionIndex(card) + 1);
		int count = q.options().size();
		String range = count == 1 ? "1" : "1-" + count;
		List<String> bad = picks.stream().filter(n -> n < 1 || n > count).map(String::valueOf).toList();
		if (!bad.isEmpty()) return label + " has options " + range + "; " + String.join(", ", bad) + " is not one of them";
		if (!q.multiSelect() && picks.size() > 1) return label + " takes one answer: pick a single number (" + range + ")";
		return null;
	}

	/** Outcome of resolving one name: {@code agent}, {@code word}, {@code unavailable} or {@code error}. */
	record Resolution(String kind, @Nullable AgentView agent, @Nullable String word, @Nullable String hint) {}

	static Resolution resolve(String name, Collection<AgentView> crew) {
		if (RESERVED.contains(name)) return reserved(name, crew);
		for (AgentView a : crew) {
			if (a.handle().equals(name)) return a.alive() ? new Resolution("agent", a, null, null) : new Resolution("unavailable", a, null, null);
		}
		List<String> labels = new ArrayList<>();
		List<Object> candidates = new ArrayList<>();
		for (String w : RESERVED) {
			if (w.startsWith(name)) {
				candidates.add(w);
				labels.add("@" + w);
			}
		}
		for (AgentView a : crew) {
			if (a.handle().startsWith(name)) {
				candidates.add(a);
				labels.add(a.alive() ? a.name() : a.name() + " (" + a.status() + ")");
			}
		}
		String at = "@" + name;
		if (candidates.isEmpty()) return error("Nobody is called " + at + ". Crew: " + livingHandles(crew));
		if (name.length() < 2) return error(at + " matches " + String.join(", ", labels) + ": type at least 2 letters");
		if (candidates.size() > 1) return error(at + " matches " + String.join(", ", labels));
		Object only = candidates.getFirst();
		if (only instanceof String w) return reserved(w, crew);
		AgentView a = (AgentView) only;
		return a.alive() ? new Resolution("agent", a, null, null) : new Resolution("unavailable", a, null, null);
	}

	private static Resolution reserved(String word, Collection<AgentView> crew) {
		if (!"ceo".equals(word)) return new Resolution("word", null, word, null);
		for (AgentView a : crew) if (a.ceo() && a.alive()) return new Resolution("agent", a, null, null);
		return error("There is no CEO right now");
	}

	private static Resolution error(String hint) {
		return new Resolution("error", null, null, hint);
	}

	private static String livingHandles(Collection<AgentView> crew) {
		List<String> alive = crew.stream().filter(AgentView::alive).map(a -> "@" + a.handle()).toList();
		return alive.isEmpty() ? "nobody" : String.join(", ", alive);
	}

	static String clip(String text, int max) {
		String flat = text.replaceAll("\\s+", " ").trim();
		return flat.length() <= max ? flat : flat.substring(0, max - 1) + "…";
	}
}
