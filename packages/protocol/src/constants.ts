/** Wire protocol version carried in every envelope as `v`. */
export const PROTOCOL_VERSION = 1 as const;

/** WebSocket subprotocol the mod must offer (`Sec-WebSocket-Protocol`). */
export const SUBPROTOCOL = 'minevibe.v1';

/** HTTP path of the bridge endpoint. */
export const BRIDGE_PATH = '/v1';

/** The bridge only ever listens on IPv4 loopback. */
export const BRIDGE_HOST = '127.0.0.1';

/** Fixed bridge port used by `npm run dev` (release builds pick a random port). */
export const DEV_BRIDGE_PORT = 47800;

/** Largest accepted JSON text frame, in bytes (UTF-8). */
export const MAX_TEXT_FRAME_BYTES = 256 * 1024;

/** Binary frames are skipped (never queued) while the socket's send buffer exceeds this many bytes. */
export const FRAME_SKIP_BUFFERED_BYTES = 8 * 1024 * 1024;

/** Longest chat line the intercepted chat box may send. */
export const CHAT_MAX_LENGTH = 2000;

/** Default request/response timeouts (ms) by kind of request. */
export const RPC_TIMEOUTS = {
  world: 5_000,
  config: 15_000,
  default: 10_000,
} as const;
