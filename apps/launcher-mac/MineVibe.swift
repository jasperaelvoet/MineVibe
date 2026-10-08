// MineVibe.app stub (PLAN §9): the only native code in MineVibe, and the only UI outside Minecraft.
//
// It refuses to run from TCC-protected folders (PLAN §8.6), spawns the bundled Node with
// `Resources/server/dist/main.mjs app`, and talks to it over stdin/stdout NDJSON (PLAN §9.2):
//   Node -> stub: hello, progress, ready, pickFolder, error, exit, selftest
//   stub -> Node: hello, shutdown, pickFolder.result
// Node's stdin is the lifeline: when this process dies, Node reads EOF and tears everything down.
// A quit Apple Event (logout) or SIGTERM sends `shutdown`, waits up to 60 s, then SIGKILLs Node.
//
// Build: xcrun swiftc -O -parse-as-library -target arm64-apple-macos26.0 -o MineVibe MineVibe.swift
// Modes: (none) the app; --selftest (stub <-> Node handshake, no game); --check-location <path>; --version.

import AppKit
import Darwin

let stubVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
let env = ProcessInfo.processInfo.environment

func envSeconds(_ name: String, _ fallback: Double) -> Double {
    if let raw = env[name], let value = Double(raw), value > 0 { return value }
    return fallback
}

/// Grace between `shutdown` and SIGKILL (PLAN §9.2). Tests shorten it.
let shutdownGrace = envSeconds("MINEVIBE_STUB_GRACE_S", 60)
/// How long Node may take to say hello.
let handshakeTimeout = envSeconds("MINEVIBE_STUB_HANDSHAKE_S", 30)

// MARK: - Log (~/Library/Logs/MineVibe/launcher.log, or $MINEVIBE_HOME/Logs; Node's stderr goes here too)

enum StubLog {
    static let url: URL = {
        let base: URL
        if let home = env["MINEVIBE_HOME"], home.hasPrefix("/") {
            base = URL(fileURLWithPath: home).appendingPathComponent("Logs")
        } else {
            base = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/MineVibe")
        }
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("launcher.log")
    }()

    static let handle: FileHandle? = {
        let fm = FileManager.default
        // Keep one previous log; never let it grow without bound.
        if let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? Int, size > 5_000_000 {
            let old = url.appendingPathExtension("1")
            try? fm.removeItem(at: old)
            try? fm.moveItem(at: url, to: old)
        }
        // O_APPEND: Node writes its stderr through the same file.
        let fd = open(url.path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o644)
        return fd >= 0 ? FileHandle(fileDescriptor: fd, closeOnDealloc: true) : nil
    }()

    static func write(_ message: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) [stub \(getpid())] \(message)\n"
        try? handle?.write(contentsOf: Data(line.utf8))
    }
}

// MARK: - Location (PLAN §8.6: container's vmnet fails inside TCC-protected folders)

enum LocationVerdict: Equatable {
    case ok
    case protected(String)
    case translocated

    var code: String {
        switch self {
        case .ok: return "ok"
        case .protected(let name): return "protected: \(name)"
        case .translocated: return "translocated"
        }
    }
}

func locationVerdict(_ path: String, home: String = NSHomeDirectory()) -> LocationVerdict {
    let p = URL(fileURLWithPath: path).resolvingSymlinksInPath().path.lowercased()
    if p.contains("/apptranslocation/") { return .translocated }
    let h = URL(fileURLWithPath: home).resolvingSymlinksInPath().path.lowercased()
    let protectedDirs = [
        ("Documents", "Documents"), ("Desktop", "Desktop"), ("Downloads", "Downloads"),
        ("Library/Mobile Documents", "iCloud Drive"), ("Library/CloudStorage", "a cloud storage folder"),
    ]
    for (rel, name) in protectedDirs {
        let root = "\(h)/\(rel.lowercased())"
        if p == root || p.hasPrefix(root + "/") { return .protected(name) }
    }
    if p.hasPrefix("/volumes/") { return .protected("an external or network volume") }
    return .ok
}

