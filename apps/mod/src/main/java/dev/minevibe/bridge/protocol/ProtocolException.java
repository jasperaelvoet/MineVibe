package dev.minevibe.bridge.protocol;

/** A message that does not match the protocol (raised before anything reaches the wire). */
public final class ProtocolException extends RuntimeException {
	public ProtocolException(String message) {
		super(message);
	}
}
