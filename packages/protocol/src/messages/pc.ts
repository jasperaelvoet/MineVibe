import { z } from 'zod';
import { AgentId, BlockPos, ConsentId, Fraction, NonNegInt, Occupant, PcId, UInt32 } from './common.js';
import { type CatalogEntry, defineMessage } from './define.js';

// ---------------------------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------------------------

/** PC types (PLAN §8.1). `windows` is shown greyed out and never sent. */
export const PcType = z.enum(['linux', 'linux-slim', 'macos']);
export type PcType = z.infer<typeof PcType>;

/** PC statuses (PLAN §8.1), shown on the monitor, the LED, the HUD hover line and PcConfigScreen. */
export const PcStatus = z.enum([
  'off',
  'downloading',
  'awaiting_consent',
  'booting',
  'running',
  'stopping',
  'remounting',
  'reimaging',
  'no_capacity',
  'macos_slots_full',
  'engine_down',
  'error',
  /** The PC was deleted; the mod drops its texture and shows the workstation as empty. */
  'decommissioned',
]);
export type PcStatus = z.infer<typeof PcStatus>;

/** A Vault folder mounted into a PC at the identical path (PLAN §8.3). */
export const VaultMount = z.object({
  hostPath: z.string().min(1).max(1024).startsWith('/'),
  mode: z.enum(['rw', 'ro']),
});
export type VaultMount = z.infer<typeof VaultMount>;

/** A download the player must approve (macOS image, ~24 GB; a Linux PC's Android phone or KVM the first time). */
export const PcConsentPrompt = z.object({
  consentId: ConsentId,
  /** What will be downloaded ("macOS 26 image"). */
  what: z.string().min(1).max(200),
  bytes: NonNegInt,
  /** Free disk space, for the modal. */
  freeBytes: NonNegInt,
});
export type PcConsentPrompt = z.infer<typeof PcConsentPrompt>;

/** The Android phone of a PC (PLAN §8.7). */
export const PhoneStatus = z.enum(['off', 'preparing', 'starting', 'running', 'error']);
export type PhoneStatus = z.infer<typeof PhoneStatus>;

/**
 * What a Linux PC can do beyond the stock container (PLAN §8.7), and whether this Mac allows it: `unavailable` is
 * null when it can, else why not ("needs an M3 or newer Mac").
 */
export const PcCapabilities = z.object({
  /** Nested virtualization: KVM inside the PC (M3 or newer). Changing it recreates the PC. */
  virtualization: z.object({
    enabled: z.boolean(),
    unavailable: z.string().min(1).max(200).nullable(),
  }),
  /** The Android phone: a Redroid container on the PC's network (`android-phone`), 4 vCPUs and 4 GiB. */
  android: z.object({
    enabled: z.boolean(),
    unavailable: z.string().min(1).max(200).nullable(),
    status: PhoneStatus,
    /** `preparing` progress (first use downloads the image and builds the kernel), null otherwise. */
    progress: Fraction.nullable(),
    detail: z.string().min(1).max(256).nullable(),
  }),
});
export type PcCapabilities = z.infer<typeof PcCapabilities>;

