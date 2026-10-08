// S5 step 6c: pointer move/click/down/up/scroll and keyboard type/down/up/hotkey, each verified by effect.
import "./env.mjs";
import { createHash } from "node:crypto";
import { ImageFormat } from "@trycua/cua";
import { connectPc, save, sleep, withTimeout } from "./lib.mjs";

const pc = await connectPc();
const res = { checks: [] };
const check = (name, ok, detail) => {
  res.checks.push({ name, ok, detail });
  console.log(ok ? "PASS" : "FAIL", name, detail ?? "");
};
const P = (o) => pc.pointerJson(JSON.stringify(o));
const K = (o) => pc.keyboardJson(JSON.stringify(o));
const pos = (x, y) => ({ position: { x, y } });
const shotHash = async () => {
  const s = await pc.screenshot({ format: ImageFormat.Png, includeCursor: false });
  return createHash("sha256").update(Buffer.from(s.image)).digest("hex").slice(0, 16);
};
const sh = async (line) => {
  const o = await withTimeout(pc.sh(line, 10_000), 15_000, line);
  return Buffer.from(o.stdout).toString().trim();
};
const asCua = (line) => sh(`su cua -c ${JSON.stringify(line)}`);
const windows = async () => JSON.parse(await pc.callJson("/cua.env.v1.WindowsService/ListWindows", "{}"));

await sh("rm -f /tmp/s5-*");
// 1) spawn a terminal as cua, wait for its window
const before = await shotHash();
const term = await pc.spawn({
  program: "xfce4-terminal",
  args: ["--title=s5term", "--geometry=90x24+100+100", "--disable-server"],
  env: new Map([["DISPLAY", ":1"]]),
  user: "cua",
  stdin: false,
  tag: "s5-term",
});
let win;
for (let i = 0; i < 40 && !win; i++) {
  await sleep(250);
  const w = await windows();
  win = (w.windows ?? []).find((x) => (x.title ?? "").includes("s5term"));
}
res.window = win;
check("spawned xfce4-terminal window appears", !!win, win ? JSON.stringify(win.bounds ?? win).slice(0, 200) : "no window");
const after = await shotHash();
check("screenshot hash changes when window opens", before !== after, `${before} -> ${after}`);
const b = win?.bounds ?? { x: 100, y: 100, width: 700, height: 450 };
const cx = Math.round((b.x ?? 100) + (b.width ?? 700) / 2);
const cy = Math.round((b.y ?? 100) + (b.height ?? 450) / 2);

// 2) pointer move + click to focus
await P({ move: pos(cx, cy) });
const cp = await pc.cursorPosition();
check("pointer move", Math.abs(cp.x - cx) <= 1 && Math.abs(cp.y - cy) <= 1, JSON.stringify(cp));
await P({ click: { ...pos(cx, cy), button: "MOUSE_BUTTON_LEFT", count: 1 } });
await sleep(200);

// 3) typeText + press Enter -> file written by the shell in the terminal
await K({ type: { text: "echo s5-typed-$((6*7)) > /tmp/s5-typed.txt" } });
await K({ press: { key: { named: "KEY_ENTER" } } });
await sleep(500);
const typed = await sh("cat /tmp/s5-typed.txt 2>/dev/null");
check("keyboard type + press Enter", typed === "s5-typed-42", JSON.stringify(typed));

// 4) keyboard down/up: hold Shift while pressing a -> 'A'
await K({ type: { text: "echo " } });
await K({ down: { key: { named: "KEY_SHIFT" } } });
await K({ press: { key: { character: "a" } } });
await K({ up: { key: { named: "KEY_SHIFT" } } });
await K({ press: { key: { character: "b" } } });
await K({ type: { text: " > /tmp/s5-shift.txt" } });
await K({ press: { key: { named: "KEY_ENTER" } } });
await sleep(500);
const shifted = await sh("cat /tmp/s5-shift.txt 2>/dev/null");
check("keyboard down/up (Shift held)", shifted === "Ab", JSON.stringify(shifted));

