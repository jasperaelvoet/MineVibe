package dev.minevibe.bridge;

/**
 * A failure with a protocol error code. Thrown by request handlers to reply {@code err{code,msg}}, and used to
 * complete {@link BridgeClient#request} futures exceptionally (the peer's {@code err} code, {@code TIMEOUT} or
 * {@code DISCONNECTED}).
 */
public final class BridgeException extends RuntimeException {
	private final String code;

	public BridgeException(String code, String message) {
		super(message);
		this.code = code;
	}

	public String code() {
		return code;
	}

	@Override
	public String toString() {
		return "BridgeException[" + code + "]: " + getMessage();
	}
}
