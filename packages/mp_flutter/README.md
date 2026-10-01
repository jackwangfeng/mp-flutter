# flutter_miniprogram

Compiles an existing Flutter project into a WeChat Mini Program with zero
Dart code changes to the host project: add one `dev_dependency`, run one
command, and open the resulting Mini Program directly in WeChat DevTools.

The package published on pub.dev is called `flutter_miniprogram` (the name
`mp_flutter` was already taken there). The project/repository is still
called mp-flutter, and this package's directory inside the repo is still
`packages/mp_flutter` — those are not the same thing, so don't mix them up.

中文版见 [README.zh.md](README.zh.md). Full project documentation (feature
list, support matrix, known limitations) lives in the repository root
[README](https://github.com/jackwangfeng/mp-flutter#readme) (Chinese). This
page only covers the package itself: CLI usage, configuration file, exit
codes.

## Install

```yaml
dev_dependencies:
  flutter_miniprogram: ^0.3.2
```

A git dependency to this repository also works (public repo, no extra
credentials needed; pin `ref` to a release tag such as `v0.3.2`, not `main`):

```yaml
dev_dependencies:
  flutter_miniprogram:
    git:
      url: https://github.com/jackwangfeng/mp-flutter.git
      path: packages/mp_flutter
      ref: v0.3.2
```

It's a `dev_dependency` — only used at build time, never bundled into the
final Flutter Web output.

See [`example/README.md`](example/README.md) in this package for the
shortest end-to-end usage sketch (pubspec snippet + command + config file).

## Quick start

```bash
# 1. Add the dependency (see above), then from the project root:
flutter pub get

# 2. Compile to a Mini Program (defaults to build/weapp)
dart run flutter_miniprogram

# 3. Open build/weapp with WeChat DevTools to run it
```

Run a self-check first to confirm the local toolchain (Node ≥18, esbuild,
flutter, brotli, the WeChat DevTools CLI) is in place:

```bash
dart run flutter_miniprogram doctor
```

## CLI options

```
dart run flutter_miniprogram [options]
dart run flutter_miniprogram doctor
dart run flutter_miniprogram e2e-driver
```

| Option | Description |
|---|---|
| `-p, --project` | Path to the Flutter project. Defaults to searching upward from the current directory for the first ancestor containing a `pubspec.yaml` that depends on `flutter` |
| `-o, --output` | Output path for build artifacts, default `build/weapp` |
| `--appid` | Mini Program appid, default `touristappid` (guest mode; most WeChat capabilities are unavailable) |
| `--flutter` / `--esbuild` | Explicit executable paths, overriding auto-detection |
| `--profile` | Produce unminified output with a readable Dart stack, for troubleshooting |
| `--require-location` | Declare that location permission is needed (required by `wx.getLocation` and similar APIs); equivalent to `--private-info=getLocation` |
| `--private-info=<api>` | Declare a user-privacy-sensitive API (written to `app.json`'s `requiredPrivateInfos`); repeatable. Values: `getFuzzyLocation`/`getLocation`/`onLocationChange`/`startLocationUpdate`/`startLocationUpdateBackground`/`chooseAddress`/`choosePoi`/`chooseLocation`. Location-related APIs (other than `chooseAddress`) automatically add `permission.scope.userLocation`; `getLocation`/`getFuzzyLocation` cannot be declared together |
| `--semantics-mirror` | Enable the WXML companion layer (semantic tree mirror), off by default |
| `--perf-hud` | Enable on-device performance measurement (`[mp-perf]`/`[mp-boot]` console logs + a top-left overlay), off by default. See "On-device performance measurement" below |
| `--input-timing` | Input-timing diagnostics: log one `[mp-t]` line per input-related event (touch, engine focus, state dispatch, setData, native focus/blur/input with full `e.detail`, keyboard height, Flutter-layout-to-committed-frame text), and estimate keypress-to-JS latency. Off by default; when off, nothing related is bundled or injected |
| `--android-input=offscreen\|overlay` | Where to place the native input box on Android: `offscreen` (default) = moved horizontally out of the visible area while keeping its vertical position (Android's native cursor can't be made transparent, so stacking it would show two cursors); `overlay` = transparently stacked on top of the input box, same as iOS. iOS always overlays |
| `--no-shader-warmup` | Disable shader warmup (on by default): after the first frame, during idle time, draws common draw-call combinations once on the engine's GrDirectContext so GL programs compile ahead of time, avoiding a frame-blocking compile the first time a list/card page appears (on iOS without JIT, a single program compile can take hundreds of ms). Doesn't delay cold start; pauses during animation/scrolling/touch; light items are batched in slices of at most 8ms, heavy items like shadows/blur are split as finely as possible, require 1s of continuous idle time, one per slice |
| `--shader-warmup-light` | Shader warmup only draws light items (text/solid color/images/circles/strokes/paths etc.), skipping heavy ones (shadows/`BoxShadow`/`BackdropFilter`/color matrices etc. — a single program compile can take over a hundred ms on real devices). Off by default; has no effect with `--no-shader-warmup` |
| `--no-licenses` | Don't bundle full third-party license texts (`assets/NOTICES`, replaced with an empty placeholder); bundled by default (placed in an on-demand subpackage, only downloaded when the licenses page is opened). See the root README's "Package size and cold start" |
| `--cjk-font=level1\|full` / `--no-cjk-font` | Unified common-CJK-character font (a Noto Sans SC subset, brotli-compressed into its own subpackage `pkg-cjk`, read directly from disk at startup): `full` (default) = GB2312 level-1 and level-2 characters + punctuation/fullwidth/Latin-1/common symbols, ~1.15MB, measured on real devices to be off the first-frame critical path; `level1` = level-1 characters only, ~650KB, but text sent from the server containing level-2 or common-symbol characters triggers an extra fallback chunk download and a full relayout. With the default, first-screen Chinese text no longer downloads fallback font chunks piecemeal or triggers a full relayout when the font arrives; characters outside the table are still downloaded on demand. See the root README's "Package size and cold start" for the tradeoffs |
| `--cjk-font-bold=level1\|full\|false` | Bold variant of the unified font (a Noto Sans SC Bold subset, same family, weight 700, its own subpackage `pkg-cjkb`, doesn't block the first frame). Defaults to following `--cjk-font` and must match its tier; `false` = not bundled, Chinese text at weight 600+ is synthesized bold by CanvasKit instead (without JIT, each paragraph's first layout costs roughly 4x). See the root README's "Unified font bold" |
| `--font-base-url <https://...>` | Remote fallback font: Simplified Chinese fallback font chunks are not bundled; they're fetched at runtime from this URL and cached to a local file. The `mp-fonts-remote/` directory under the build output must be uploaded as-is to that address, and the domain must be added to the Mini Program backend's allowed request domains |
| `--no-safe-area` | Disable the build-time entry-point wrapper (safe-area injection), on by default (`--safe-area`). Use this when your project has its own `WidgetsFlutterBinding` subclass — see the limitations noted in the root README's "Safe area" section |
| `-t, --target` | Flutter entry point file, default `lib/main.dart`. A relative path is anchored to the project root (not the cwd) |
| `--dart-define=KEY=VALUE` | Passed through to `flutter build web`, repeatable |
| `--dart-define-from-file=<path>` | Passed through to `flutter build web` |
| `--preload=auto\|dart\|wasm\|none` | Cold start: preload-rule selection order, default `auto` (= dart first) |
| `--[no-]early-wasm` | Cold start: compile CanvasKit as soon as wasm arrives, on by default |
| `--cjk-font-bold-timing=after_first_frame\|eager` | Cold start: request the bold unified font only after the first frame (default), or eagerly at startup |
| `--boot-assets=auto\|main\|dart\|package` | Cold start: which package boot assets go into, default `auto` |
| `--[no-]initial-rendering-cache` | Cold start: static initial-render cache for the host page, on by default |
| `--[no-]lazy-code-loading` | Cold start: inject `app.json` on demand, on by default |
| `--version` | Print the package version |

Full help: `dart run flutter_miniprogram --help`.

### The `e2e-driver` subcommand

Prints the absolute path to the E2E driver script directory shipped with the
package (where `tool/e2e/drive.js` lives), exit code 0. That directory
contains the driver script used to drive WeChat DevTools through acceptance
runs (`drive.js`, which handles cold start plus a few DevTools-CLI
version-compatibility workarounds), a `package.json` (declaring the
`miniprogram-automator` dependency), and its own README. Recommended usage —
**copy it first, then install dependencies** — don't run `npm install`
directly inside the pub cache directory:

```bash
DIR=$(dart run flutter_miniprogram e2e-driver)
cp -R "$DIR" ./mp-e2e && (cd mp-e2e && npm i)
```

```js
require('./mp-e2e/drive.js')
```

See that directory's `README.md` for detailed usage (`runE2E`'s
parameters/return value, known cold-start and DevTools flakiness issues).

## `mp_flutter.yaml` (optional)

Placed in the project root; precedence is **command line > config file >
default**:

```yaml
appid: wx1234567890abcdef
output: build/weapp
require_location: true
private_infos: [chooseLocation, choosePoi]   # merged and de-duplicated with --private-info
semantics_mirror: false
perf_hud: false
# input_timing: false          # [mp-t] input-timing diagnostics (same as --input-timing)
# android_input: offscreen     # Android native input box: offscreen (default) / overlay, same as --android-input
shader_warmup: true            # Warm up shaders during idle time after the first frame (same as --no-shader-warmup to disable)
# shader_warmup_light: true     # Warmup only draws light items, skipping heavy ones (same as --shader-warmup-light)
safe_area: true
licenses: true                 # false = don't bundle NOTICES (same as --no-licenses)
cjk_font: full                  # full (default) / level1 / false, same as --cjk-font / --no-cjk-font
# cjk_font_bold: false          # Bold: defaults to following cjk_font (must match tier), false = not bundled, same as --cjk-font-bold
# font_base_url: https://cdn.example.com/mp-fonts/   # Remote fallback font (same as --font-base-url)
splash_title: My Store          # App name on the native splash screen; defaults to the pubspec's name
splash_color: "#ffffff"        # Splash-screen background color (#rgb / #rrggbb), defaults to white
# Cold-start switches (defaults are the recommended combo; toggle individually for real-device A/B testing, see the root README's "Cold-start switches")
# preload: auto                 # auto (default, =dart) / dart / wasm / none, same as --preload
# early_wasm: true              # Compile CanvasKit as soon as wasm arrives, same as --no-early-wasm to disable
# cjk_font_bold_timing: after_first_frame   # or eager, same as --cjk-font-bold-timing
# boot_assets: auto             # auto / main / dart / package, same as --boot-assets
# initial_rendering_cache: true # same as --no-initial-rendering-cache to disable
# lazy_code_loading: true       # same as --no-lazy-code-loading to disable
target: lib/main.dart
dart_define:
  API_BASE: https://api.example.com
  FEATURE_X: "true"
```

`dart_define` is merged with the command-line `--dart-define`; a command-line
key with the same name overrides the config file's value without changing
the order of existing keys; every value must be a scalar (not null or a
nested map/list, otherwise `ConfigParseFailure`, exit code 64). Unknown keys
only trigger a one-time warning and don't affect the build.

`private_infos` is merged and de-duplicated with the command-line
`--private-info` (yaml entries first, newly added command-line ones after);
an unrecognized value, or declaring `getLocation`/`getFuzzyLocation`
together, is an error before the build starts (exit code 64). **Beyond this
client-side declaration, each API must also be enabled individually in the
Mini Program admin console under "Development Management → Interface
Settings," or real devices will reject the call** (DevTools is not subject
to this restriction).

