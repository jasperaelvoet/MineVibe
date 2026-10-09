# Spike: Android apps on a MineVibe Linux PC

> Copied from the spike's scratch folder (`~/Library/Application Support/MineVibe-dev/spike-android/`). The scripts,
> kernel fragments, logs and screenshots it names stayed there (large, or tied to that machine). What shipped from it
> is PLAN §8.7: `apps/server/src/pcs/android/` (kernel build, image patch), `images/linux-pc/android` (the helper in the
> PC) and `apps/server/test/pcs/integration/android.int.ts` (the same checks on the real runtime).

Run on 2026-10-09 on the dev roots (`~/Library/Application Support/MineVibe-dev/container{,-root}`), with spike containers labelled `minevibe-spike=android`. The engine was never stopped and no `mv-pc-*` container or network was touched.

**Verdict: it works.** An Android 15 arm64 device boots in **6–7 s** next to a Linux PC. An APK installs over `adb` in ~0.2 s and its window shows on the PC's XFCE desktop through scrcpy, where it is playable with the mouse. The test game ran at **~60 fps** after the display was set to 60 Hz (15 fps at Redroid's default 30 Hz).

The route that works is **Redroid**: AOSP running as a container with a MineVibe kernel that has binder enabled. Apple `container` lets each container boot its own kernel (`--kernel`), so Ada's claim that it is "impossible on its kernel" only holds for the *stock* kernel. Redroid needs no nested virtualization, so it should also work on M1/M2 Macs; only the M5 Pro was tested.

Nested virtualization also works: `--virtualization` plus a KVM kernel gives `/dev/kvm` in the PC, and `kvm-ok` passes. But a full Android VM (Cuttlefish) on nested KVM is too slow to ship. There is no Google Android Emulator build for linux-aarch64 hosts. A macOS PC cannot run the Android Studio emulator either, because Apple's Virtualization framework offers no nested virtualization for macOS guests.

## Environment

- macOS 27.0.1 (26A434), Apple M5 Pro (18 cores, 48 GiB), Apple `container` 1.5.0 (d265d66).
- Stock kernel: Kata `vmlinux-6.18.35-197-debug`, via `config.toml [kernel]`. Its config was read from the image's IKCONFIG; see `out/default-kernel.config`.
- PC image: `minevibe/linux-pc:dev` (Ubuntu 24.04 arm64, XFCE on Xvfb `:1`, user `cua`).
- Sample APK: Shattered Pixel Dungeon 4.0.1, an open-source game from F-Droid (`com.shatteredpixel.shatteredpixeldungeon_920.apk`, sha256 `33e0ffae…`, 30 MB, native libs for arm64-v8a, armeabi-v7a, x86 and x86_64).

## What Ada got right and wrong (the live-play report)

| Ada's claim | Fact |
|---|---|
| "No Android emulator for linux-arm64" | **True** for Google's SDK emulator; see §2a. |
| "Redroid/Waydroid impossible on its kernel" | **True only for the stock kernel**, which lacks binder. `container run --kernel <path>` boots any kernel per container, and with a binder kernel Redroid boots in 6 s (§2c). |
| "No KVM" | **True by default.** `--virtualization` together with a KVM-enabled kernel gives a working `/dev/kvm` on this M5 Pro (§1). |
| Probing `192.168.75.x` for "your Mac or an Intel PC" | Pointless. Every PC gets its own isolated NAT network (PLAN M7) with nothing else on it, and the guest cannot reach host loopback (S5). There was nothing to find. |

The product gap: an agent inside a PC cannot pick a kernel, a container flag or a sidecar. Only the PC manager can. Ada therefore needs a ready-made "Android phone" plus a one-line instruction (§4).

## 1. Nested virtualization in Apple `container` 1.5.0