/// Explains the problem, offers to move the app to /Applications, and never returns.
func refuseLocation(_ verdict: LocationVerdict, bundleURL: URL) -> Never {
    StubLog.write("refusing to run from \(bundleURL.path) (\(verdict.code))")
    NSApp.activate()
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Move MineVibe to your Applications folder"
    switch verdict {
    case .protected(let name):
        alert.informativeText = "MineVibe can’t run from \(name): macOS privacy protection there blocks the "
            + "virtual network that MineVibe’s in-game computers use. Move it to Applications and open it again."
        alert.addButton(withTitle: "Move to Applications")
    default:
        alert.informativeText = "macOS opened MineVibe from a temporary, read-only copy. Drag MineVibe into "
            + "Applications in Finder, then open it from there."
    }
    alert.addButton(withTitle: "Quit")
    if case .protected = verdict, alert.runModal() == .alertFirstButtonReturn {
        moveToApplications(bundleURL)
    } else if case .translocated = verdict {
        alert.runModal()
    }
    exit(1)
}

func moveToApplications(_ bundleURL: URL) {
    let dest = URL(fileURLWithPath: "/Applications").appendingPathComponent(bundleURL.lastPathComponent)
    do {
        if FileManager.default.fileExists(atPath: dest.path) {
            NSWorkspace.shared.activateFileViewerSelecting([dest, bundleURL])  // never overwrite silently
            return
        }
        try FileManager.default.moveItem(at: bundleURL, to: dest)
        StubLog.write("moved to \(dest.path); relaunching")
        let done = DispatchSemaphore(value: 0)
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: dest, configuration: config) { _, _ in done.signal() }
        _ = done.wait(timeout: .now() + 10)
    } catch {
        let alert = NSAlert()
        alert.messageText = "MineVibe couldn’t move itself"
        alert.informativeText = "\(error.localizedDescription)\n\nDrag MineVibe into Applications in Finder."
        alert.runModal()
        NSWorkspace.shared.activateFileViewerSelecting([bundleURL])
    }
}

// MARK: - Node child and its NDJSON channel

final class NodeLink {
    let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let writeQueue = DispatchQueue(label: "dev.minevibe.stub.node-write")
    private var buffer = Data()
    private var exitStatus: (Int32, Process.TerminationReason)?
    private var sawEOF = false
    private var finished = false
    var onMessage: (([String: Any]) -> Void)?
    var onExit: ((Int32, Process.TerminationReason) -> Void)?

    var pid: Int32 { process.processIdentifier }
    var isRunning: Bool { process.isRunning }

    /// `Contents/MacOS/node Contents/Resources/server/dist/main.mjs app [--selftest]`.
    init(bundle: URL, selftest: Bool, stderr: FileHandle?) throws {
        let node = bundle.appendingPathComponent("Contents/MacOS/node")
        let main = bundle.appendingPathComponent("Contents/Resources/server/dist/main.mjs")
        for url in [node, main] where !FileManager.default.fileExists(atPath: url.path) {
            throw NSError(domain: "MineVibe", code: 1, userInfo: [NSLocalizedDescriptionKey: "missing \(url.path)"])
        }
        var childEnv = env
        for key in ["NODE_OPTIONS", "NODE_PATH"] { childEnv.removeValue(forKey: key) }  // nothing injects into our Node
        childEnv["MINEVIBE_APP_BUNDLE"] = bundle.path
        childEnv["MINEVIBE_STUB_PID"] = String(getpid())
        process.executableURL = node
        process.arguments = ["--enable-source-maps", main.path, "app"] + (selftest ? ["--selftest"] : [])
        process.environment = childEnv
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        process.standardInput = input
        process.standardOutput = output
        process.standardError = stderr ?? FileHandle.standardError
    }

    /// Starts Node; callbacks run on `queue`. `onExit` fires once Node has exited and its stdout is drained.
    func start(queue: DispatchQueue) throws {
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            queue.async { self?.consume(data, queue: queue) }
        }
        process.terminationHandler = { [weak self] p in
            let status = (p.terminationStatus, p.terminationReason)
            queue.async {
                guard let self else { return }
                self.exitStatus = status
                // Normally stdout's EOF follows at once; do not wait forever for it.
                queue.asyncAfter(deadline: .now() + 2) { self.sawEOF = true; self.finishIfDone() }
                self.finishIfDone()
            }
        }
        try process.run()
    }

    func send(_ message: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
        data.append(0x0A)
        writeQueue.async { [input] in
            do { try input.fileHandleForWriting.write(contentsOf: data) } catch { /* Node is gone: EPIPE */ }
        }
    }

    private func consume(_ data: Data, queue: DispatchQueue) {
        if data.isEmpty {
            output.fileHandleForReading.readabilityHandler = nil
            sawEOF = true
            finishIfDone()
            return
        }
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<newline)
            buffer.removeSubrange(buffer.startIndex...newline)
            if line.isEmpty { continue }
            if let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any], object["t"] is String {
                onMessage?(object)
            } else {
                StubLog.write("node stdout (not NDJSON): \(String(decoding: line.prefix(300), as: UTF8.self))")
            }
        }
        if buffer.count > 4 << 20 { buffer.removeAll() }  // a runaway line is dropped, not buffered forever
    }

    private func finishIfDone() {
        guard !finished, sawEOF, let (status, reason) = exitStatus else { return }
        finished = true
        onExit?(status, reason)
    }
}