## On-device performance measurement (`--perf-hud`)

For diagnosing list-scrolling jank on real devices (especially iOS). Off by
default — when off, no related module is `require`d and there is zero
runtime overhead (injected the same way as `--semantics-mirror`).

Enable it:

```bash
dart run flutter_miniprogram --perf-hud
```

or set `perf_hud: true` in `mp_flutter.yaml`.

Once enabled:

- One `[mp-perf]` console line per second, with fields:
  - `fps`: actual rAF frames executed in the past 1 second
  - `frame(avg/p95/max ms)`: total time per rAF callback (includes the
    engine's beginFrame/drawFrame)
  - `gl(calls/frame,ms/frame)`: WebGL call count/cumulative time per frame,
    tallied per frame but sampled (one full frame tallied every 10 frames)
    to control the overhead of the measurement wrapper itself
  - `decode(count,ms)`: image decoding (`CanvasKit.MakeImageFromEncoded`
    etc.) count and cumulative time; a single decode over 8ms logs an extra
    line `[mp-perf] decode-slow <duration> size=<width>x<height>
    bytes=<byte count>`
  - `longTasks`: number of frames that took over 50ms
  - `dart~=<duration>ms(est)`: a rough estimate of Dart/framework time (total
    frame time minus gl time, minus decode time amortized per frame), **an
    estimate, not precise attribution**
  - `shader=<count>/<ms>`, `programs=<cumulative count>/<ms>`: gl calls
    related to shader compilation and cumulative GL programs compiled. Each
    program also logs a line `[mp-perf] program #n <ms> <source hash>
    attrs=<vertex attributes> unis=<fragment uniforms>`, used to identify
    which draw-call combination it is (rounded-corner clipping
    `uinnerRect,uradiusPlusHalf`, Gaussian blur `uoffsetsAndKernel`, gradient
    `ustart,uend`, …); shader warmup logs one line per item finished
    `[mp-perf] shader-warmup item <name> <ms> [heavy]`, and one line at the
    end `[mp-perf] shader-warmup done combos=<count> busy=<main-thread ms
    occupied> maxSlice=<longest single slice ms> elapsed=<ms>
    heavy=<heavy items drawn> skipped=<heavy items skipped in light mode>`
- A frame taking over 50ms logs a `long-frame` line; a gap of over 100ms
  between frames while the main thread is genuinely occupied logs a `gap`
  line (outside a frame). `long-frame`'s breakdown (requires the entry-point
  wrapper, i.e. the default `--safe-area`):
  - `dart=<total>(transient animation callbacks, build, layout, bits, paint,
    comp compositing, sem semantics, fin, post post-frame callbacks)`: each
    framework phase, reported once per frame by the entry-point wrapper via
    `self.__mpFrameProf`; `metrics=N` is the number of viewport metric
    changes this frame, `inset=` is the current `viewInsets.bottom`
  - `raster=`: engine rasterization (Surface.getCanvas → flush; the engine's
    rendering is asynchronous and often lands in a microtask after the rAF
    callback returns, counted into the current frame)
  - after the vertical bar are reference breakdowns (overlapping with the
    above, not double-counted): `shader`/`upload`/`decode`/`layout`
    (paragraph layout)/`tb` (text-input bridge polling and the setData-sync
    portion)/`setData=count/bytes`/`resize=` (window-size-change events)
  - `other=`: total frame time minus framework phases and rasterization