/** Everything the mod shows about one PC (monitor, LED, PcConfigScreen, PCs & Resources). */
export const PcInfo = z.object({
  pcId: PcId,
  type: PcType,
  /** Display name ("linux-1" unless renamed). */
  name: z.string().min(1).max(32),
  status: PcStatus,
  /** `downloading` / `booting` progress, null when not applicable. */
  progress: Fraction.nullable(),
  /** Human detail for `error`, `engine_down`, `no_capacity` ("Apple allows 2 macOS VMs"); null otherwise. */
  detail: z.string().min(1).max(256).nullable(),
  /** The MVF1 `pcSlot` that carries this PC's frames. */
  slot: UInt32,
  /** Allocated vCPUs as configured (`--cpus`; the budget counts one more, PLAN §8.6). */
  cpus: z.number().int().min(1).max(64),
  memoryMiB: z.number().int().min(256).max(1_048_576),
  /** Disk cap (sparse volumes get an explicit cap, PLAN §8.6). */
  diskGiB: z.number().int().min(1).max(16_384),
  /** False after the workstation was broken ("unplugged"): `bootAll` skips it. */
  plugged: z.boolean(),
  pinned: z.boolean(),
  wipeOnDeath: z.boolean(),
  mounts: z.array(VaultMount).max(16),
  /** Who sits in the chair. */
  occupant: Occupant.nullable(),
  /** "Bram is coming" (`coming`) or "BRB: asking Jordan" (`away`). */
  reservation: z.object({ agentId: AgentId, kind: z.enum(['coming', 'away']) }).nullable(),
  /** Monitor banner, e.g. "? for Jordan"; null when none. */
  banner: z.string().min(1).max(80).nullable(),
  /** Guest screen size in pixels once known. */
  screen: z
    .object({ w: z.number().int().min(1).max(65_535), h: z.number().int().min(1).max(65_535) })
    .nullable(),
  /**
   * A download that waits for the player's OK: a macOS image while `status` is `awaiting_consent`, or what turning on
   * a Linux PC's Android phone or nested virtualization needs the first time (the PC keeps its status; PLAN §8.7).
   */
  consent: PcConsentPrompt.nullable(),
  /** Linux PCs only (absent for macOS). */
  capabilities: PcCapabilities.optional(),
});
export type PcInfo = z.infer<typeof PcInfo>;

/** Host resource budget for PCs (PLAN §8.2). */
export const Budget = z.object({
  /** vCPUs: `total` = cores − 4; `used` counts each PC's cpus + 1 overhead. */
  cpu: z.object({
    total: NonNegInt,
    used: NonNegInt,
    free: z.number().int(),
    maxOvercommit: z.number().min(1).max(4),
  }),
  /** PC RAM pool = host RAM − reserves (macOS, Minecraft, Node, claude per crew slot, container system). */
  memoryMiB: z.object({ pool: NonNegInt, used: NonNegInt, free: z.number().int() }),
  /** Free disk on the data volume; creating a macOS PC needs at least 40 GB. */
  diskFreeGiB: NonNegInt,
  macos: z.object({ running: NonNegInt, max: NonNegInt }),
  crewCap: NonNegInt,
});
export type Budget = z.infer<typeof Budget>;

/**
 * One `pc.input` event. Coordinates are guest screen pixels. Keys are cua key names (`KEY_ENTER`, `a`, ...),
 * already mapped from SDL scancodes (Cmd → ctrl on Linux guests, cmd on macOS guests).
 */
export const InputEvent = z.discriminatedUnion('k', [
  z.object({
    k: z.literal('move'),
    x: z.number().int().min(0).max(65_535),
    y: z.number().int().min(0).max(65_535),
  }),
  z.object({
    k: z.literal('button'),
    button: z.enum(['left', 'right', 'middle']),
    down: z.boolean(),
    x: z.number().int().min(0).max(65_535),
    y: z.number().int().min(0).max(65_535),
  }),
  z.object({
    k: z.literal('scroll'),
    dx: z.number().int().min(-10_000).max(10_000),
    dy: z.number().int().min(-10_000).max(10_000),
    x: z.number().int().min(0).max(65_535),
    y: z.number().int().min(0).max(65_535),
  }),
  z.object({
    k: z.literal('key'),
    key: z.string().regex(/^[A-Za-z0-9_]{1,32}$/, 'cua key name'),
    down: z.boolean(),
  }),
  /** Layout-correct text from `charTyped` (AZERTY works). */
  z.object({ k: z.literal('text'), text: z.string().min(1).max(512) }),
  /** Release every held key and button (sent on every stand-up and focus loss). */
  z.object({ k: z.literal('release_all') }),
]);
export type InputEvent = z.infer<typeof InputEvent>;

