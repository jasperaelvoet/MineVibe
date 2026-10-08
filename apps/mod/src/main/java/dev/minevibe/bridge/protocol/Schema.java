package dev.minevibe.bridge.protocol;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * A small JSON validator that mirrors the zod schemas in {@code packages/protocol/src} closely enough that the
 * shared fixtures are accepted and rejected the same way on both sides.
 *
 * <p>zod semantics kept here: objects ignore unknown keys; {@code optional} keys may be absent but not
 * {@code null}; {@code nullable} keys must be present but may be {@code null}; string lengths count UTF-16
 * code units (as JS does, and as {@link String#length()} does); integers must be whole numbers within range
 * (at most {@code Number.MAX_SAFE_INTEGER}); regexes must match the whole string.
 */
public final class Schema {
	private Schema() {}

	/** Largest integer a JS number holds exactly (zod's {@code .int()} limit). */
	public static final long MAX_SAFE_INTEGER = 9007199254740991L;

	/** A validation rule for one JSON value. */
	@FunctionalInterface
	public interface Node {
		/** Appends a message to {@code errors} for every problem found at {@code path}. */
		void check(JsonElement value, String path, List<String> errors);
	}

	private static String at(String path) {
		return path.isEmpty() ? "(root)" : path;
	}

	public static Node string(int min, int max) {
		return string(min, max, null, null);
	}

	/**
	 * A string of {@code min..max} UTF-16 units that fully matches {@code regex} (written without {@code ^…$}).
	 */
	public static Node string(int min, int max, String regex, String description) {
		Pattern pattern = regex == null ? null : Pattern.compile(regex);
		return (value, path, errors) -> {
			if (!(value instanceof JsonPrimitive p) || !p.isString()) {
				errors.add(at(path) + ": expected string");
				return;
			}
			String s = p.getAsString();
			if (s.length() < min) errors.add(at(path) + ": too short (min " + min + ")");
			if (s.length() > max) errors.add(at(path) + ": too long (max " + max + ")");
			if (pattern != null && !pattern.matcher(s).matches()) {
				errors.add(at(path) + ": " + (description != null ? description : "does not match " + regex));
			}
		};
	}

	/** A whole number in {@code [min, max]}. */
	public static Node integer(long min, long max) {
		return (value, path, errors) -> {
			BigDecimal d = number(value);
			if (d == null) {
				errors.add(at(path) + ": expected number");
				return;
			}
			if (d.stripTrailingZeros().scale() > 0) {
				errors.add(at(path) + ": expected integer");
				return;
			}
			if (d.compareTo(BigDecimal.valueOf(min)) < 0) errors.add(at(path) + ": too small (min " + min + ")");
			if (d.compareTo(BigDecimal.valueOf(max)) > 0) errors.add(at(path) + ": too big (max " + max + ")");
		};
	}

	/** Any finite number in {@code [min, max]}. */
	public static Node decimal(double min, double max) {
		return (value, path, errors) -> {
			BigDecimal d = number(value);
			if (d == null) {
				errors.add(at(path) + ": expected number");
				return;
			}
			double v = d.doubleValue();
			if (v < min) errors.add(at(path) + ": too small (min " + min + ")");
			if (v > max) errors.add(at(path) + ": too big (max " + max + ")");
		};
	}

	private static BigDecimal number(JsonElement value) {
		if (!(value instanceof JsonPrimitive p) || !p.isNumber()) return null;
		try {
			return p.getAsBigDecimal();
		} catch (NumberFormatException e) {
			return null;
		}
	}

	public static Node bool() {
		return (value, path, errors) -> {
			if (!(value instanceof JsonPrimitive p) || !p.isBoolean()) errors.add(at(path) + ": expected boolean");
		};
	}

	/** Exactly this boolean. */
	public static Node literal(boolean expected) {
		return (value, path, errors) -> {
			if (!(value instanceof JsonPrimitive p) || !p.isBoolean() || p.getAsBoolean() != expected) {
				errors.add(at(path) + ": expected " + expected);
			}
		};
	}

	/** Exactly this string. */
	public static Node literal(String expected) {
		return (value, path, errors) -> {
			if (!(value instanceof JsonPrimitive p) || !p.isString() || !p.getAsString().equals(expected)) {
				errors.add(at(path) + ": expected \"" + expected + "\"");
			}
		};
	}

	/** Exactly this integer (e.g. the protocol version). */
	public static Node literal(long expected) {
		return (value, path, errors) -> {
			BigDecimal d = number(value);
			if (d == null || d.compareTo(BigDecimal.valueOf(expected)) != 0) errors.add(at(path) + ": expected " + expected);
		};
	}

	public static Node oneOf(String... values) {
		Set<String> allowed = Set.of(values);
		return (value, path, errors) -> {
			if (!(value instanceof JsonPrimitive p) || !p.isString() || !allowed.contains(p.getAsString())) {
				errors.add(at(path) + ": expected one of " + String.join(", ", values));
			}
		};
	}

	public static Node nullable(Node inner) {
		return (value, path, errors) -> {
			if (value == null || value.isJsonNull()) return;
			inner.check(value, path, errors);
		};
	}

	public static Node array(Node item, int min, int max) {
		return (value, path, errors) -> {
			if (!(value instanceof JsonArray a)) {
				errors.add(at(path) + ": expected array");
				return;
			}
			if (a.size() < min) errors.add(at(path) + ": too few items (min " + min + ")");
			if (a.size() > max) errors.add(at(path) + ": too many items (max " + max + ")");
			for (int i = 0; i < a.size(); i++) item.check(a.get(i), path + "." + i, errors);
		};
	}

	/** Any JSON object (zod {@code z.record(z.string(), z.unknown())} / {@code z.looseObject({})}). */
	public static Node anyObject() {
		return (value, path, errors) -> {
			if (!(value instanceof JsonObject)) errors.add(at(path) + ": expected object");
		};
	}

	/** Passes when any option passes. */
	public static Node union(Node... options) {
		return (value, path, errors) -> {
			List<String> first = null;
			for (Node option : options) {
				List<String> attempt = new ArrayList<>();
				option.check(value, path, attempt);
				if (attempt.isEmpty()) return;
				if (first == null) first = attempt;
			}
			errors.add(at(path) + ": no union option matched" + (first != null ? " (" + first.get(0) + ")" : ""));
		};
	}

	public static Obj object() {
		return new Obj();
	}

	/** An object with required and optional keys. Unknown keys are allowed (zod strips them). */
	public static final class Obj implements Node {
		private final Map<String, Node> required = new LinkedHashMap<>();
		private final Map<String, Node> optional = new LinkedHashMap<>();
		private final List<Map.Entry<Predicate<JsonObject>, String>> refinements = new ArrayList<>();

		private Obj() {}

		/** A key that must be present (use {@link #nullable(Node)} to also allow {@code null}). */
		public Obj req(String key, Node node) {
			required.put(key, node);
			return this;
		}

		/** A key that may be absent; when present it must not be {@code null}. */
		public Obj opt(String key, Node node) {
			optional.put(key, node);
			return this;
		}

		/** A whole-object rule, like zod's {@code .refine()}. */
		public Obj refine(Predicate<JsonObject> rule, String message) {
			refinements.add(Map.entry(rule, message));
			return this;
		}

		/** Copies another object's keys into this one (used to add the envelope keys to payload schemas). */
		public Obj extend(Obj other) {
			required.putAll(other.required);
			optional.putAll(other.optional);
			refinements.addAll(other.refinements);
			return this;
		}

		@Override
		public void check(JsonElement value, String path, List<String> errors) {
			if (!(value instanceof JsonObject o)) {
				errors.add(at(path) + ": expected object");
				return;
			}
			String prefix = path.isEmpty() ? "" : path + ".";
			for (Map.Entry<String, Node> e : required.entrySet()) {
				JsonElement v = o.get(e.getKey());
				if (v == null) {
					errors.add(prefix + e.getKey() + ": required");
				} else {
					e.getValue().check(v, prefix + e.getKey(), errors);
				}
			}
			for (Map.Entry<String, Node> e : optional.entrySet()) {
				JsonElement v = o.get(e.getKey());
				if (v == null) continue;
				if (v.isJsonNull()) {
					errors.add(prefix + e.getKey() + ": must be omitted rather than null");
				} else {
					e.getValue().check(v, prefix + e.getKey(), errors);
				}
			}
			if (errors.isEmpty()) {
				for (Map.Entry<Predicate<JsonObject>, String> r : refinements) {
					if (!r.getKey().test(o)) errors.add(at(path) + ": " + r.getValue());
				}
			}
		}

		/** Validates and returns the problems found (empty when valid). */
		public List<String> validate(JsonElement value) {
			List<String> errors = new ArrayList<>();
			check(value, "", errors);
			return errors;
		}
	}
}