- Cold-start stage timings: one line per stage finishing,
  `[mp-boot] <stage name> +<ms since App onLaunch>ms (<this stage's
  duration ms>ms)`, stages in order: page `onLoad`, each subpackage
  `subpackage:<name>` (when `require.async` completes), `canvaskit` (wasm
  load/compile/instantiate — WeChat has no finer-grained stage API, so this
  is reported as one combined stage), `crypto` (seeding), `dart-chunks`
  (each `main.dart.js` chunk finishes loading), `dart-main` (a proxy metric
  for when Dart-generated code starts taking over execution),
  `first-frame` (the first frame is actually committed); a final line
  `[mp-boot] total` after everything finishes
- A small toggleable overlay in the top-left corner shows FPS and average
  frame time, with `pointer-events: none` (doesn't block touches, so it
  can't be toggled by tapping it). In DevTools/on-device debug console, use
  `getCurrentPages()[0].mpPerf.setVisible(false)` to hide it
  (`setVisible(true)` to show it again)

How to view this on a real device: in WeChat DevTools' top menu, choose
"Real Device Debugging" → connect a device → search the Console panel below
for `[mp-perf]` or `[mp-boot]`; preview/compile in DevTools itself prints the
same lines, searched the same way.

## Exit codes

Build failures exit with a code categorizing the cause (2 package size
exceeded, 3 unsupported Flutter version, 4 `flutter build web` failed, 5
build-time transform mismatch, 6 missing external tool, 7 font download
failed, 64 argument/config error, 1 uncategorized fallback). See
[docs/troubleshooting.md](../../docs/troubleshooting.md)
(Chinese) for a line-by-line reference and remediation.

## Support matrix and known limitations

See
[docs/support-matrix.md](../../docs/support-matrix.md)
(Chinese).

## License

Apache License 2.0, see the repository root
[LICENSE](../../LICENSE).