/** `pc.action` actions. */
export const PcActionKind = z.enum([
  'create',
  'start',
  'stop',
  'restart',
  'reimage',
  'decommission',
  /** Re-issue the workstation item for an existing PC (lost in lava or a grave). */
  'reissue',
  /** The workstation was broken: stop the PC and mark it unplugged. */
  'unplug',
  /** The workstation was placed again: bind the same sandbox and start it. */
  'plug',
  /** Kick the seated agent. */
  'kick',
  /** Watch mode: the player views the PC fullscreen, read-only (focus frame tier). */
  'watch',
  'unwatch',
]);
export type PcActionKind = z.infer<typeof PcActionKind>;

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

/** N→M. The full state of one PC (sent on every change, and for every PC after `hello.ok`). */
export const PcState = defineMessage('pc.state', PcInfo.shape).describe('State of one PC.');

/** N→M. Host budget for PCs (PcConfigScreen bars, macOS slots `n/2`). */
export const BudgetState = defineMessage('budget.state', Budget.shape).describe('Host PC budget.');

/** M→N. PcViewTracker: how the player sees a PC, which sets its frame tier (PLAN §8.4). Sent on change. */
export const PcView = defineMessage('pc.view', {
  pcId: PcId,
  /** `focus`: seated or watching (≤ 30 fps). `visible`: on screen within 32 blocks. `none`: 0 fps. */
  tier: z.enum(['focus', 'visible', 'none']),
}).describe('How the player currently sees a PC (frame tier).');

/** M→N. Input from the player at a PC, batched at most 60 times a second. Node checks the occupant. */
export const PcInput = defineMessage('pc.input', {
  pcId: PcId,
  /** Per-PC batch sequence number. */
  seq: UInt32,
  events: z.array(InputEvent).min(1).max(256),
}).describe('A batch of player input for the PC the player sits at.');

/** M→N. The mod decoded frame `seq` of this PC (at most 2 unacknowledged frames per PC). */
export const PcFrameAck = defineMessage('pc.frame.ack', {
  pcId: PcId,
  seq: UInt32,
}).describe('Acknowledges an MVF1 frame.');

/** N→M. The agent's cursor (frames have no cursor drawn in, PLAN §8.6): the last pointer target. */
export const PcCursor = defineMessage('pc.cursor', {
  pcId: PcId,
  x: z.number().int().min(0).max(65_535),
  y: z.number().int().min(0).max(65_535),
  visible: z.boolean(),
}).describe("The seated agent's cursor position on a PC.");

/**
 * M→N request (PcConfigScreen). Absent keys are unchanged. Changing `type`, `cpus`, `memoryMiB`, `mounts` or
 * `virtualization` recreates the PC (keeping the home volume and the Vault); `android` starts or removes the PC's
 * phone without touching the PC (off deletes the phone's apps and data). Errors: `OVER_BUDGET`, `BAD_MOUNT`,
 * `PC_UNKNOWN`, `BAD_MESSAGE` (a capability this Mac cannot have).
 */
export const PcConfig = defineMessage('pc.config', {
  pcId: PcId,
  name: z.string().min(1).max(32).optional(),
  type: PcType.optional(),
  cpus: z.number().int().min(1).max(64).optional(),
  memoryMiB: z.number().int().min(256).max(1_048_576).optional(),
  mounts: z.array(VaultMount).max(16).optional(),
  pinned: z.boolean().optional(),
  wipeOnDeath: z.boolean().optional(),
  /** Nested virtualization (Linux, M3 or newer). */
  virtualization: z.boolean().optional(),
  /** The Android phone (Linux). */
  android: z.boolean().optional(),
}).describe('Changes a PC configuration.');

export const PcConfigResult = z.object({
  /** The change recreates the PC. */
  recreate: z.boolean(),
});
export type PcConfigResult = z.infer<typeof PcConfigResult>;

