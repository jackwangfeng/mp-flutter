# Changelog

See the repository's [root CHANGELOG](https://github.com/jackwangfeng/mp-flutter/blob/main/CHANGELOG.md)
for the full, detailed history (in Chinese) across all three packages.

## 0.3.2 — 2026-10-01

- pub.dev score: `README.md` is now English-primary (install/usage/config/
  limitations), with the existing Chinese content moved to `README.zh.md`.
- Added `example/README.md` (this is a build-time CLI tool, not a library,
  so the example is a pubspec snippet + command + `mp_flutter.yaml` sample
  rather than a runnable Dart program).
- Static analysis: added `analysis_options.yaml` (`package:lints/core.yaml`)
  and fixed all analyzer findings, including an "Angle brackets will be
  interpreted as HTML" dartdoc warning in
  `lib/src/transform/canvaskit_js.dart` (the regex example in that doc
  comment is now fenced as a code block).
- Reformatted `lib/` and `bin/` with `dart format` (no behavior change).

## 0.3.1 — 2026-10-01

- The WeChat DevTools E2E driver script (`drive.js`) is now shipped inside
  this package at `tool/e2e/drive.js`, with its own `package.json`
  (declaring the `miniprogram-automator` dependency) and `README.md`. New CLI
  subcommand `dart run flutter_miniprogram e2e-driver` prints the absolute
  path to that directory. See the root CHANGELOG and
  `packages/mp_flutter/tool/e2e/README.md` for usage.

## 0.3.0 — 2026-10-01

- **Breaking**: the package published to pub.dev is renamed from `mp_flutter`
  to `flutter_miniprogram` (the name `mp_flutter` was already taken on
  pub.dev by another package). The repository name, the package's directory
  inside the repo (`packages/mp_flutter`), and the config file name
  (`mp_flutter.yaml`) are all unchanged — only the pubspec `name`, the
  `package:` import prefix, and the `dart run <name>` executable name
  changed (`dart run mp_flutter` → `dart run flutter_miniprogram`).
- pub.dev readiness: added `homepage`/`repository`/`issue_tracker`/`topics`,
  `LICENSE` (Apache-2.0), `NOTICE` (bundled Noto Sans SC fonts under OFL-1.1
  and acorn under MIT), and this `CHANGELOG.md`.
- Android: native input box moved off-screen by default
  (`--android-input=offscreen`) to avoid double cursors; input state now
  diffs per field instead of sending all fields on every keystroke;
  keyboard-re-pop fallback; `--input-timing` diagnostics flag. Fixed
  backspace/empty-value handling after IME composition on Android. See the
  root CHANGELOG for full detail.

## 0.1.0 — 2026-09-28

Initial public release. Compiles an existing Flutter project into a WeChat
Mini Program with zero Dart code changes in the host project.
