# Third-party notices

MineVibe itself is licensed under the MIT License (see [LICENSE](LICENSE)). This file lists the third-party
software that MineVibe bundles, vendors, downloads at runtime, or builds on, together with its license and how
MineVibe uses it. Source code adapted into this repository is also credited in [NOTICE](NOTICE).

MineVibe is pre-alpha. Entries marked _planned_ describe the design in
[docs/design/PLAN.md](docs/design/PLAN.md) and will be confirmed (exact versions, license texts) before the
first binary release. Release builds will ship this file, and the full license texts of every bundled
component, inside `MineVibe.app`.

## 1. Bundled in MineVibe.app (_planned_)

Vendor binaries are pinned with sha256 in `packaging/vendor.lock.json` and copied **byte-identical**, so their
original signatures stay valid. They are never committed to this repository.

| Component | Version | License | Use | Source |
| --- | --- | --- | --- | --- |
| Node.js (official darwin-arm64 binary) | 24.x | MIT (Node's `LICENSE` also lists the licenses of its bundled dependencies) | Runs the MineVibe orchestrator | https://nodejs.org |
| Eclipse Temurin JRE | 25 | GPLv2 with the Classpath Exception | Runs Minecraft | https://adoptium.net |
| Apple `container` | 1.5.0 | Apache-2.0 | Runs Linux PCs, one lightweight VM each | https://github.com/apple/container |
| Lume (`lume.app`, notarized, never re-signed) | 0.6.x | MIT | Runs macOS PCs | https://github.com/trycua/cua |

## 2. npm packages in the orchestrator

These are installed from npm by `npm install` and, in release builds, copied into the app's
`Resources/server/node_modules`. The table lists the key packages named in the plan; the authoritative list
is `package-lock.json`, and a complete, generated license report for each release is _planned_.

| Package | License | Notes |
| --- | --- | --- |
| `@trycua/cua` | MIT | Client for each PC's `cua-spacesd` daemon |
| `@anthropic-ai/claude-agent-sdk` | Proprietary, © Anthropic PBC; use subject to Anthropic's legal agreements (https://code.claude.com/docs/en/legal-and-compliance) | Drives each agent's `claude` process. Not covered by MineVibe's MIT license. The SDK's bundled Claude Code binary is removed from release builds and never redistributed. |
| `@xmcl/*` | MIT | Installs Minecraft and Fabric from Mojang's and Fabric's servers |
| `zod` | MIT | Protocol schemas |
| `minisearch` | MIT | Codex full-text search |

## 3. Source code vendored into this repository

| Project | License | Where | What |
| --- | --- | --- | --- |
| [fabric-carpet](https://github.com/gnembon/fabric-carpet) | MIT, © gnembon and contributors | `apps/mod/src/main/java/dev/minevibe/agent/` | Fake-player connection and action-pack patterns for agent bodies |

## 4. Downloaded on the user's Mac at runtime, never redistributed

### Minecraft

Minecraft: Java Edition 26.3 (client, libraries and assets) is downloaded from Mojang's servers on first run
and verified against Mojang's sha1 hashes. It is © Mojang AB / Microsoft and subject to the
[Minecraft EULA](https://aka.ms/MinecraftEULA). MineVibe **never redistributes** any Minecraft files, and
users must own the game.

### Fabric

| Component | License | Source |
| --- | --- | --- |
| Fabric Loader 0.19.5 | Apache-2.0 | Fabric's meta and maven servers |
| Fabric API 0.162.0+26.3 | Apache-2.0 | Modrinth |

### Mods (from Modrinth)

Mods are listed in `packaging/mods.lock.json`, fetched from Modrinth's CDN with their `primary` file only,
and verified by size and sha512. MineVibe **never rehosts** mod jars, and each mod remains under its own
license:

| Mod | License | Notes |
| --- | --- | --- |
| Sodium | Polyform Shield 1.0.0 (source-available) | Forbids rehosting: always downloaded from Modrinth |
| Entity Culling | Custom license by tr7zw | Forbids rehosting: always downloaded from Modrinth |
| Lithium | LGPL-3.0-only | |
| FerriteCore | MIT | |
| ImmediatelyFast | LGPL-3.0-or-later | |
| More Culling | GPL-3.0-only | |
| Cloth Config API | LGPL-3.0-only | |
| Dynamic FPS | MIT | |
| BadOptimizations | MIT | |
| Sodium Extra | LGPL-3.0-only | |

Opt-in mods (Iris, C2ME, ScalableLux, Chunky) and development-only mods (spark, Mod Menu) are handled the same
way and are only downloaded when enabled.

### PC images

| Image | Contents and licenses | How MineVibe gets it |
| --- | --- | --- |
| `ghcr.io/trycua/linux:24.04` (and `24.04-slim`) | cua's Linux desktop image: Ubuntu 24.04 packages under their own licenses, plus cua software including **`cua-spacesd`, licensed FSL-1.1-MIT** | Used as the pinned base of MineVibe's Linux PC image |
| `ghcr.io/jasperaelvoet/minevibe-linux-pc` (_planned_) | The cua base above plus Ubuntu's `tmux`, `ripgrep`, `git` and `build-essential` packages, each under its own license (sources available from Ubuntu) | Built by CI from `images/linux-pc/` and pulled by the app; can also be built locally |
| `ghcr.io/trycua/macos:26` | macOS (subject to Apple's macOS license) plus cua software including **`cua-spacesd` (FSL-1.1-MIT)** | Pulled by Lume on the user's Mac, after a consent screen |

FSL-1.1-MIT permits use and redistribution for any purpose other than a competing commercial product, and
each release converts to MIT two years after it is published.

### The Android phone and nested virtualization (opt-in, per PC)

Fetched only after the player turns on a Linux PC's Android phone or KVM and accepts the download prompt.

| Component | License | How MineVibe gets it |
| --- | --- | --- |
| Linux kernel 6.18.35 source | GPL-2.0 (with the syscall note) | Downloaded from cdn.kernel.org (sha256-pinned) and built on the user's Mac into MineVibe's Android kernel; neither the source nor the kernel is redistributed |
| Redroid 15 image (`redroid/redroid`, pinned by digest) | AOSP: Apache-2.0 and the licenses of its other components; Redroid: Apache-2.0 | Pulled from Docker Hub, patched locally (one layer that makes `/etc` a relative link) and loaded as `minevibe/android-phone` |
| scrcpy 3.3.4 | Apache-2.0 | Source and server release from GitHub (sha256-pinned), built inside the PC by the `android` helper |
| adb and the build tools of the kernel and scrcpy | Ubuntu packages, each under its own license | Installed with apt inside the PC or the kernel build container |

## 5. Claude Code

MineVibe **never redistributes Claude Code**. Each user installs and logs into their own `claude` CLI, and
MineVibe starts that binary. Claude Code is © Anthropic PBC and subject to Anthropic's terms.

## 6. Build and documentation tooling (not shipped in the app)

| Tool | License |
| --- | --- |
| Gradle (wrapper 9.7.1) | Apache-2.0 |
| Fabric Loom 1.18.3 | MIT |
| Astro | MIT |
| Starlight (`@astrojs/starlight`) | MIT |
| starlight-links-validator | MIT |
| Biome | MIT OR Apache-2.0 |
| TypeScript | Apache-2.0 |
| vitest | MIT |
| esbuild | MIT |

## 7. Acknowledgements (ideas, no code copied)

- The [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) project (MIT), whose
  movement-cost ideas inform MineVibe's digging path planner.
- [T3 Code](https://github.com/pingdotgg/t3code), for the model of running agents on the user's own `claude`
  installation.
- [CC: Tweaked](https://github.com/cc-tweaked/CC-Tweaked), for the render-bounding-box pattern used by the
  in-game monitors.

## Trademarks

Minecraft is a trademark of Mojang Synergies AB. Claude and Claude Code are trademarks of Anthropic PBC.
Apple, Mac and macOS are trademarks of Apple Inc. MineVibe is not an official Minecraft product and is not
approved by or associated with Mojang, Microsoft, Anthropic or Apple.
