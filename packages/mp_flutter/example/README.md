# Example: compiling a Flutter app into a WeChat Mini Program

`flutter_miniprogram` is a build-time CLI tool, not a library you import
into Dart code — so this "example" is a minimal end-to-end recipe rather
than a runnable Dart program. It mirrors the top-level `example/` app in
the [mp-flutter repository](https://github.com/jackwangfeng/mp-flutter),
which exercises this exact flow in CI.

## 1. Add the dev dependency

In your existing Flutter app's `pubspec.yaml`:

```yaml
dev_dependencies:
  flutter_miniprogram: ^0.3.2
```

Then:

```bash
flutter pub get
```

## 2. (Optional) add `mp_flutter.yaml`

Place this next to your `pubspec.yaml` if you want to pin the appid or tweak
a few build options (command-line flags always take precedence over this
file — see the package README for the full list):

```yaml
appid: wx1234567890abcdef
output: build/weapp
target: lib/main.dart
```

Without this file, `flutter_miniprogram` uses `touristappid` (guest mode)
and outputs to `build/weapp`.

## 3. Build

```bash
dart run flutter_miniprogram
```

This compiles `lib/main.dart` (or the `target` configured above) to
`build/weapp` (or the `output` configured above) with zero changes to your
app's Dart source.

## 4. Run

Open `build/weapp` with WeChat DevTools ("Import Project") and run it
exactly like any other Mini Program project.

## Troubleshooting

Run the built-in self-check first if anything in step 3 fails:

```bash
dart run flutter_miniprogram doctor
```

It verifies the local toolchain (Node ≥18, esbuild, flutter, brotli, the
WeChat DevTools CLI) is in place and reports what's missing. See the package
README's "Exit codes" section for what each non-zero exit code means.
