// Spike S6: lists the main display's modes in a macOS guest and, with an argument WxH, switches to that mode
// (a 1x mode of exactly that pixel size). Run in the guest with `swift modes.swift [WxH]`.
import CoreGraphics
import Foundation

let display = CGMainDisplayID()
let opts = [kCGDisplayShowDuplicateLowResolutionModes as String: true] as CFDictionary
let modes = (CGDisplayCopyAllDisplayModes(display, opts) as? [CGDisplayMode]) ?? []
if let cur = CGDisplayCopyDisplayMode(display) {
  print("current \(cur.width)x\(cur.height) pixels \(cur.pixelWidth)x\(cur.pixelHeight)")
}
for m in modes {
  print("mode \(m.width)x\(m.height) pixels \(m.pixelWidth)x\(m.pixelHeight) usable=\(m.isUsableForDesktopGUI())")
}
if CommandLine.arguments.count > 1 {
  let want = CommandLine.arguments[1].split(separator: "x").compactMap { Int($0) }
  guard want.count == 2,
    let m = modes.first(where: { $0.width == want[0] && $0.height == want[1] && $0.pixelWidth == want[0] })
  else {
    print("no 1x mode \(CommandLine.arguments[1])")
    exit(2)
  }
  var config: CGDisplayConfigRef?
  CGBeginDisplayConfiguration(&config)
  CGConfigureDisplayWithDisplayMode(config, display, m, nil)
  let err = CGCompleteDisplayConfiguration(config, .permanently)
  print("switch to \(want[0])x\(want[1]): \(err == .success ? "ok" : "error \(err.rawValue)")")
}
