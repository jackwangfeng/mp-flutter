# mp_flutter_native

Wires `MpVideo`/`MpMap`/`MpCamera` to native `<video>`/`<map>`/`<camera>`
components inside a WeChat Mini Program compiled by
[mp-flutter](../mp_flutter) (`flutter_miniprogram` on pub.dev) — via its JS
sync layer `self.__mpNative` (see
`packages/mp_flutter/runtime/native-views.js`). On other platforms
(Android/iOS/desktop) or in a plain browser, each widget renders its own
`fallback`, and controller methods throw a clear `UnsupportedError` instead
of failing silently.

中文版见 [README.zh.md](README.zh.md).

## Install

```yaml
dependencies:
  mp_flutter_native: ^0.3.2
```

When developing inside the mp-flutter monorepo itself (e.g. the top-level
`example/` app), use a relative path dependency instead:

```yaml
dependencies:
  mp_flutter_native:
    path: ../mp_flutter/packages/mp_flutter_native
```

See [`example/lib/main.dart`](example/lib/main.dart) in this package for a
minimal, runnable usage example (`MpVideo` + `MpMap` with an availability
check).

## API

```dart
MpVideo(
  src: 'https://example.com/a.mp4',
  autoplay: true,          // Prefer this over calling controller.play() right after creation
  loop: false,
  muted: false,
  controls: true,
  poster: 'https://example.com/poster.png',
  objectFit: 'contain',
  controller: myVideoController,
  onPlay: () {}, onPause: () {}, onEnded: () {},
  onTimeUpdate: (seconds) {}, onError: (msg) {},
  fallback: const Text('Video is not supported on this platform'),
)

MpMap(
  latitude: 31.2, longitude: 121.5, scale: 16,
  markers: [MpMapMarker(id: 1, latitude: 31.2, longitude: 121.5, title: 'Here')],
  showLocation: true,
  controller: myMapController,
  onTap: (lat, lng) {}, onMarkerTap: (id) {},
  // WeChat's bindregionchange event's `e.type` is already 'begin'/'end'
  // (the start/end of a viewport change); this is forwarded as-is rather
  // than collapsed into one generic 'regionchange'.
  onRegionChange: (type) {}, // type: 'begin' | 'end'
  fallback: const Text('Map is not supported on this platform'),
)

MpCamera(
  devicePosition: 'back', flash: 'auto',
  controller: myCameraController,
  onError: (msg) {},
  fallback: const Text('Camera is not supported on this platform'),
)

bool get mpNativeAvailable; // true only inside a Mini Program compiled by mp-flutter
```

Controllers:

- `MpVideoController`: `play()`/`pause()`/`seek(seconds)`/`stop()`/
  `requestFullScreen()`/`exitFullScreen()`
- `MpMapController`: `moveToLocation()`/`getCenterLocation()` (returns
  `({double latitude, double longitude})`)
- `MpCameraController`: `takePhoto({quality})` (returns `tempImagePath`)

## Behavior outside a Mini Program, or before the native view exists

Check `mpNativeAvailable` before deciding whether to show related UI, so you
never call a controller method that throws `UnsupportedError`:

- All three widgets render `fallback ?? const SizedBox.shrink()`.
- Any controller method call throws
  `UnsupportedError('mp_flutter_native: this operation is only available inside a Mini Program compiled by mp-flutter, after the matching native component has been created')`.

```dart
if (mpNativeAvailable) {
  await myVideoController.play();
}
```

## Limitations

- `mpNativeAvailable` is only `true` inside a Mini Program compiled by
  mp-flutter; on every other platform (Android/iOS/desktop, or a plain
  browser) the three widgets fall back to `fallback` and controllers throw.
- A controller is only usable after its matching widget has actually been
  built in a Mini Program environment — calling it beforehand (or after the
  widget is disposed) throws `UnsupportedError`, it does not queue the call.
- See "Native components are always layered above Flutter content" below —
  this is a hard WeChat Mini Program platform constraint, not something this
  package can work around.

## ★ Layering warning: native components always sit above Flutter content

The Mini Program renders these as native views, composited on top of the
WXML companion layer — **independent of Flutter's own paint order**. If you
place other Flutter content (a dialog's backdrop, decorations, a
viewfinder overlay, etc.) "above" `MpVideo`/`MpMap`/`MpCamera` in the widget
tree, in practice that content gets covered by the native component, not the
other way around. If you need UI layered on top of a native component,
consider the Mini Program's own `cover-view`/`cover-image` (outside the
scope of this package), or keep interactive UI outside the native
component's area.

## Implementation notes

- On Web (`lib/src/registry_web.dart`): the first time an `MpNativeKind` is
  used, `ui_web.platformViewRegistry.registerViewFactory` registers an
  `mp-native-<kind>` view type whose factory creates a
  `<div data-mp-native data-mp-params data-mp-id>` — `data-mp-id` is simply
  the platform view `viewId` the Flutter engine assigns (no separate
  counter). Parameter changes are synced by rewriting the `data-mp-params`
  attribute directly (`HtmlElementView`'s `creationParams` only takes effect
  at creation time and does not follow widget rebuilds); native events are
  listened for via a `CustomEvent('mpnative')` on the placeholder div, whose
  `detail` is the JSON string `{type, detail}`; controller commands are
  forwarded through `self.__mpNative.command(id, method, argsJson)`.
- `self.__mpNative` may not exist yet at the moment the factory function
  runs (`boot()`'s scheduling for the first frame is asynchronous — this
  timing gap has been observed on real devices): per the Task 2 contract, if
  it exists, call `register(id)`; if not, push the id onto
  `self.__mpNativePending` (auto-created). On disposal of the corresponding
  view, `unregister(id)` must be called, or the sync layer's scan loop keeps
  running indefinitely.
- On non-Web platforms (`lib/src/registry_stub.dart`): `mpNativeAvailable` is
  always `false`, and controller methods always throw `UnsupportedError`.
- A `dart.library.js_interop` conditional import switches between the
  stub/web implementations, mirroring
  [`mp_flutter_wechat`](../mp_flutter_wechat)'s `channel_stub.dart`/
  `channel_web.dart` pattern. `flutter test` runs on the VM by default, so it
  always selects the stub.
