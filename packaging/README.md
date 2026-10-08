# Packaging: MineVibe.app

`npm run build:app` assembles `dist/MineVibe.app` (gitignored) on an Apple Silicon Mac running macOS 26 or later.
The bundle holds the Swift stub, the official Node 24, a Temurin 25 JRE, Apple `container` 1.5.0, the server and
the mod (PLAN §9). Minecraft, Fabric and the performance mods are not in it: they download on first run.

## Build

```sh
npm install
npm run build:app                      # about 10 s once the vendor archives are cached
dist/MineVibe.app/Contents/MacOS/MineVibe --selftest
```

You need Xcode or the Command Line Tools (for `xcrun swiftc`). Gradle builds the mod jar with JDK 25, which it
provisions itself.

| Option | Default | What it does |
|---|---|---|
| `--out <dir>` | `dist` | Where `MineVibe.app` goes (scratch work lives in `<dir>/.build-app`). |
| `--identity auto\|adhoc\|<name or SHA-1>` | `auto` (`MINEVIBE_SIGN_IDENTITY`) | How the stub is signed (see Signing). |
| `--mod-jar <path>` | (`MINEVIBE_MOD_JAR`) | Use this `minevibe-<version>.jar` and skip Gradle. |
| `--skip-mod-build` | off | Take the newest jar in `apps/mod/build/libs` without running `./gradlew jar`. |
| `--skip-server-build` | off | Use `apps/server/dist` as it is. |
| `--cache <dir>` | `~/Library/Caches/MineVibe-dev/vendor` (`MINEVIBE_VENDOR_CACHE`) | Vendor download cache. |

The independent steps run in parallel: the three vendor downloads and extractions, the server bundle, the list of
the server's production packages, `./gradlew jar`, and `swiftc`. The bundle is then assembled, checked, signed and
verified, and only then moved to `dist/MineVibe.app`, so a failed build never leaves a half-built app there.

## What goes where

