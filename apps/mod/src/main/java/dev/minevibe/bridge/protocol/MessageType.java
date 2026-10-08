package dev.minevibe.bridge.protocol;

/**
 * One entry of the message catalog: the wire name, who sends it, the full-message schema (envelope keys
 * included) and the Gson record its payload is read into.
 *
 * @param <P> payload record type
 */
public record MessageType<P>(String name, Direction direction, Schema.Obj schema, Class<P> payloadClass) {
	/** Which peer sends a message type (mirrors {@code Direction} in {@code registry.ts}). */
	public enum Direction {
		MOD_TO_NODE,
		NODE_TO_MOD,
		BOTH;

		public boolean modSends() {
			return this != NODE_TO_MOD;
		}

		public boolean nodeSends() {
			return this != MOD_TO_NODE;
		}
	}

	@Override
	public String toString() {
		return name;
	}
}
