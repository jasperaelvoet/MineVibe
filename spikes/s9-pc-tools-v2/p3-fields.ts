import type { ProbeCtx } from './client.js';

/** Enumerates request fields from serde's "unknown field … expected one of" errors. */
export default async function (p: ProbeCtx) {
  const probes: [string, unknown][] = [
    ['AccessibilityService/GetTree', { zz: 1 }],
    ['AccessibilityService/GetTree', { window: { zz: 1 } }],
    ['AccessibilityService/Find', { query: { zz: 1 } }],
    ['AccessibilityService/Act', { zz: 1 }],
    ['AccessibilityService/Act', { element: { zz: 1 } }],
    ['WindowsService/ListWindows', { zz: 1 }],
    ['WindowsService/ActivateWindow', { zz: 1 }],
    ['WindowsService/CloseWindow', { zz: 1 }],
    ['WindowsService/LaunchApp', { zz: 1 }],
    ['WindowsService/Open', { zz: 1 }],
    ['WindowsService/GetWindow', { zz: 1 }],
    ['ComputerService/Screenshot', { zz: 1 }],
    ['ComputerService/Screenshot', { region: { zz: 1 } }],
    ['ComputerService/Pointer', { zz: 1 }],
    ['ComputerService/Pointer', { click: { zz: 1 } }],
    ['ComputerService/Pointer', { scroll: { zz: 1 } }],
    ['ComputerService/Pointer', { down: { zz: 1 } }],
    ['ComputerService/Pointer', { move: { zz: 1 } }],
    ['ComputerService/Pointer', { drag: { zz: 1 } }],
    ['ComputerService/Keyboard', { zz: 1 }],
    ['ComputerService/Keyboard', { press: { zz: 1 } }],
    ['ComputerService/Keyboard', { type: { zz: 1 } }],
    ['ComputerService/Keyboard', { hotkey: { zz: 1 } }],
    ['ComputerService/GetCursorPosition', { zz: 1 }],
    ['DriverService/ListTools', { zz: 1 }],
    ['DriverService/CallTool', { zz: 1 }],
    ['FilesystemService/ReadFile', { zz: 1 }],
    ['FilesystemService/Stat', { zz: 1 }],
  ];
  for (const [m, req] of probes) {
    try {
      const r = await p.call(m, req);
      p.log(m, JSON.stringify(req), 'OK', JSON.stringify(r).slice(0, 600));
    } catch (e) {
      p.log(m, JSON.stringify(req), String(e).slice(0, 600));
    }
  }
}
