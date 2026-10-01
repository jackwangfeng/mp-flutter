# Changelog

See the repository's [root CHANGELOG](https://github.com/jackwangfeng/mp-flutter/blob/main/CHANGELOG.md)
for the full, detailed history (in Chinese) across all three packages.

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
