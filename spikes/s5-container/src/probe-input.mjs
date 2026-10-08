import "./env.mjs";
import { connectPc } from "./lib.mjs";
const pc = await connectPc();
const tries = process.argv.slice(2);
for (const t of tries) {
  const [kind, json] = [t.slice(0, 1), t.slice(2)];
  try {
    const r = kind === "p" ? await pc.pointerJson(json) : await pc.keyboardJson(json);
    console.log("OK ", t, "->", r.slice(0, 300));
  } catch (e) {
    console.log("ERR", t, "->", String(e?.message ?? e).slice(0, 300));
  }
}
const pos = await pc.cursorPosition();
console.log("cursor", JSON.stringify(pos));
process.exit(0);
