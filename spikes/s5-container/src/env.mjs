// Imported first by every spike script: keep cua state inside out/ and telemetry off.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const home = join(dirname(fileURLToPath(import.meta.url)), "..", "out", "cua-home");
mkdirSync(home, { recursive: true });
process.env.CUA_HOME ??= home;
process.env.CUA_TELEMETRY ??= "0";
process.env.DO_NOT_TRACK ??= "1";