// MARK: - First-run progress window (shown only when Node reports installation work)

final class ProgressWindow: NSObject {
    private let window: NSWindow
    private let titleField = NSTextField(labelWithString: "Setting up MineVibe")
    private let detailField = NSTextField(labelWithString: " ")
    private let bar = NSProgressIndicator()
    private let onQuit: () -> Void

    init(onQuit: @escaping () -> Void) {
        self.onQuit = onQuit
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 130), styleMask: [.titled],
                          backing: .buffered, defer: false)
        super.init()
        window.title = "MineVibe"
        window.isReleasedWhenClosed = false
        titleField.font = .boldSystemFont(ofSize: 13)
        detailField.font = .systemFont(ofSize: 11)
        detailField.textColor = .secondaryLabelColor
        detailField.lineBreakMode = .byTruncatingMiddle
        bar.style = .bar
        bar.isIndeterminate = true
        bar.minValue = 0
        bar.maxValue = 1
        bar.startAnimation(nil)
        let quit = NSButton(title: "Quit", target: self, action: #selector(quitPressed))
        quit.bezelStyle = .push
        let bottom = NSStackView(views: [detailField, quit])
        bottom.orientation = .horizontal
        detailField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let stack = NSStackView(views: [titleField, bar, bottom])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 16, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            content.widthAnchor.constraint(equalToConstant: 440),  // the text changes; the window does not
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            bar.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40),
            bottom.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40),
        ])
        window.contentView = content
        window.center()
    }

    @objc private func quitPressed() { onQuit() }

    func update(title: String?, detail: String?, fraction: Double?) {
        if let title { titleField.stringValue = title }
        if let detail { detailField.stringValue = detail }
        if let fraction, fraction >= 0, fraction <= 1 {
            bar.isIndeterminate = false
            bar.doubleValue = fraction
        } else if !bar.isIndeterminate {
            bar.isIndeterminate = true
            bar.startAnimation(nil)
        }
    }

    func show() {
        if window.isVisible { return }
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }

    func hide() { window.orderOut(nil) }
}

