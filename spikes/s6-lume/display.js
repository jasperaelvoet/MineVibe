// M9: the display mode switch as JXA (osascript -l JavaScript display.js 1280x800), instead of a Swift script whose
// first run in a fresh clone builds the Clang module cache. No Apple events: only CoreGraphics through the ObjC bridge.
ObjC.import('CoreGraphics');
function run(argv) {
  const want = String(argv[0] || '').split('x').map(Number);
  const display = $.CGMainDisplayID();
  const opts = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $.kCGDisplayShowDuplicateLowResolutionModes);
  const modes = ObjC.castRefToObject($.CGDisplayCopyAllDisplayModes(display, opts));
  const n = modes.count;
  const seen = [];
  let pick = null;
  for (let i = 0; i < n; i++) {
    const m = modes.objectAtIndex(i);
    const w = Number($.CGDisplayModeGetWidth(m));
    const h = Number($.CGDisplayModeGetHeight(m));
    const pw = Number($.CGDisplayModeGetPixelWidth(m));
    seen.push(`${w}x${h}@${pw}`);
    if (!pick && w === want[0] && h === want[1] && pw === want[0] && Boolean($.CGDisplayModeIsUsableForDesktopGUI(m))) pick = m;
  }
  if (!pick) return `no 1x mode ${argv[0]} in ${seen.join(' ')}`;
  const ref = Ref();
  $.CGBeginDisplayConfiguration(ref);
  $.CGConfigureDisplayWithDisplayMode(ref[0], display, pick, null);
  const err = $.CGCompleteDisplayConfiguration(ref[0], $.kCGConfigurePermanently);
  return Number(err) === 0 ? "ok" : `error ${err}`;
}
