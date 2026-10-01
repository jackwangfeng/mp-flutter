// Minimal usage example for `mp_flutter_native`.
//
// `mpNativeAvailable` is only `true` inside a WeChat Mini Program compiled
// by `flutter_miniprogram` (the `mp-flutter` build tool). Everywhere else
// (including this example running as a plain Flutter app), `MpVideo` and
// `MpMap` render their `fallback` content, which keeps this example
// runnable and analyzable on any platform.
import 'package:flutter/material.dart';
import 'package:mp_flutter_native/mp_flutter_native.dart';

void main() => runApp(const MpFlutterNativeExampleApp());

/// Root widget of the example app.
class MpFlutterNativeExampleApp extends StatelessWidget {
  /// Creates the example app.
  const MpFlutterNativeExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'mp_flutter_native example',
      home: const NativeViewsPage(),
    );
  }
}

/// Demonstrates `MpVideo` and `MpMap`, each guarded by [mpNativeAvailable].
class NativeViewsPage extends StatefulWidget {
  /// Creates the demo page.
  const NativeViewsPage({super.key});

  @override
  State<NativeViewsPage> createState() => _NativeViewsPageState();
}

class _NativeViewsPageState extends State<NativeViewsPage> {
  final _videoController = MpVideoController();
  final _mapController = MpMapController();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('mp_flutter_native example')),
      body: Column(
        children: [
          Text('Native views available: $mpNativeAvailable'),
          SizedBox(
            height: 200,
            child: MpVideo(
              src: 'https://example.com/a.mp4',
              autoplay: true,
              controller: _videoController,
              fallback: const Center(child: Text('Video is not supported on this platform')),
            ),
          ),
          SizedBox(
            height: 200,
            child: MpMap(
              latitude: 31.2,
              longitude: 121.5,
              scale: 16,
              markers: const [
                MpMapMarker(id: 1, latitude: 31.2, longitude: 121.5, title: 'Here'),
              ],
              controller: _mapController,
              fallback: const Center(child: Text('Map is not supported on this platform')),
            ),
          ),
          ElevatedButton(
            onPressed: () async {
              // Always gate controller calls behind `mpNativeAvailable`;
              // otherwise they throw `UnsupportedError`.
              if (mpNativeAvailable) {
                await _videoController.play();
              }
            },
            child: const Text('Play video'),
          ),
        ],
      ),
    );
  }
}
