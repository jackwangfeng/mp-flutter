# `drive.js` — WeChat DevTools E2E driver

This directory ships inside the `flutter_miniprogram` pub package (`tool/e2e/`)
so consumers of the package can drive the same WeChat DevTools CLI automation
used internally to build `flutter_miniprogram` itself, against *their own*
compiled Mini Program output.

It wraps [`miniprogram-automator`](https://www.npmjs.com/package/miniprogram-automator)
with cold-start handling, a couple of DevTools-CLI-version workarounds, and a
small telemetry-collection convention (see "Known flakes / cold-start notes"
below).

## Locating this directory

If you depend on `flutter_miniprogram` as a `dev_dependency`, the CLI can
print you the absolute path to this directory:

```bash
DIR=$(dart run flutter_miniprogram e2e-driver)
echo "$DIR"   # .../flutter_miniprogram-<version>/tool/e2e
```

## Installing dependencies — **copy first, then `npm install`**

`DIR` above points *inside pub's package cache* (e.g.
`~/.pub-cache/hosted/pub.dev/flutter_miniprogram-0.3.1/tool/e2e`, or the
analogous `.dart_tool` cache location). That cache is shared/read-only-ish
and reused across every project on the machine that depends on this package
version — do **not** run `npm install` directly inside it: you'd be writing
`node_modules` into a shared cache directory, which is at best surprising and
at worst gets silently wiped the next time pub repairs its cache.

Instead, copy the directory out to your own project and install there:

```bash
DIR=$(dart run flutter_miniprogram e2e-driver)
cp -R "$DIR" ./mp-e2e
(cd mp-e2e && npm install)
```

If you'd rather not copy, you can instead point `NODE_PATH` at a
`node_modules` directory elsewhere that already has `miniprogram-automator`
installed (`drive.js` resolves the dependency lazily: plain `require()` from
its own location first, then from your process's current working directory,
then from `NODE_PATH`) — but copying is the path this README's recipe and the
root README's recipe both assume, and it keeps your install out of pub's
cache.

## Minimal usage

```js
const { runE2E } = require('./mp-e2e/drive.js');

async function main() {
  const result = await runE2E({
    // Required: absolute path to the Mini Program project directory you
    // built with `dart run flutter_miniprogram --verify ...` (the --verify
    // flag is what makes the host page buffer telemetry for assertions).
    projectPath: '/absolute/path/to/build/weapp',

    // Optional: entry page path without the leading slash.
    // Default: 'pages/flutter/flutter'.
    entryPage: 'pages/flutter/flutter',

    // Optional: how long to wait after reLaunch for the engine's first
    // frame before running `interact` (ms). Default: 12000.
    bootMs: 12000,

    // Optional: drive clicks/drags/text input once the first frame is up.
    // Called with (mp, page, log) — `mp` is the raw miniprogram-automator
    // Miniprogram handle, `page` is a stale-handle-retrying wrapper around
    // the current page, `log` appends a line to the returned `lines` array.
    async interact(mp, page, log) {
      const el = await page.$('#some-button');
      await el.tap();
      log('[interact] tapped #some-button');
    },

    // Optional: how long to wait after `interact` (or after boot, if no
    // `interact`) before collecting buffered telemetry (ms). Default: 30000.
    settleMs: 15000,
  });

  // result.lines       — every collected line, console output interleaved
  //                       with [AUTOMATOR]/[EXCEPTION]/[verify] diagnostics,
  //                       in chronological order. Good for printing on
  //                       failure.
  // result.verifyLines — only the lines buffered on `getApp().__mpVerify`
  //                       by the --verify build (no [prefix], the one
  //                       trustworthy source — see notes below).
  // result.steps       — verifyLines whose payload started with `STEP|`,
  //                       prefix stripped.
  // result.touchedApis — same, for `TOUCH|`.
  // result.pixels       — same, for `PIXEL|`.
  // result.states       — same, for `STATE|`.
  // result.errors       — same, for `ERROR|` (console.error calls captured
  //                       by the --verify build inside this App instance).
  if (result.errors.length) {
    console.error('errors during run:', result.errors);
    process.exitCode = 1;
  }
  console.log('states:', result.states);
}

main();
```

See `tools/e2e/accept.js` and friends in the main repository
(https://github.com/jackwangfeng/mp-flutter/tree/main/tools/e2e) for complete,
real assertion scripts built on top of `runE2E`.

## Prerequisites

- WeChat DevTools installed and **already logged in** (the CLI can only drive
  an already-authenticated instance). `drive.js` hardcodes the CLI path
  `/Applications/wechatwebdevtools.app/Contents/MacOS/cli` (macOS). DevTools'
  "service port" (Settings → Security → enable service port) must be on for
  `miniprogram-automator` to connect.
- Node ≥ 18.
- `miniprogram-automator` installed somewhere `drive.js` can find it — see
  "Installing dependencies" above.

## Known flakes / cold-start notes

These are carried over verbatim (summarized) from the comments at the top of
`drive.js` — read the source for the full detail if you hit one of these:

- **Cold start / stale console replay**: reconnecting DevTools to the same
  project path can replay the *previous* run's console history into the new
  connection, which could satisfy this run's assertions on stale data.
  `drive.js` force-closes the project once before `launch` so the run starts
  cold, and only trusts telemetry buffered on `getApp().__mpVerify` for the
  *current* App instance (`result.verifyLines` / `result.states` / etc.) —
  `result.lines` (console) is for diagnostics only, never for assertions.
- **Unhandled `'error'` events / rejections from automator timeouts**:
  DevTools occasionally pushes an id-less `{method:"error"}` message (e.g.
  "timeout waiting for automator response") when the JS thread is busy on
  first compile. Left unhandled, Node would crash the whole process.
  `drive.js` patches `Connection.prototype.emit` and installs an
  `unhandledRejection` handler that swallow *only* that specific timeout
  message (anything else still throws/crashes normally), recording it into
  `result.lines` as `[AUTOMATOR] ...` instead.
- **`page.callMethod` can be broken by the server-pushed base library
  version**: when the WeChat account's base library policy is bumped
  server-side (independent of `project.config.json`'s pinned `libVersion`),
  the `Page.callMethod` RPC specifically can stop working while
  `Page.getData`/`App.getCurrentPage`/`App.callFunction` keep working fine.
  `drive.js`'s page wrapper routes `callMethod` through `mp.evaluate()` +
  `getCurrentPages()` instead of the native RPC, so interaction scripts are
  unaffected by this class of breakage.
- **Stale element/page handles right after cold start**: object handles
  (`objectId`) can briefly go invalid in the first moments after a cold
  launch. `drive.js` wraps pages/elements in a Proxy that, on
  `No context found for objectId ...`, re-acquires the handle once
  (`mp.currentPage()` or the original selector's `page.$()`) and retries —
  any other error is rethrown unchanged.

None of the above require anything from your own project; they're
DevTools/automator environment quirks `drive.js` already works around.