| Path in `Contents/` | Contents |
|---|---|
| `MacOS/MineVibe` | The Swift stub, `apps/launcher-mac/MineVibe.swift`, built with `xcrun swiftc -O -parse-as-library -target arm64-apple-macos26.0`. The only thing we sign. |
| `MacOS/node` | Official Node `bin/node` from `vendor.lock.json`, byte-identical (Node.js Foundation's signature, team HX7739G8FX). |
| `Runtime/jre/` | Temurin JRE `Contents/Home`, byte-identical (Eclipse Adoptium's signatures, team JCDTMS22B4). `bin/MineVibe` is a byte-identical copy of `bin/java`, so the Dock shows "MineVibe". |
| `Runtime/container/` | Apple `container` 1.5.0 install root (`bin/container`, `bin/container-apiserver`, `libexec/container/plugins/*`), the pkg payload byte for byte (Apple's signatures, team UPBK2H6LZM). Pass it as `--install-root` / `CONTAINER_INSTALL_ROOT`. |
| `Resources/server/` | `dist/main.mjs` (+ source map and legal notices), a `package.json`, and the server's production `node_modules` copied byte for byte from the installed workspace (`npm ls --omit=dev`). |
| `Resources/mod/` | `minevibe-<version>.jar`, `mods.lock.json`, `seed-configs/*.json` (this folder is `MINEVIBE_RESOURCES` for the launcher). |
| `Resources/MineVibe.icns` | Placeholder icon, generated (`lib/icon.ts`). |
| `Resources/build-info.json` | Version, build number, commit, vendor versions. |
| `Resources/legal/` | LICENSE, NOTICE, THIRD_PARTY_NOTICES.md. |

`apps/server/src/app/appLayout.ts` (`BUNDLE_LAYOUT`) is the single source of these paths for both the build and the
running server.

**Deviation from PLAN §9.1: `container` lives in `Runtime/`, not `Helpers/`.** codesign treats every file under
`Contents/Helpers` as code that must carry a signature. The `container` install root also holds Apple's unsigned
data files (`config.toml`, `k8s/resources/kindnet.yaml`, the `machine-apiserver` shell scripts), so signing the
bundle fails with "code object is not signed at all" unless we re-sign Apple's files, which would break the
byte-identical rule. Under `Runtime/` they are sealed as resources, Apple's Mach-O signatures stay untouched, and
`codesign --verify --deep --strict` passes. The TCC rule (§8.6) is about the folder the app sits in, not the
subfolder, so `/Applications/MineVibe.app/Contents/Runtime/container` is fine.

## Verification during the build

- Each vendor archive must match the `size` and `sha256` pinned in `vendor.lock.json`; a mismatch deletes the
  download and fails. Archives are cached content-addressed (`<cache>/<sha256>/<file>`) and re-hashed on use.
- The `container` pkg must pass `pkgutil --check-signature` as "signed by a developer certificate issued by Apple for
  distribution", with the first certificate equal to the lock's `pkgSigner`.
- The copies in the bundle are compared file by file (bytes, modes, symlinks) against the extracted originals.
- Every Mach-O in `MacOS/node`, `Runtime/jre` and `Runtime/container` must pass `codesign --verify --strict` and be
  signed by the lock's `teamId`.
- `node --version` and `java -version` must report the pinned versions.
- `plutil -lint` on the Info.plist (`apps/launcher-mac/Info.plist`: `LSUIElement`, `LSMinimumSystemVersion` 26.0,
  `NSLocalNetworkUsageDescription`).
- After signing, `codesign --verify --deep --strict --verbose=2` on the whole bundle.

## Signing

Only the stub is signed by us: `codesign --force --sign <identity> --options runtime` on the bundle signs its main
executable and seals everything else (no `--deep`, so vendor signatures are never replaced).

- `auto`: the first "Apple Development" identity from `security find-identity -v -p codesigning`, else ad hoc. A
  stable identity keeps TCC and Local Network grants across rebuilds (PLAN §9.1). The first use may show a keychain
  prompt; if nobody answers within 120 s, or signing fails, the build falls back to ad hoc and says so.
- `adhoc` (CI): `codesign --sign -`.
- Developer ID signing and notarization for releases are not here yet (`release.yml`, M11).

## Running a build

The stub refuses to run from `~/Documents`, `~/Desktop`, `~/Downloads`, iCloud Drive, cloud-storage folders and
external volumes, and from App Translocation: it shows a dialog that offers to move the app to `/Applications`
(PLAN §8.6: `container`'s vmnet fails inside TCC-protected folders). The repository usually lives in `~/Documents`,
so try a build from a copy:

```sh
T=~/Library/Caches/MineVibe-dev/app-test
mkdir -p "$T" && rm -rf "$T/MineVibe.app" && ditto dist/MineVibe.app "$T/MineVibe.app"
open -n --env MINEVIBE_HOME="$T/home" "$T/MineVibe.app"     # MINEVIBE_HOME keeps the data out of your real App Support
```

`--selftest` skips the location check (it reports it) and starts no game, so it runs from `dist/` too.

Logs: `~/Library/Logs/MineVibe/` (or `$MINEVIBE_HOME/Logs/`): `launcher.log` (the stub, plus Node's stderr),
`server.log` (Node), `minecraft-console.log` (the JVM).

## Stub ⇄ Node

The stub starts `Contents/MacOS/node --enable-source-maps Contents/Resources/server/dist/main.mjs app` with
`NODE_OPTIONS`/`NODE_PATH` removed and `MINEVIBE_APP_BUNDLE` set. They speak NDJSON: Node writes to stdout (any other
stdout write in Node is redirected to stderr), the stub writes to Node's stdin.

| Direction | Message | Meaning |
|---|---|---|
| Node → stub | `{"t":"hello","v":1,"mode","server","node","pid"}` | First line. The stub answers with its own hello. |
| Node → stub | `{"t":"progress","phase","work","title","detail?","fraction?","bytes"}` | Launch milestones. The stub opens its small window only once `work` is true (something is being downloaded); a normal launch shows no window. |
| Node → stub | `{"t":"ready"}` | The game connected to the bridge: the window closes. |
| Node → stub | `{"t":"pickFolder","id","title?","message?","prompt?","startIn?"}` | Show the native folder picker. |
| Node → stub | `{"t":"error","message","detail?"}` | Shown in a dialog if Node then exits with an error. |
| Node → stub | `{"t":"selftest","ok","checks":[…]}` / `{"t":"exit","code"}` | Self-test result / Node is about to exit. |
| stub → Node | `{"cmd":"hello","v":1,"stub","pid"}` | Handshake. |
| stub → Node | `{"cmd":"shutdown","reason"}` | Quit Apple Event (logout, restart), SIGTERM/SIGINT/SIGHUP, the window's Quit button. |
| stub → Node | `{"cmd":"pickFolder.result","id","path"\|null}` | The picked folder (absolute) or null. |

The schemas are in `apps/server/src/app/stubProtocol.ts`; Node's side is `apps/server/src/app/runApp.ts`
(`minevibe-server app [--selftest]`). Nothing in the server calls `pickFolder` yet: `StubChannel` implements
`HostDialogs.pickFolder()` for the PC manager's `host.pickFolder` once the protocol has it.

**Lifelines and quitting (PLAN §9.2).**

- Node's stdin is the stub's lifeline: if the stub dies (even `kill -9`), Node reads EOF and stops the game and itself.
- `shutdown` makes Node ask the JVM to quit (SIGTERM, which saves the world; SIGKILL after 30 s), then exit.
- The stub sends SIGKILL to Node 60 s after `shutdown` if it is still running.
- When the game closes, Node exits, and so does the stub.

## Updating a vendor pin

1. Pick the new archive and its published sha256 (Node: `SHASUMS256.txt`; Temurin: the Adoptium API or the
   release's `.sha256.txt`; `container`: the GitHub release asset digest).
2. Update `url`, `size`, `sha256`, `version` and `extract` in `vendor.lock.json` (and `javaVersion` for the JRE).
3. Run `npm run build:app`: it re-checks signatures and team IDs, so a vendor that changed its signing team fails
   loudly. Update `teamId` only after checking why.
4. Run the self-test and a real launch from a non-TCC copy.

## Tests

`npm test -w @minevibe/packaging`: the vendor lock schema, Info.plist, icon, signing, download and copy helpers,
and the Swift stub itself (compiled once, then driven against a fake Node: `--selftest` pass and fail, the
handshake timeout, `--check-location`, SIGTERM and the quit Apple Event leading to `shutdown`, the SIGKILL after
the grace period, the stdin lifeline and a game that closes by itself). The stub tests need macOS and `swiftc` and
are skipped elsewhere. CI runs the build, the self-test and these tests on `macos-26` (`.github/workflows/ci.yml`,
job `app`).
