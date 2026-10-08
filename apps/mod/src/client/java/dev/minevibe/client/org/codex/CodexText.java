package dev.minevibe.client.org.codex;

import java.util.ArrayList;
import java.util.List;

/**
 * The little Markdown CodexScreen understands in page bodies: {@code #} headings, {@code -} / {@code *} bullets,
 * {@code >} quotes, fenced code, and plain paragraphs. Everything else is shown as written.
 */
public final class CodexText {
	public enum Style {
		HEADING,
		BULLET,
		QUOTE,
		CODE,
		TEXT,
		BLANK
	}

	public record Line(Style style, String text) {}

	private CodexText() {
	}

	public static List<Line> parse(final String body) {
		List<Line> lines = new ArrayList<>();
		boolean code = false;
		for (String raw : body.replace("\r\n", "\n").replace('\r', '\n').split("\n", -1)) {
			String line = raw.stripTrailing();
			if (line.strip().startsWith("```")) {
				code = !code;
				continue;
			}
			if (code) {
				lines.add(new Line(Style.CODE, line));
			} else if (line.isBlank()) {
				lines.add(new Line(Style.BLANK, ""));
			} else if (line.startsWith("#")) {
				lines.add(new Line(Style.HEADING, line.replaceFirst("^#+\\s*", "")));
			} else if (line.stripLeading().startsWith("- ") || line.stripLeading().startsWith("* ")) {
				lines.add(new Line(Style.BULLET, line.stripLeading().substring(2)));
			} else if (line.startsWith(">")) {
				lines.add(new Line(Style.QUOTE, line.replaceFirst("^>\\s?", "")));
			} else {
				lines.add(new Line(Style.TEXT, line));
			}
		}
		while (!lines.isEmpty() && lines.getLast().style() == Style.BLANK) {
			lines.removeLast();
		}
		return lines;
	}
}