**Flag.** `container run|create --virtualization` ("Expose virtualization capabilities to the container (requires host and guest support)"). Upstream docs (`out/apple-container-runtime-configuration.md`) say: *"requires a M3 or newer Apple silicon machine and a Linux kernel that supports virtualization"*. Unsupported hosts fail with `unsupported: "nested virtualization is not supported on the platform"`. Apple's Virtualization docs show the same: `VZGenericPlatformConfiguration.isNestedVirtualizationSupported` exists since macOS 15 and is *"available for Mac with the M3 chip, and later"*.

**Experiments** (`out/virt-*.txt`):

| Run | Kernel | Result |
|---|---|---|
| no flag | stock | `CPU: All CPU(s) started at EL1`, no `/dev/kvm` |
| `--virtualization` | stock | `started at EL2`, but **no `/dev/kvm`**: the stock config has `# CONFIG_VIRTUALIZATION is not set` |
| `--virtualization --kernel vmlinux-6.18.35-mv-android*` | custom | `started at EL2`, `kvm [1]: nv: 568 coarse grained trap handlers`, `IPA Size Limit: 40 bits`, **`Hyp nVHE mode initialized successfully`**, `/dev/kvm` (10,232) present, `kvm-ok`: "KVM acceleration can be used" |

**Custom kernel.** Apple `container` takes a kernel per container with `-k/--kernel <path>`, and boot arguments with `--kernel-arg`. Do **not** use `container system kernel set`: it changes the default kernel for every container, including the user's PCs.

