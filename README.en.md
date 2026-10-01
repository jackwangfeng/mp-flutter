# mp-flutter

[![License](https://img.shields.io/github/license/jackwangfeng/mp-flutter)](LICENSE)
[![Release](https://img.shields.io/github/v/release/jackwangfeng/mp-flutter)](https://github.com/jackwangfeng/mp-flutter/releases)
[![Flutter](https://img.shields.io/badge/Flutter-3.41.9%20stable-02569B?logo=flutter&logoColor=white)](docs/support-matrix.md)
[![Platform](https://img.shields.io/badge/platform-WeChat%20Mini%20Program-07C160?logo=wechat&logoColor=white)](https://developers.weixin.qq.com/miniprogram/dev/framework/)

**Run unmodified Flutter apps as WeChat Mini Programs** — Flutter Web + CanvasKit compiled straight into a 微信小程序 (WeChat Mini Program), zero Dart code changes, real-device verified on iOS and Android.

[中文说明 →](README.md) ・ English (current)

mp-flutter compiles an existing Flutter project into a WeChat Mini Program. The host project needs **zero Dart code changes** — no special widget subset, no rewriting your UI in another framework.

## Why mp-flutter

- **Zero code changes** — the host Flutter project doesn't need any mini-program-specific adaptation code; run `flutter pub get`, then a single command compiles it into a mini program
- **Real Flutter rendering, not a reimplementation** — the compiled output is an **unmodified** Flutter Web (CanvasKit) build. The rendering pipeline is the same one Flutter itself uses, so there's no "which widgets are supported" question
- **The full widget / plugin ecosystem** — `http`, `dio`, `shared_preferences`, `NetworkImage`, etc. are used exactly as on any other platform; the underlying implementation is transparently swapped for WeChat Mini Program APIs (see Capabilities & Limitations below)
- **Real-device performance data, not simulator-only claims** — measured on iPhone 15 and an Android device: cold start ~3.5–4s, steady-state list scrolling at 40–56fps on iOS / 50–60fps on Android, an image-wall grid at ~57fps. Full numbers in [`docs/capability-guide.md`](docs/capability-guide.md)

## Quick Start (3 steps)

**1. Add the dependency** — the pub.dev package is named `flutter_miniprogram` (the name `mp_flutter` was already taken on pub.dev by another package; the project/repo is still called mp-flutter, and the package's directory inside the repo is still `packages/mp_flutter` — three different things):

```yaml
dev_dependencies:
  flutter_miniprogram: ^0.3.0
```

For an unreleased commit or a private fork, use a git dependency instead:

```yaml
dev_dependencies:
  flutter_miniprogram:
    git:
      url: https://github.com/jackwangfeng/mp-flutter.git
      path: packages/mp_flutter
      ref: main
```

**2. Compile** — from the project root (running `dart run flutter_miniprogram doctor` first to self-check your toolchain is recommended):

```bash
dart run flutter_miniprogram
```

Prerequisites (`doctor` checks all of these): Flutter (see Support Matrix below), Node **≥18**, and `brotli` (used to compress `canvaskit.wasm`; not preinstalled on macOS/Linux — `brew install brotli` / `apt install brotli`; missing it fails the build with exit code 6, see [`docs/troubleshooting.md`](docs/troubleshooting.md)). esbuild is installed automatically on first use. **macOS/Linux only** — Windows is not supported as a build host (see [`docs/support-matrix.md`](docs/support-matrix.md)); this only affects where you *build*, not where the mini program *runs*.

Output lands in `build/weapp` by default (override with `-o` / the `mp_flutter.yaml` `output` key).

**3. Open it** — open the `build/weapp` directory directly in WeChat DevTools (微信开发者工具) and run it.

If you need WeChat-specific capabilities (login, payment, QR scanning, …) or native components (video, map, camera), add the companion packages `mp_flutter_wechat` / `mp_flutter_native` — see "Capabilities & Limitations" below and each package's own README.

## Config options

Full reference: [`packages/mp_flutter/README.md`](packages/mp_flutter/README.md). The most commonly used CLI flags / `mp_flutter.yaml` keys:

| Flag | `mp_flutter.yaml` key | Purpose |
|---|---|---|
| `-p, --project` | — | Flutter project path (default: nearest ancestor directory with a `pubspec.yaml` that depends on `flutter`) |
| `-o, --output` | `output` | Output directory (default `build/weapp`) |
| `-t, --target` | `target` | Flutter entrypoint file (default `lib/main.dart`) |
| `--appid` | `appid` | Mini program appid (default `touristappid`, a tourist/guest appid — most WeChat capabilities won't work with it) |
| `--flutter`, `--esbuild` | `flutter`, `esbuild` | Explicit executable paths, overriding auto-detection |
| `--profile` | — | Produce unminified output with a readable Dart stack, for debugging |
| `--require-location` / `--private-info` | `require_location` / `private_infos` | Declare which user-privacy APIs (e.g. `getLocation`) you call, required before WeChat will allow them |
| `--semantics-mirror` | `semantics_mirror` | Opt-in WXML accessibility/semantics mirror layer (off by default — runtime cost; also known not to be reliable combined with text input, see Limitations) |
| `--perf-hud` | `perf_hud` | On-device performance HUD + `[mp-perf]`/`[mp-boot]` console logging |
| `--input-timing` | `input_timing` | Per-keystroke timing diagnostics for the text input bridge |
| `--android-input` | `android_input` | Where the native Android input box sits (`offscreen` default, or `overlay`) |
| `--[no-]safe-area` | `safe_area` | Inject the mini program's safe-area insets into `MediaQuery` (on by default) |
| `--[no-]shader-warmup` | `shader_warmup` | Pre-warm common CanvasKit shader combinations after first frame, to avoid first-use compile jank (on by default) |
| `--[no-]licenses` | `licenses` | Bundle third-party license text (`showLicensePage`); turn off to save package size |
| `--cjk-font`, `--cjk-font-bold` | `cjk_font`, `cjk_font_bold` | Bundle a common-Chinese-character unified font (and its bold cut) to avoid CJK first-paint reflow |
| `--font-base-url` | `font_base_url` | Serve fallback CJK fonts from a remote CDN instead of bundling them, to shrink package size |
| `--preload` | `preload` | Subpackage preload order strategy for cold start |
| `--dart-define`, `--dart-define-from-file` | `dart_define` | Forwarded to `flutter build web` |

Precedence is **CLI flag > `mp_flutter.yaml` > default**.

## Support Matrix

Verified against Flutter stable **3.41.9** and the `flutter_ohos` fork **3.41.10-ohos-0.0.2-beta**; Node **≥18**; WeChat Mini Program base library **≥3.15.0**. Each platform bridge (rendering, touch, text input, networking, storage, images, fonts, routing, WeChat capabilities, native components, the accessibility mirror) has its own verification status and known caveats in [`docs/support-matrix.md`](docs/support-matrix.md) — read that file for the authoritative, line-by-line list before relying on any specific API.

## Capabilities & Limitations

Networking (`http`/`dio`/`NetworkImage`) and storage (`shared_preferences`) work with **zero code changes** — the shim swaps in WeChat APIs underneath. Key things to know before shipping:

- On real devices, `wx.request` (including image downloads) can only reach HTTPS domains allow-listed in the WeChat admin console; WeChat DevTools can bypass this check, so a passing DevTools run does **not** guarantee the real device will work — always verify on-device after configuring domains.
- No automatic cookie handling — put session tokens in a header (e.g. `Authorization: Bearer <token>`).
- `FormData`/`Blob` request bodies, `responseType: 'blob'/'document'`, and synchronous XHR are not supported.
- Network images have no on-disk cache, only Flutter's in-memory `ImageCache` — they re-download after a cold restart.
- Local storage (`shared_preferences`) is backed by `wx.*StorageSync` with a `mpf:` key prefix: 1MB per key, 10MB total, throws `QuotaExceededError` past that.
- `dio`'s `connectTimeout`/`receiveTimeout` are merged into a single underlying `xhr.timeout` (their sum), not applied as separate phases.
- Redirects are followed automatically by WeChat; the app never sees the intermediate or final redirected URL.

Other known limitations (full, current list always in [`docs/support-matrix.md`](docs/support-matrix.md)):

- Native components (`MpVideo`/`MpMap`/`MpCamera` from `mp_flutter_native`) always render **above** the Flutter canvas and cannot sit between Flutter layers in a `Stack` — overlay UI with WeChat's own `cover-view`/`cover-image` instead.
- The optional WXML semantics-mirror layer (`--semantics-mirror`, off by default) and text input together are not currently reliable — avoid combining them.
- Thai, Lao, Khmer and Burmese text only wraps at spaces (no in-word break opportunities), because the bundled CanvasKit's ICU word-break dictionaries for those scripts were stripped to fit size limits.
- The `flutter_ohos` build does not bundle Material ink/stretch shaders (`InkSparkle`, overscroll stretch).
- Android's physical back button is not wired to the Flutter `Navigator`.

See [`docs/capability-guide.md`](docs/capability-guide.md) for where complex pages (long lists, image grids, long-form text, large forms, heavy visual effects, native components) start to hit real-device limits, and concrete, actionable guidance (e.g. lazy-loaded list rows are effectively unbounded; keep a single eagerly-built block of text under ~1500 characters / 50 paragraphs; split forms with more than 10–15 fields across steps).

## E2E driver (shipped in the package)

The WeChat DevTools automation driver used to run this project's own
acceptance suite (`drive.js` — cold-start handling plus a couple of DevTools
CLI version workarounds) ships inside the `flutter_miniprogram` pub package
at `tool/e2e/drive.js`, so you can reuse it against your own compiled output
without cloning this repository:

```bash
DIR=$(dart run flutter_miniprogram e2e-driver)   # prints the absolute path to the shipped tool/e2e dir
cp -R "$DIR" ./mp-e2e && (cd mp-e2e && npm i)      # copy it out first, then install — don't npm install inside pub's cache
```

```js
const { runE2E } = require('./mp-e2e/drive.js');
```

See [`packages/mp_flutter/tool/e2e/README.md`](packages/mp_flutter/tool/e2e/README.md)
for the full `runE2E` usage (its `projectPath`/`interact`/`settleMs` options,
the shape of the returned `lines`/`states`/etc.) and the known cold-start /
DevTools-flake notes.

## Real-device results

Beyond the WeChat DevTools simulator regression suite, mp-flutter has been run through a full acceptance pass on real hardware (list scrolling, images, networking, WeChat capabilities, etc.) on:

| Device | OS | WeChat version | Base library |
|---|---|---|---|
| iPhone 15 | iOS 26.5 | 8.0.77 | 3.17.3 |
| Xiaomi (Android) | Android 15 (API 35) | 8.0.78 | 3.17.3 |

Key numbers (release build):

- Cold start (mini program launch to interactive first frame): **~3.5–4s**
- Steady-state scroll frame rate: iOS **40–56fps**, Android **50–60fps**
- Image-wall grid (120 images): **~57fps**, no jank

Full methodology, per-scenario breakdowns (long list, image wall, long-form text, large form, visual effects, native components) and the "how much can one page hold" guidance are in [`docs/capability-guide.md`](docs/capability-guide.md).

## FAQ

**Can Flutter be used to build a WeChat Mini Program?**
Yes. mp-flutter compiles a standard Flutter project (its Flutter Web + CanvasKit build) into a WeChat Mini Program. The host project needs no Dart code changes — rendering, touch, text input, networking, and storage are handled transparently by a build-time shim. See "Capabilities & Limitations" above.

**How do I convert a Flutter app into a WeChat Mini Program?**
Three steps: add `mp_flutter` as a `dev_dependency`, run `dart run mp_flutter` from the project root, then open the output directory (`build/weapp` by default) in WeChat DevTools. For WeChat capabilities (login, payment, scanning, …) or native components (video/map/camera), also add `mp_flutter_wechat` / `mp_flutter_native`. See "Quick Start" above.

**How is this different from MPFlutter / Taro / uni-app?**
Different approaches, not a strictly-better-or-worse comparison. Taro and uni-app are cross-platform frameworks: you write UI against their own component/API model, and it's compiled down to a mini program without going through Flutter's rendering pipeline. MPFlutter is a separate open-source project that also compiles Flutter to mini programs, using a different rendering implementation. mp-flutter instead compiles an **unmodified** Flutter Web (CanvasKit) build, so the rendering pipeline is identical to real Flutter and no Dart code changes are needed — the trade-off is a larger package size than a mini-program-native implementation (see "How big is the output package?" below).

**Does it work on real iOS/Android devices?**
Yes — see "Real-device results" above. Note that the **build host** (where you run `dart run flutter_miniprogram`) only supports macOS/Linux; Windows is not supported as a build host. That has no bearing on where the compiled mini program itself runs.

**How big is the output package?**
It depends on your project and chosen build options; typical total package sizes run from a few MB up to the low teens of MB (WeChat's limits: ≤2MB per subpackage/main package, ≤30MB total across all subpackages). By default a bundled common-Chinese-character font (~1–2.3MB) is included to avoid CJK first-paint reflow; `--no-licenses` and `--font-base-url` (serve fallback fonts from a CDN instead of bundling) can shrink this significantly. See [`docs/capability-guide.md`](docs/capability-guide.md) and [`docs/support-matrix.md`](docs/support-matrix.md) for exact measurements.

## Links

- [`docs/architecture.md`](docs/architecture.md) — design & implementation notes (BOM/DOM shim, subpackaging, the custom CanvasKit build, etc.)
- [`docs/support-matrix.md`](docs/support-matrix.md) — toolchain versions, per-bridge verification status, known limitations
- [`docs/capability-guide.md`](docs/capability-guide.md) — complex-page guidance: real-device stress-test data, how much a page can hold, recommended patterns
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — CLI exit codes and how to resolve them
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — dev environment, local check scripts, commit conventions
- [`CHANGELOG.md`](CHANGELOG.md) — release history
- [`LICENSE`](LICENSE) — Apache License 2.0 (see also [`NOTICE`](NOTICE))
- [`packages/mp_flutter/README.md`](packages/mp_flutter/README.md) — the build pipeline package: CLI flags, config file
- [`packages/mp_flutter_wechat/README.md`](packages/mp_flutter_wechat/README.md) — full WeChat capabilities API
- [`packages/mp_flutter_native/README.md`](packages/mp_flutter_native/README.md) — full native components API
- [`example/`](example/) — example project (dogfooding target, covers every capability)
- [`tools/e2e/README.md`](tools/e2e/README.md) — end-to-end regression suite (run locally)
