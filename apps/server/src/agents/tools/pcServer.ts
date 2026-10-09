/**
 * The `pc` MCP tool server (PLAN §6.2). PC tools V2 lives in `./pc/` (index.ts describes it); this module keeps the
 * import path the rest of the runtime uses.
 */

export {
  BatchBook,
  catN,
  clipOutput,
  createPcServer,
  isPcToolUse,
  jobNotification,
  numberLines,
  ownJobKey,
  PC_TOOLS,
  type PcHost,
  type PcJob,
  PcJobBook,
  parseKeyText,
  pcToolDefinitions,
  READ_DEFAULT_LIMIT,
  READ_LINE_MAX,
  stripPwdMarker,
  wrapBash,
} from './pc/index.js';