- Build: Kata 6.18.35 config (`kernel/kata-6.18.35-197.config`, identical to the stock kernel's) plus `kernel/android.fragment` and `kernel/android-v2.fragment`, on linux-6.18.35 (sha256 `f7860293…`, verified against kernel.org).
- The build runs in a throwaway container (`kernel/build-v2.sh`, 6 vCPU/6 GiB). It takes **185 s**; v1 took 132 s on 8 vCPU.
- Output: `kernel/vmlinux-6.18.35-mv-android2`, 26 MB, sha256 `7314dcdc…`.
- The fragments add `KVM` + `VIRTUALIZATION`, `ANDROID_BINDER_IPC` + `ANDROID_BINDERFS` (devices `binder,hwbinder,vndbinder`), `VHOST_NET/VSOCK`, `USERFAULTFD`, `SYNC_FILE/SW_SYNC`, `DMABUF_HEAPS_SYSTEM`, `UDMABUF`, `INPUT_UINPUT`, THP (`always`), **PSI enabled by default** (the stock kernel has `PSI_DEFAULT_DISABLED=y`), and `DEBUG_INFO_NONE`.
- Not needed: ashmem, which left mainline in 5.18; Android 12+ uses memfd, and `MEMFD_CREATE=y` is already in the stock config.

**Nested KVM performance** (`out/kvm-qemu-test.txt`; QEMU 8.2 in the PC, busybox initramfs guest, 300k-iteration shell loop):

| Where | Loop time |
|---|---|
| L1 (the PC itself) | 0.155–0.20 s |
| L2 under KVM | 0.21 s |
| L2 under TCG | 2.75 s |

CPU-bound guest code is therefore near native under nested KVM, and TCG is about 13× slower. Exit-heavy work (timers, IPIs, MMIO, first-touch memory) is very slow, though. L1 KVM can only run in **nVHE** mode on Apple's virtual EL2, so every L2 exit costs several L0 exits. Cuttlefish in §2b shows the effect.

## 2. Android routes

### 2a. Google Android Emulator (SDK): not available for linux-aarch64 hosts

- `https://dl.google.com/android/repository/repository2-3.xml`, fetched today (`out/repository2-3-now.xml`), lists `emulator` archives only for linux x64, macOS x64/aarch64 and windows x64. That covers stable 37.2.12 and canary 37.3.3. `platform-tools` for linux has no host-arch entry and is an x86-64 binary.
- `sdkmanager emulator` on an arm64 Linux PC therefore has nothing to install, which is Ada's dead end.
- Android CI does have an `emulator-linux_aarch64` target (branch `aosp-emu-master-dev`). `cvd fetch` resolved its last successful build to **12929531**, but the public build API returns an **empty artifact list** (`{}`) for it. There is nothing to download.
- Building the emulator from source for linux_aarch64 (`android/build/python/cmake.py --target linux_aarch64`) is possible in principle. It takes hours and tens of GB and supports only `-gpu swiftshader_indirect`, so it was not pursued. Even built, it would run on the same nested KVM as Cuttlefish (§2b).

### 2b. Cuttlefish inside the PC on nested KVM: works, far too slow to ship

Required PC settings: `--virtualization --kernel vmlinux-6.18.35-mv-android2 --cap-add ALL`, at least 6 vCPU and 10 GiB, and `/proc/sys` remounted read-write. The remount is needed because Apple containers mount `/proc/sys` read-only and Cuttlefish host-resources writes `ip_forward`. Setup is in `cf-root.sh` (as root) and `cf-user.sh` (as `cua`):

- `cuttlefish-base`/`cuttlefish-user` 1.57.0 arm64 from Google's apt repo `us-apt.pkg.dev/projects/android-cuttlefish-artifacts`: **16 s**.
- `cvd fetch --default_build=aosp-android-latest-release/aosp_cf_arm64_only_phone-userdebug` (build 16373615, 2.6 GB): **56–62 s**.
- `cvd create --host_path=~/cf --product_path=~/cf --gpu_mode=guest_swiftshader --cpus=4 --memory_mb=4096 --report_anonymous_usage_stats=n`.

Boot results:

| Attempt | Kernel | Result |
|---|---|---|
| Predecessor | v1 (no THP) | Did not finish in 10 min: the guest kernel was only ~290 s into boot, and logcat was empty. |
| This run | v2 | Did not finish in 10 min (`TimeoutThreadLoop: Did not receive boot completion event after 10m`, then `VIRTUAL_DEVICE_BOOT_FAILED`). It had only reached `surfaceflinger`. |
| This run, `--boot_timeout_secs=3600` | v2 | See below. |

The third attempt (`out/cf-boot-v2-long.log`, `out/cf-kernel-long.log`):

- `VIRTUAL_DEVICE_DISPLAY_POWER_MODE_CHANGED` at 358 s, and adb came up at `0.0.0.0:6520`.
- At 20 min, first-boot `dex2oat64` of the APEX apps was still running.
- At guest time ~1453 s, the Android **system_server watchdog fired**, so init killed and restarted zygote at ~1471 s.
- **Still no `sys.boot_completed` after 30 min.** The run was stopped there.

While booting, `crosvm` burned 400–470 % of L1 CPU while the guest reported itself ~95 % idle, which is the nested-exit overhead from §1. A single init step, `kcmdlinectrl update-props`, took 207 s.

**Verdict:** technically possible, but not usable. First boot takes over 30 minutes; Android's own watchdog trips, so it may never finish; and it burns 4–5 host cores while doing so. That rules it out as a product feature, and THP in the L1 kernel did not change this.

### 2c. Redroid "phone" container next to the PC: works, recommended

Redroid is AOSP built to run as a container with `/init` as PID 1. Its userspace is Apache-2.0, from `github.com/remote-android/redroid-doc`. It needs binder in the kernel, which the MineVibe Android kernel provides. It runs as its **own Apple container**, which means its own lightweight VM booting the MineVibe kernel, on the **PC's network**. The PC keeps its stock kernel and needs no `--virtualization`.

Steps and measured timings:

1. **Image.** `container image pull --platform linux/arm64 docker.io/redroid/redroid:15.0.0_64only-latest`: 661.5 MB compressed, 1.44 GB unpacked, **39 s**.
   - Fix needed: Redroid's `/etc` is an absolute symlink to `/system/etc`. `vminitd` writes `/etc/hosts` and `/etc/resolv.conf` through the rootfs, so bootstrap fails with `internalError: "configureDns"`, or `"configureHosts"` with `--no-dns`.
   - `oci/relsym.py` adds one tiny layer that makes the symlink relative (`etc -> system/etc`), then `container image load` produces `minevibe-spike/redroid:15.0.0_64only-relsym`.
2. **Run** (see `out/redroid-boot-v2.txt`):

   ```sh
   container run -d --name <phone> --network <pc-network> --kernel vmlinux-6.18.35-mv-android2 \
     --cpus 4 --memory 4G --cap-add ALL --masked-path NONE --read-only-path NONE \
     minevibe-spike/redroid:15.0.0_64only-relsym \
     androidboot.redroid_gpu_mode=guest androidboot.redroid_fps=60 androidboot.use_memfd=true
   ```

   `run` returns in 0.7 s and `sys.boot_completed=1` arrives after **6.0–7.0 s**.
   - With the stock kernel, `servicemanager` aborts: "Binder driver '/dev/binder' could not be opened" (`out/redroid-stock-kernel.txt`).
   - Without PSI (v1 kernel and no `psi=1`), `lmkd` restart-loops. Boot then takes 76 s and the app's cold start 50 s. PSI is **required**; v2 enables it by default, and on v1 `--kernel-arg psi=1` works.
3. **PC side** (`pc-android-client-root.sh` and `pc-android-client-user.sh`):
   - apt `adb` (34.0.4) plus scrcpy runtime libs: **15 s**.
   - scrcpy **3.3.4**, built from source with its prebuilt server (sha256-verified against the release `SHA256SUMS.txt`). The build takes ~10 s with deps installed.
   - Ubuntu's own `scrcpy` 1.25 does **not** work on Android 15: `NoSuchMethodException … SurfaceControl.createDisplay`.
   - Then `adb connect <phone-ip>:5555`, `adb install` (**179–240 ms**) and `am start -W` (COLD, **140–169 ms**). `scrcpy --window-title "Android phone" --max-size 1024 --max-fps 60 --no-audio` opens a 380×677 window on `:1`.
   - The whole client flow takes 4.5–8.2 s.
4. **Play.** `xdotool` clicks on the scrcpy window go through as touches. The run went from the intro to hero select to the dungeon (`out/r2-desktop-2..4.png`; the predecessor's run is in `out/pc-desktop-scrcpy-*.png`).
   - Frame rate from `SurfaceFlinger --timestats`: **15.15 fps** at the default display rate, and **62.5 fps** with `androidboot.redroid_fps=60`. Redroid's README gives the default as 15 fps without a GPU, while SurfaceFlinger reported a 30 Hz display.
   - Rendering is software (ANGLE on SwiftShader Vulkan), since Apple container VMs have no GPU.
5. **Resources while playing at 60 fps** (`container stats`):

   | Container | CPU | Memory |
   |---|---|---|
   | phone | ~300 % of 4 vCPU (game ~72 %, surfaceflinger ~24 %, scrcpy's encoder ~12 %, the rest SwiftShader threads) | 2.4 GiB of 4 GiB |
   | PC (scrcpy decode + Xvfb) | ~45 % | — |
   | phone at idle | ~2–40 % | 2.2 GiB |

Limits to tell users:

- **arm64-v8a only.** Apple silicon has no AArch32, and the `64only` image has no 32-bit zygote, so APKs whose native libs are armeabi-v7a-only (or x86-only) fail with `INSTALL_FAILED_NO_MATCHING_ABIS`. Play has required 64-bit builds since 2019, so most current games are fine.
- **No Google Play Services.** Games that require a Google sign-in or Play Integrity will refuse to run.
- **Software GL.** 2D and light 3D are fine. Heavy Unity/Unreal titles will be CPU-bound.
- **The IP changes on every run** (`.3` → `.5`), and container names do not resolve in DNS. The manager must pass the IP to the PC.

### 2d. Redroid inside the PC (Docker in the PC on the custom kernel): does not work out of the box

This would let an agent do everything inside its own PC, provided the PC boots the binder kernel. Script: `redroid-in-pc.sh`.

- Setup works: apt `docker.io` takes 6 s, dockerd comes up with overlayfs and cgroup2 (`/proc/sys` remounted rw), and the 661 MB pull takes 13 s.
- `docker run --privileged redroid/redroid:15.0.0_64only-latest …` then **exits at once with status 129**, with or without `--cgroupns=host`.
- Cause: Android init's `libprocessgroup` cannot use the PC's cgroup v2 tree. Writing `cgroup.procs` fails with "Operation not supported on transport endpoint", so `ueventd` and `apexd-bootstrap` fail with a "fatal error". It also logs `Failed to mount cgroup v2: Device or resource busy`.
- It might be fixable (cgroup layout tweaks inside the PC), but the sidecar in §2c avoids the problem: Android init is PID 1 of a fresh VM there and mounts its own cgroups.
- Side finding for PcManager: once dockerd had run inside the PC, the first `container stop spike-pc` failed with `deleteProcess: failed with errno 95: failed to write to /sys/fs/cgroup/container/spike-pc/docker/cgroup.kill`. The container stayed "running" while `exec` already said "not running". A second `stop` succeeded. `AppleContainerDriver.stop` should retry once before it reports an error.

## 3. Fallbacks

- **TCG (no KVM).** CPU-bound code runs 13× slower than nested KVM (§1). There is no linux-aarch64 SDK emulator to run with `-accel tcg` anyway. Cuttlefish under TCG would be far slower than nested KVM, which itself does not finish booting in 30 min. **Not feasible.** Redroid needs no virtualization at all, so it is the real fallback for M1/M2 Macs.
- **macOS PC with the Android Studio emulator.** The emulator needs Hypervisor.framework (HVF). Nested virtualization in Virtualization.framework exists only on `VZGenericPlatformConfiguration` (Linux guests). `VZMacPlatformConfiguration` has no such property; its topics are `init()`, `auxiliaryStorage`, `hardwareModel` and `machineIdentifier`. HVF is therefore unavailable in a macOS guest and the emulator cannot start. **Not feasible.** A macOS PC could still show a Linux-hosted phone through scrcpy for macOS.

## 4. Recommendation for productizing

Ship **"Android phone" as a managed device of a Linux PC**, backed by a Redroid container. Don't ship an emulator inside the PC.

1. **Vendor a MineVibe Android kernel.**
   - Build it with `kernel/build-v2.sh` (Kata 6.18.35 config + `android.fragment` + `android-v2.fragment`) and pin its sha256 in `packaging/vendor.lock.json`.
   - It is only ever passed with `--kernel` to phone containers. PCs keep the stock kernel and `system kernel set` is never used.
   - KVM in the same kernel is harmless and keeps §1 possible.
2. **Vendor the image.** Pin `redroid/redroid:15.0.0_64only` by digest (`b51bde9c…` index, arm64 manifest `dc2024a9…`) and apply the relative-`/etc` layer: port `relsym.py` to TS, or publish our own image.
   - Android 16 (`16.0.0_64only`) exists too; untested.
3. **PcManager / AppleContainerDriver.**
   - New device kind `phone`, created with `container create` (never `run -d`). Name `mv-phone-<id>`, the PC's owner labels, `--network <pc-network>`, `--kernel <mv-android kernel>`, `--cpus 4 --memory 4G --cap-add ALL --masked-path NONE --read-only-path NONE`, and init args `androidboot.redroid_gpu_mode=guest androidboot.redroid_fps=60 androidboot.use_memfd=true`.
   - `redroid_fps=30` roughly halves the phone's CPU use. `--masked-path` and `--read-only-path` are marked `[EXPERIMENTAL]` in 1.5.0, so re-check them on CLI upgrades.
   - Optionally put a named volume on `/data` so installed apps and saves survive a recreate.
   - Wait for `container exec <phone> /system/bin/getprop sys.boot_completed` == `1`, with a 60 s timeout; typical is 7 s.
   - Read `status.networks[0].ipv4Address` and write `android-phone` into the PC's `/etc/hosts` on every start, because the IP changes.
   - Stop and delete the phone with its PC. Count 4 vCPU / 4 GiB in `Budget`.
   - Never publish port 5555 to the host. Redroid's adb is unauthenticated, but it is reachable only on the PC's isolated network.
4. **PC image.**
   - Add `adb` and scrcpy ≥ 3.x: build v3.3.4 (or v5.0.1, which needs SDL3) from source in the image build, with the server jar checked against `SHA256SUMS.txt`. Add its runtime libs: `libsdl2-2.0-0 libavcodec60 libavdevice60 libavformat60 libavutil58 libswresample4 libusb-1.0-0`.
   - Add a helper `android` CLI with `android install <apk>`, `android open` (scrcpy window "Android phone"), `android launch <pkg>`, `android screenshot` and `android status`.
5. **Agent guidance** (fixes the live-play failure). Tell desk agents:
   - "Android apps run on this PC's Android phone: `android install game.apk && android open`. There is no SDK emulator for this CPU; do not install sdkmanager/emulator, and do not scan the network."
   - When the PC has no phone, the agent asks the player to turn on "Android phone" in the PC settings. It does not ask open-ended questions.
6. **Optional, for power users only.** A PC setting "Nested virtualization (KVM)" = `--virtualization --kernel <mv-android kernel>`, M3+ only, detected via the `unsupported: nested virtualization` error. It is useful for QEMU/KVM work inside a PC, but not for Android.

| Item | Phone (Redroid) | PC for Cuttlefish (not recommended) |
|---|---|---|
| Host | any Mac that runs Apple `container` 1.5.0 (tested: M5 Pro) | M3+, nested virt (macOS 15+ API) |
| Kernel | `vmlinux-6.18.35-mv-android2` via `--kernel` | same, plus `--virtualization` |
| Flags | `--cap-add ALL --masked-path NONE --read-only-path NONE`, PC's `--network` | `--cap-add ALL`, `/proc/sys` remount rw |
| vCPU / RAM | 4 / 4 GiB (2.2–2.4 GiB used) | ≥ 6 / 10 GiB (crosvm 4 GiB RSS) |
| Disk | 1.44 GB image (shared), plus `/data` | 2.6 GB images, plus ~190 MB host packages, plus overlays |
| Boot | 6–7 s | > 30 min, did not finish |

## 5. Repro (exact commands, from this directory on the host)

```sh
# 0. While spike containers run, hold an engine lease: ../container/minevibe-leases/<pid>-<nonce>.json
#    ({"pid","started":`TZ=UTC ps -o lstart=`,"holder","at"}; see EngineLeases.ts). Then the kernel (~3 min, once):
./ct.sh 2400 run --rm --name spike-kbuild2 -l minevibe-spike=android --cpus 6 --memory 6G -v "$PWD:/work" \
  --entrypoint /bin/bash minevibe/linux-pc:dev /work/kernel/build-v2.sh
K="$PWD/kernel/vmlinux-6.18.35-mv-android2"

# 1. Redroid image with the relative /etc symlink (once)
./ct.sh 900 image pull --platform linux/arm64 docker.io/redroid/redroid:15.0.0_64only-latest
./ct.sh 300 image save --platform linux/arm64 -o oci/redroid15.tar docker.io/redroid/redroid:15.0.0_64only-latest
mkdir -p oci/src && tar -xf oci/redroid15.tar -C oci/src
(cd oci && python3 relsym.py docker.io/minevibe-spike/redroid:15.0.0_64only-relsym \
  && (cd dst && tar -cf ../redroid15-relsym.tar oci-layout index.json blobs))
./ct.sh 300 image load -i oci/redroid15-relsym.tar

# 2. Network, phone, PC (the PC needs no special flags for the phone route)
./ct.sh 20 network create --label minevibe-spike=android spike-android-net
./ct.sh 120 run -d --name spike-redroid -l minevibe-spike=android --network spike-android-net --kernel "$K" \
  --cpus 4 --memory 4G --cap-add ALL --masked-path NONE --read-only-path NONE \
  minevibe-spike/redroid:15.0.0_64only-relsym androidboot.redroid_gpu_mode=guest androidboot.redroid_fps=60 androidboot.use_memfd=true
until [ "$(./ct.sh 10 exec spike-redroid /system/bin/getprop sys.boot_completed | tr -d '\r\n')" = 1 ]; do sleep 0.5; done
CUA_ENV_TOKEN="$(cat out/token)" ./ct.sh 180 run -d --name spike-pc -l minevibe-spike=android --network spike-android-net \
  --kernel "$K" --virtualization --cap-add ALL --cpus 6 --memory 10G --shm-size 2G -e CUA_ENV_TOKEN \
  -p 127.0.0.1:43299:3211 --mount "type=bind,source=$PWD,target=/work" minevibe/linux-pc:dev
#    (--kernel/--virtualization/--cap-add on the PC are only for §1/§2b/§2d)

# 3. Client in the PC: adb + scrcpy, install, launch, mirror on the desktop
./ct.sh 600 exec spike-pc sh /work/pc-android-client-root.sh
./pcsh.sh 300 "sh /work/pc-android-client-user.sh $(./ct.sh 20 inspect spike-redroid | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["status"]["networks"][0]["ipv4Address"].split("/")[0])')"

# 4. Cuttlefish (§2b, not recommended)
./ct.sh 900 exec spike-pc sh /work/cf-root.sh && ./pcsh.sh 900 'sh /work/cf-user.sh'
./pcsh.sh 60 'cd ~/cf; date +%s > /tmp/cf-start; nohup cvd create --host_path=$HOME/cf --product_path=$HOME/cf \
  --report_anonymous_usage_stats=n --gpu_mode=guest_swiftshader --cpus=4 --memory_mb=4096 --boot_timeout_secs=3600 \
  > /tmp/cvd-create.log 2>&1 &'
./pcsh.sh 3700 'sh /work/cf-watch.sh'
```

## 6. Files

- `ct.sh` and `pcsh.sh`: the `container` CLI against the dev roots with a hard timeout, and a shell in `spike-pc` as `cua` on `DISPLAY=:1`.
- `kernel/`: build scripts and fragments, the Kata base config, and the built `vmlinux-6.18.35-mv-android{,2}` with `.config`. The source tarball and images are large and not for git.
- `oci/relsym.py`: the Redroid `/etc` fix. `oci/*.tar` and `oci/src|dst` are large and not for git.
- `pc-android-client-root.sh` and `pc-android-client-user.sh`: the phone client inside the PC.
- `cf-root.sh`, `cf-user.sh` and `cf-watch.sh`: Cuttlefish setup and the boot monitor.
- `kvmtest.sh`: the nested KVM vs TCG micro-test.
- `out/`: logs and screenshots. `out/token` holds the spike PC's spacesd token; **do not commit it**. `.gitignore` excludes it and the large artifacts.
- Key screenshots: `out/r2-desktop-4.png` (game in the dungeon, mirrored on the PC desktop) and `out/android-game-1.png` (`adb screencap`).

State left behind:

- Containers `spike-pc` and `spike-redroid` (label `minevibe-spike=android`) are **stopped, not deleted**, on network `spike-android-net`. Restart them with `./ct.sh 60 start <name>`.
- Images `redroid/redroid:15.0.0_64only-latest` and `minevibe-spike/redroid:15.0.0_64only-relsym` remain loaded.
- The spike engine lease was released. The engine was never stopped, and no `mv-pc-*` container was touched.
