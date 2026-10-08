package dev.minevibe.bridge.protocol;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.google.gson.Strictness;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.IOException;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * Parses and encodes bridge text frames. The counterpart of {@code safeParseMessage} / {@code encodeMessage}
 * in {@code packages/protocol/src/registry.ts}: unknown types are reported (not thrown), invalid messages keep
 * their envelope id when it was readable, and outgoing messages are validated before they reach the wire.
 */
public final class ProtocolCodec {
	private ProtocolCodec() {}

	/** Reads and serialises payload records; null fields are omitted, which is how optional keys are written. */
	public static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

	/** Writes the final JSON tree; explicit {@code JsonNull}s (nullable keys in {@code ok} results) are kept. */
	private static final Gson WRITER = new GsonBuilder().disableHtmlEscaping().serializeNulls().create();

	/** Outcome of {@link #parse(String)}. */
	public sealed interface Parsed permits Valid, UnknownType, Invalid {}

	/** A known, schema-valid message. */
	public record Valid(MessageType<?> type, @Nullable String id, @Nullable String re, Object payload, JsonObject json)
			implements Parsed {
		@SuppressWarnings("unchecked")
		public <P> P payloadAs(MessageType<P> expected) {
			if (expected != type) throw new IllegalArgumentException("message is " + type + ", not " + expected);
			return (P) payload;
		}
	}

	/** A well-formed envelope with a type this build does not know: ignored (forward compatibility). */
	public record UnknownType(String t, @Nullable String id, @Nullable String re) implements Parsed {}

	/**
	 * Malformed input. {@code t} and {@code id} are set when the envelope itself was valid, so a request can still
	 * be answered with {@code err BAD_MESSAGE}.
	 */
	public record Invalid(@Nullable String t, @Nullable String id, String error) implements Parsed {}

	/** Decodes and validates one JSON text frame. Never throws. */
	public static Parsed parse(String text) {
		if (exceedsTextFrameLimit(text)) {
			return new Invalid(null, null, "frame exceeds " + Messages.MAX_TEXT_FRAME_BYTES + " bytes");
		}
		JsonElement json;
		try {
			JsonReader reader = new JsonReader(new StringReader(text));
			reader.setStrictness(Strictness.STRICT);
			json = JsonParser.parseReader(reader);
			if (reader.peek() != JsonToken.END_DOCUMENT) return new Invalid(null, null, "not valid JSON");
		} catch (JsonParseException | IllegalStateException | IOException e) {
			return new Invalid(null, null, "not valid JSON");
		}
		return parse(json);
	}

	/** Validates an already-decoded JSON value. Never throws. */
	public static Parsed parse(JsonElement json) {
		List<String> envelopeErrors = Messages.ENVELOPE.validate(json);
		if (!envelopeErrors.isEmpty()) {
			return new Invalid(null, null, "bad envelope: " + summarize(envelopeErrors));
		}
		JsonObject obj = json.getAsJsonObject();
		String t = obj.get("t").getAsString();
		String id = stringOrNull(obj, "id");
		String re = stringOrNull(obj, "re");
		MessageType<?> type = Messages.byName(t);
		if (type == null) return new UnknownType(t, id, re);
		List<String> errors = type.schema().validate(obj);
		if (!errors.isEmpty()) return new Invalid(t, id, t + ": " + summarize(errors));
		Object payload;
		try {
			payload = readPayload(type, obj);
		} catch (RuntimeException e) {
			return new Invalid(t, id, t + ": " + e.getMessage());
		}
		return new Valid(type, id, re, payload, obj);
	}

	private static Object readPayload(MessageType<?> type, JsonObject obj) {
		if (type == Messages.OK) {
			JsonObject result = obj.deepCopy();
			for (String key : List.of("t", "v", "id", "re")) result.remove(key);
			return new Messages.Ok(result);
		}
		return GSON.fromJson(obj, type.payloadClass());
	}

	/**
	 * Builds a message of type {@code type} and validates it, so a bug on the sending side never reaches the wire.
	 *
	 * @throws ProtocolException if the result does not match the schema or exceeds the text frame limit
	 */
	public static <P> String encode(MessageType<P> type, P payload, @Nullable String id, @Nullable String re) {
		JsonObject obj = new JsonObject();
		obj.addProperty("t", type.name());
		obj.addProperty("v", Messages.PROTOCOL_VERSION);
		if (id != null) obj.addProperty("id", id);
		if (re != null) obj.addProperty("re", re);
		JsonElement body = payload instanceof Messages.Ok ok ? ok.result() : GSON.toJsonTree(payload);
		if (body.isJsonObject()) {
			for (Map.Entry<String, JsonElement> e : body.getAsJsonObject().entrySet()) {
				if (!obj.has(e.getKey())) obj.add(e.getKey(), e.getValue());
			}
		}
		List<String> errors = type.schema().validate(obj);
		if (!errors.isEmpty()) throw new ProtocolException(type.name() + ": " + summarize(errors));
		String text = WRITER.toJson(obj);
		if (exceedsTextFrameLimit(text)) {
			throw new ProtocolException(type.name() + " frame exceeds " + Messages.MAX_TEXT_FRAME_BYTES + " bytes");
		}
		return text;
	}

	/** An {@code ok} reply carrying {@code result} (any JSON-serialisable values; nulls are kept). */
	public static String encodeOk(String re, @Nullable Map<String, ?> result) {
		JsonObject body = new JsonObject();
		if (result != null) {
			for (Map.Entry<String, ?> e : result.entrySet()) {
				body.add(e.getKey(), GSON.toJsonTree(e.getValue()));
			}
		}
		return encode(Messages.OK, new Messages.Ok(body), null, re);
	}

	/** An {@code err} reply. The message is cut to 2000 characters. */
	public static String encodeErr(String re, String code, String msg) {
		String m = msg.length() > 2000 ? msg.substring(0, 2000) : msg;
		return encode(Messages.ERR, new Messages.Err(code, m), null, re);
	}

	/** True when {@code text} encodes to more than {@link Messages#MAX_TEXT_FRAME_BYTES} bytes of UTF-8. */
	public static boolean exceedsTextFrameLimit(CharSequence text) {
		if ((long) text.length() * 3 <= Messages.MAX_TEXT_FRAME_BYTES) return false;
		if (text.length() > Messages.MAX_TEXT_FRAME_BYTES) return true;
		return text.toString().getBytes(StandardCharsets.UTF_8).length > Messages.MAX_TEXT_FRAME_BYTES;
	}

	private static @Nullable String stringOrNull(JsonObject obj, String key) {
		JsonElement e = obj.get(key);
		return e instanceof JsonPrimitive p && p.isString() ? p.getAsString() : null;
	}

	private static String summarize(List<String> errors) {
		return String.join("; ", errors.subList(0, Math.min(5, errors.size())));
	}
}
