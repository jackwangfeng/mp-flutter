# Changelog

See the repository's [root CHANGELOG](https://github.com/jackwangfeng/mp-flutter/blob/main/CHANGELOG.md)
for the full, detailed history (in Chinese) across all three packages.

## 0.3.2 — 2026-10-01

- pub.dev score: `README.md` is now English-primary (install/usage/
  limitations), with the existing Chinese content moved to `README.zh.md`;
  install instructions updated to reflect that this package is now on
  pub.dev (previously documented as git-dependency-only).
- Added `example/lib/main.dart` (a minimal login/payment demo gated by
  `MpWechat.isAvailable`) and `example/pubspec.yaml`.
- Docs: added doc comments to the previously-undocumented fields and
  constructors of `MpPaymentParams`, `MpAddress`, `MpScanResult`, and
  `MpLocation` in `lib/src/models.dart`.

## 0.3.0 — 2026-10-01

- pub.dev readiness: added `homepage`/`repository`/`issue_tracker`/`topics`,
  `LICENSE` (Apache-2.0), and this `CHANGELOG.md`. No API changes.
- Companion package `mp_flutter` (the build CLI) was renamed on pub.dev to
  `flutter_miniprogram`; this package's own name (`mp_flutter_wechat`) is
  unchanged.

## 0.1.0 — 2026-09-28

Initial public release. WeChat login, payment, QR scanning, clipboard,
location, sharing, and capsule-button APIs for Flutter apps compiled with
mp-flutter; calling these APIs on other platforms throws a clear error
instead of a platform-channel crash.