/**
 * M→N request. `create` needs `type` (and has no `pcId`); every other action needs `pcId`. `pos` is where the
 * workstation was placed (create, plug). Errors: `OVER_BUDGET`, `NO_CAPACITY`, `MACOS_SLOTS_FULL`, `PC_UNKNOWN`.
 */
export const PcAction = defineMessage('pc.action', {
  action: PcActionKind,
  pcId: PcId.optional(),
  type: PcType.optional(),
  pos: BlockPos.optional(),
})
  .refine(
    (m) => (m.action === 'create' ? m.type !== undefined && m.pcId === undefined : m.pcId !== undefined),
    {
      message: 'create needs type and no pcId; other actions need pcId',
      path: ['action'],
    },
  )
  .describe('A PC lifecycle action from PcConfigScreen, a workstation item or the PCs menu.');

export const PcActionResult = z.object({
  /** The PC acted on (the new one for `create`). */
  pcId: PcId,
});
export type PcActionResult = z.infer<typeof PcActionResult>;

/** M→N request. The player's answer to a download consent modal. */
export const PcConsent = defineMessage('pc.consent', {
  pcId: PcId,
  consentId: ConsentId,
  accept: z.boolean(),
}).describe('Accepts or declines a PC download.');

/**
 * M→N request. Asks the Swift stub for the native folder picker (Vault "Browse…"). The reply is
 * {@link PickFolderResult}; `path` is null when the player cancelled.
 */
export const HostPickFolder = defineMessage('host.pick_folder', {
  purpose: z.literal('vault'),
  pcId: PcId.optional(),
  /** Picker title. */
  prompt: z.string().min(1).max(120).optional(),
}).describe('Opens the native folder picker.');

export const PickFolderResult = z.object({
  path: z.string().min(1).max(1024).startsWith('/').nullable(),
});
export type PickFolderResult = z.infer<typeof PickFolderResult>;

export const pcMessages = {
  'pc.state': {
    schema: PcState,
    direction: 'node_to_mod',
    group: 'pc',
    summary: 'State of one PC: status, resources, mounts, occupant, reservation, banner.',
  },
  'budget.state': {
    schema: BudgetState,
    direction: 'node_to_mod',
    group: 'pc',
    summary: 'Host PC budget: vCPU, RAM pool, disk, macOS slots.',
  },
  'pc.view': {
    schema: PcView,
    direction: 'mod_to_node',
    group: 'pc',
    summary: 'Frame tier of a PC as the player sees it (focus, visible, none).',
  },
  'pc.input': {
    schema: PcInput,
    direction: 'mod_to_node',
    group: 'pc',
    summary: 'Batched player input for the PC the player sits at (≤ 60 Hz).',
  },
  'pc.frame.ack': {
    schema: PcFrameAck,
    direction: 'mod_to_node',
    group: 'pc',
    summary: 'Acknowledges a decoded MVF1 frame (≤ 2 unacked per PC).',
  },
  'pc.cursor': {
    schema: PcCursor,
    direction: 'node_to_mod',
    group: 'pc',
    summary: "The seated agent's cursor (frames carry no cursor).",
  },
  'pc.config': {
    schema: PcConfig,
    direction: 'mod_to_node',
    group: 'pc',
    summary:
      'Request: change a PC (resources, type, mounts, flags, virtualization, Android phone); may recreate it.',
    reply: PcConfigResult,
  },
  'pc.action': {
    schema: PcAction,
    direction: 'mod_to_node',
    group: 'pc',
    summary: 'Request: create, start, stop, restart, reimage, decommission, plug, kick, watch, ...',
    reply: PcActionResult,
  },
  'pc.consent': {
    schema: PcConsent,
    direction: 'mod_to_node',
    group: 'pc',
    summary: 'Request: accept or decline a PC download.',
  },
  'host.pick_folder': {
    schema: HostPickFolder,
    direction: 'mod_to_node',
    group: 'pc',
    summary: 'Request: native folder picker through the stub (Vault "Browse…").',
    reply: PickFolderResult,
  },
} as const satisfies Record<string, CatalogEntry>;