// MARK: - The app

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var link: NodeLink?
    private var progress: ProgressWindow?
    private var shuttingDown = false
    private var terminateReplyPending = false
    private var killTimer: DispatchSourceTimer?
    private var signalSources: [DispatchSourceSignal] = []
    private var lastError: (message: String, detail: String?)?
    private var pickerOpen = false
    private var sawHello = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let bundle = Bundle.main.bundleURL
        StubLog.write("MineVibe \(stubVersion) starting from \(bundle.path)")
        let verdict = locationVerdict(bundle.path)
        if verdict != .ok { refuseLocation(verdict, bundleURL: bundle) }
        ProcessInfo.processInfo.disableAutomaticTermination("MineVibe is running")
        ProcessInfo.processInfo.disableSuddenTermination()
        do {
            let link = try NodeLink(bundle: bundle, selftest: false, stderr: StubLog.handle)
            link.onMessage = { [weak self] in self?.handle($0) }
            link.onExit = { [weak self] in self?.nodeExited(status: $0, reason: $1) }
            try link.start(queue: .main)
            self.link = link
            StubLog.write("node started (pid \(link.pid))")
        } catch {
            fail("MineVibe could not start", detail: error.localizedDescription, code: 1)
        }
        // After the spawn: signal dispositions set here must not be inherited by Node.
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            let name = sig == SIGTERM ? "sigterm" : sig == SIGINT ? "sigint" : "sighup"
            source.setEventHandler { [weak self] in self?.beginShutdown(name) }
            source.resume()
            signalSources.append(source)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + handshakeTimeout) { [weak self] in
            guard let self, !self.sawHello, !self.shuttingDown else { return }
            StubLog.write("no hello from node within \(handshakeTimeout) s")
            self.lastError = ("MineVibe’s server did not start", "No answer within \(Int(handshakeTimeout)) seconds.")
            self.beginShutdown("handshake-timeout")
        }
    }

    /// Quit Apple Event (logout, restart, `osascript … quit`): Node shuts down first, then the reply.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let link, link.isRunning else { return .terminateNow }
        terminateReplyPending = true
        beginShutdown("quit")
        return .terminateLater
    }

    private func beginShutdown(_ reason: String) {
        guard let link, link.isRunning else { exit(0) }
        if shuttingDown { return }
        shuttingDown = true
        StubLog.write("shutdown (\(reason)); SIGKILL in \(Int(shutdownGrace)) s if node is still running")
        progress?.update(title: "Quitting MineVibe…", detail: "Saving the world", fraction: nil)
        link.send(["cmd": "shutdown", "reason": reason])
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + shutdownGrace)
        timer.setEventHandler {
            StubLog.write("node (pid \(link.pid)) ignored shutdown for \(Int(shutdownGrace)) s: SIGKILL")
            kill(link.pid, SIGKILL)
        }
        timer.resume()
        killTimer = timer
    }

    private func handle(_ message: [String: Any]) {
        switch message["t"] as? String {
        case "hello":
            sawHello = true
            link?.send(["cmd": "hello", "v": 1, "stub": stubVersion, "pid": Int(getpid())])
        case "progress":
            let work = message["work"] as? Bool ?? false
            if progress == nil && !work { return }
            if progress == nil {
                progress = ProgressWindow(onQuit: { [weak self] in self?.beginShutdown("cancel") })
            }
            if shuttingDown { return }
            progress?.update(title: message["title"] as? String, detail: message["detail"] as? String,
                             fraction: message["fraction"] as? Double)
            progress?.show()
            if message["phase"] as? String == "launched" {
                // Normally `ready` hides it; never leave it up if the game does not connect.
                DispatchQueue.main.asyncAfter(deadline: .now() + 90) { [weak self] in self?.progress?.hide() }
            }
        case "ready":
            progress?.hide()
        case "pickFolder":
            pickFolder(message)
        case "error":
            lastError = (message["message"] as? String ?? "MineVibe stopped", message["detail"] as? String)
            StubLog.write("node error: \(lastError!.message) \(lastError!.detail ?? "")")
        default:
            break
        }
    }

    /// Native folder picker for a Vault folder; the answer goes back over stdin.
    private func pickFolder(_ message: [String: Any]) {
        guard let id = message["id"] as? String else { return }
        if pickerOpen {
            link?.send(["cmd": "pickFolder.result", "id": id, "path": NSNull(), "error": "busy"])
            return
        }
        pickerOpen = true
        let previous = NSWorkspace.shared.frontmostApplication
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.title = message["title"] as? String ?? "Choose a folder"
        panel.message = message["message"] as? String ?? ""
        panel.prompt = message["prompt"] as? String ?? "Choose"
        if let start = message["startIn"] as? String, start.hasPrefix("/") {
            panel.directoryURL = URL(fileURLWithPath: start)
        }
        NSApp.activate()
        panel.begin { [weak self] response in
            let path: Any = response == .OK ? (panel.url?.path ?? NSNull()) : NSNull()
            self?.link?.send(["cmd": "pickFolder.result", "id": id, "path": path])
            self?.pickerOpen = false
            if previous?.processIdentifier != getpid() { previous?.activate() }  // back to the game
        }
    }

    private func nodeExited(status: Int32, reason: Process.TerminationReason) {
        killTimer?.cancel()
        let how = reason == .uncaughtSignal ? "signal \(status)" : "code \(status)"
        StubLog.write("node exited (\(how))")
        progress?.hide()
        if terminateReplyPending {
            NSApp.reply(toApplicationShouldTerminate: true)
            return
        }
        if shuttingDown && lastError == nil { exit(0) }
        if reason == .exit && (status == 0 || status == 130) && lastError == nil { exit(0) }  // 130: stopped on request
        let error = lastError ?? ("MineVibe stopped unexpectedly", "The server exited with \(how).")
        fail(error.message, detail: error.detail, code: status == 0 ? 1 : status)
    }

    private func fail(_ message: String, detail: String?, code: Int32) -> Never {
        StubLog.write("fatal: \(message) \(detail ?? "")")
        NSApp.activate()
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = message
        alert.informativeText = (detail.map { "\($0)\n\n" } ?? "") + "Logs: \(StubLog.url.deletingLastPathComponent().path)"
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Show Logs")
        if alert.runModal() == .alertSecondButtonReturn {
            NSWorkspace.shared.activateFileViewerSelecting([StubLog.url])
        }
        exit(code)
    }
}