// 5) hotkey ctrl+c interrupts a running command
await K({ type: { text: "sleep 20 && touch /tmp/s5-not-interrupted" } });
await K({ press: { key: { named: "KEY_ENTER" } } });
await sleep(500);
await pc.hotkey(["ctrl", "c"]);
await sleep(300);
await K({ type: { text: "touch /tmp/s5-after-ctrlc" } });
await K({ press: { key: { named: "KEY_ENTER" } } });
await sleep(500);
const ctrlc = await sh("ls /tmp/s5-after-ctrlc /tmp/s5-not-interrupted 2>&1");
check("hotkey ctrl+c", ctrlc.includes("/tmp/s5-after-ctrlc") && ctrlc.includes("No such file"), JSON.stringify(ctrlc));

// 6) scroll: fill scrollback, scroll up -> screen changes; scroll down -> back
await K({ type: { text: "clear; seq 1 300" } });
await K({ press: { key: { named: "KEY_ENTER" } } });
await sleep(500);
const h0 = await shotHash();
await P({ scroll: { ...pos(cx, cy), deltaY: -10 } });
await sleep(300);
const h1 = await shotHash();
await P({ scroll: { ...pos(cx, cy), deltaY: 10 } });
await sleep(300);
const h2 = await shotHash();
check("pointer scroll up/down", h0 !== h1 && h2 === h0, `${h0} -> ${h1} -> ${h2}`);

// 7) pointer down / move / up: drag the window by its title bar
const w0 = (await windows()).windows.find((x) => (x.title ?? "").includes("s5term"));
const tb = { x: (w0.bounds?.x ?? 100) + 150, y: (w0.bounds?.y ?? 100) - 12 };
const xdo0 = await asCua("DISPLAY=:1 xdotool search --name s5term getwindowgeometry 2>/dev/null | head -3");
await P({ move: pos(tb.x, tb.y) });
await P({ down: { button: "MOUSE_BUTTON_LEFT" } });
for (let i = 1; i <= 10; i++) {
  await P({ move: pos(tb.x + i * 15, tb.y + i * 10) });
  await sleep(20);
}
await P({ up: { button: "MOUSE_BUTTON_LEFT" } });
await sleep(400);
const w1 = (await windows()).windows.find((x) => (x.title ?? "").includes("s5term"));
const xdo1 = await asCua("DISPLAY=:1 xdotool search --name s5term getwindowgeometry 2>/dev/null | head -3");
const moved = JSON.stringify(w0.bounds) !== JSON.stringify(w1.bounds) || xdo0 !== xdo1;
check("pointer down/move/up drags window", moved, `${JSON.stringify(w0.bounds)} -> ${JSON.stringify(w1.bounds)} | xdotool ${JSON.stringify(xdo0)} -> ${JSON.stringify(xdo1)}`);

// 8) right click + Escape (menu opens -> screen changes; Escape closes)
const r0 = await shotHash();
await pc.rightClick(cx + 100, cy + 40);
await sleep(400);
const r1 = await shotHash();
await pc.press("escape");
await sleep(300);
check("right click opens a context menu", r0 !== r1, `${r0} -> ${r1}`);

// 9) clipboard roundtrip
await pc.setClipboard("s5-clip");
check("clipboard set/get", (await pc.getClipboard()) === "s5-clip");

await term.kill().catch(() => {});
res.typedApi = {
  pointer: "pointerJson({click|move|down|up|drag|scroll: {position:{x,y}, button:'MOUSE_BUTTON_LEFT', count, deltaX, deltaY, unit, duration}, target?})",
  keyboard: "keyboardJson({type:{text} | press:{key:{named:'KEY_ENTER'}|{character:'a'}, modifiers, repeat} | hotkey:{keys:[Key]} | down:{key} | up:{key}, target?})",
  sugar: "moveTo, click, doubleClick, rightClick, drag, scroll(dx,dy), typeText, press(key), hotkey(['ctrl','c']), cursorPosition, get/setClipboard",
};
save("input.json", res);
const fails = res.checks.filter((c) => !c.ok).length;
console.log(`${res.checks.length - fails}/${res.checks.length} passed`);
process.exit(fails ? 1 : 0);
