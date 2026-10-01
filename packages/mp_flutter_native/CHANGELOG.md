# Changelog

See the repository's [root CHANGELOG](https://github.com/jackwangfeng/mp-flutter/blob/main/CHANGELOG.md)
for the full, detailed history (in Chinese) across all three packages.

## 0.3.0 — 2026-10-01

- pub.dev readiness: added `homepage`/`repository`/`issue_tracker`/`topics`,
  `LICENSE` (Apache-2.0), and this `CHANGELOG.md`. No API changes.
- Companion package `mp_flutter` (the build CLI) was renamed on pub.dev to
  `flutter_miniprogram`; this package's own name (`mp_flutter_native`) is
  unchanged.

## 0.1.0 — 2026-09-28

Initial public release. Wires `MpVideo`/`MpMap`/`MpCamera` to the native
`<video>`/`<map>`/`<camera>` components inside WeChat Mini Programs compiled
with mp-flutter; falls back to normal rendering on other platforms/browsers.