// MARK: - Self-test (CI): stub <-> Node handshake, no game

enum SelfTest {
    static func say(_ line: String) {
        print("[selftest] \(line)")
        fflush(stdout)
    }

    static func run() -> Int32 {
        let bundle = Bundle.main.bundleURL
        let started = Date()
        say("MineVibe stub \(stubVersion) at \(bundle.path)")
        let verdict = locationVerdict(bundle.path)
        say(verdict == .ok ? "location ok"
            : "location \(verdict.code) (a normal launch asks to move the app; the self-test goes on)")
        let queue = DispatchQueue(label: "dev.minevibe.stub.selftest")
        let hello = DispatchSemaphore(value: 0)
        let exited = DispatchSemaphore(value: 0)
        var helloMs = -1
        var result: [String: Any]?
        var exitStatus: (Int32, Process.TerminationReason)?
        let link: NodeLink
        do {
            link = try NodeLink(bundle: bundle, selftest: true, stderr: FileHandle.standardError)
            link.onMessage = { message in
                switch message["t"] as? String {
                case "hello":
                    helloMs = Int(Date().timeIntervalSince(started) * 1000)
                    let version = message["v"] as? Int ?? -1
                    say("hello from node \(message["node"] ?? "?") (server \(message["server"] ?? "?"), protocol v\(version))")
                    link.send(["cmd": "hello", "v": 1, "stub": stubVersion, "pid": Int(getpid())])
                    hello.signal()
                case "selftest":
                    result = message
                    link.send(["cmd": "shutdown", "reason": "selftest"])
                default:
                    break
                }
            }
            link.onExit = { status, reason in
                exitStatus = (status, reason)
                exited.signal()
            }
            try link.start(queue: queue)
        } catch {
            say("FAIL: cannot start node: \(error.localizedDescription)")
            return 1
        }
        if hello.wait(timeout: .now() + handshakeTimeout) == .timedOut {
            kill(link.pid, SIGKILL)
            say("FAIL: no hello from node within \(Int(handshakeTimeout)) s")
            return 1
        }
        if exited.wait(timeout: .now() + 120) == .timedOut {
            kill(link.pid, SIGKILL)
            say("FAIL: node did not exit after shutdown")
            return 1
        }
        return queue.sync {
            var ok = true
            for check in result?["checks"] as? [[String: Any]] ?? [] {
                let passed = check["ok"] as? Bool ?? false
                ok = ok && passed
                say("\(passed ? "ok  " : "FAIL") \(check["name"] ?? "?"): \(check["detail"] ?? "")")
            }
            if result == nil { say("FAIL: node sent no selftest result"); ok = false }
            if let (status, reason) = exitStatus, status != 0 || reason != .exit {
                say("FAIL: node exited with \(reason == .exit ? "code" : "signal") \(status)")
                ok = false
            }
            let total = Int(Date().timeIntervalSince(started) * 1000)
            say(ok ? "OK (hello after \(helloMs) ms, \(total) ms in total)" : "FAILED")
            return ok ? 0 : 1
        }
    }
}

// MARK: - Entry point

@main
enum MineVibeMain {
    static func main() {
        signal(SIGPIPE, SIG_IGN)  // a write to a dead Node must fail with EPIPE, not kill the stub
        let args = Array(CommandLine.arguments.dropFirst())
        switch args.first ?? "" {
        case "--selftest":
            exit(SelfTest.run())
        case "--check-location" where args.count >= 2:
            let verdict = locationVerdict(args[1])
            print(verdict.code)
            exit(verdict == .ok ? 0 : 3)
        case "--version":
            print(stubVersion)
            exit(0)
        default:
            let app = NSApplication.shared
            let delegate = AppDelegate()
            app.delegate = delegate
            app.setActivationPolicy(.accessory)
            withExtendedLifetime(delegate) { app.run() }
        }
    }
}
