// JXA: prints the CGWindow number of the Minecraft window owned by a process id (argv[0]), or nothing.
// Used by run-scenario.ts so screenshots capture the game window only (`screencapture -l <id>`), not the desktop.
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
// biome-ignore lint/correctness/noUnusedVariables: osascript calls run(argv), the JXA entry point
function run(argv) {
  const pid = Number(argv[0]);
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0)));
  const win = list.find(
    (w) => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0 && /^Minecraft/.test(w.kCGWindowName ?? ''),
  );
  return win ? String(win.kCGWindowNumber) : '';
}
