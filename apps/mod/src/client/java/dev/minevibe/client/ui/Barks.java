package dev.minevibe.client.ui;

import java.util.Locale;
import java.util.Map;

/**
 * The mod's bark table (PLAN §7.3 "Barks"): {@code agent.say{bark}} carries a key and the text comes from here, so
 * scripted lines cost zero tokens and can be localised later. Unknown keys are shown humanised
 * ({@code found_iron} becomes "Found iron").
 */
public final class Barks {
	private Barks() {}

	private static final Map<String, String> TABLE = Map.ofEntries(
			Map.entry("thinking", "Hmm, one sec…"),
			Map.entry("hmm", "Hmm, one sec…"),
			Map.entry("reporting_for_duty", "Reporting for duty!"),
			Map.entry("on_it", "On it!"),
			Map.entry("hungry", "I'm starving…"),
			Map.entry("eating", "*munch*"),
			Map.entry("creeper", "Creeper! Back off!"),
			Map.entry("hurt", "Ouch!"),
			Map.entry("fleeing", "Too many of them, falling back!"),
			Map.entry("protect", "I've got you!"),
			Map.entry("fed_player", "Here, have some food."),
			Map.entry("shared_food", "Here, eat something."),
			Map.entry("kicked", "Alright, it's all yours."),
			Map.entry("stood_up", "Standing up."),
			Map.entry("brb", "BRB, asking Jasper."),
			Map.entry("night", "It's getting dark, let's head inside."),
			Map.entry("goodbye", "Goodbye!"),
			Map.entry("last_words", "Tell them… I tried."),
			Map.entry("asleep", "Zzz… out of energy for now."));

	/** The text for a bark key. */
	public static String text(String key) {
		String known = TABLE.get(key);
		if (known != null) return known;
		String words = key.replace('_', ' ').trim();
		if (words.isEmpty()) return "…";
		return words.substring(0, 1).toUpperCase(Locale.ROOT) + words.substring(1);
	}
}
