const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createInputTiming } = require('../../packages/mp_flutter/runtime/input-timing.js');

function fakeCK() {
  function PB() {} PB.prototype.addText = function (t) { this.t = t; return 'added'; };
  function S() {} S.prototype.flush = function () { return 'flushed'; };
  return { ParagraphBuilder: PB, Surface: S };
}

test('native-input → paint(addText 出现输入文字)→ flush → next-frame,带完整 detail 与 lag', () => {
  const lines = [];
  const CK = fakeCK();
  const rafs = [];
  let focusCb = null;
  const shim = { onFocusChange: (cb) => { focusCb = cb; return () => { focusCb = null; }; } };
  const t = createInputTiming({ log: (l) => lines.push(l), CK, shim, raf: (cb) => rafs.push(cb) });
  focusCb({ tagName: 'INPUT' });
  t.touch({ type: 'touchstart', touches: [{}], timeStamp: Date.now() - 1000 });
  t.nativeInput({ detail: { value: 'ab你', cursor: 3, keyCode: 229 }, timeStamp: Date.now() - 1000 });
  const tIn = Date.now();
  t.engineIn(tIn, true);
  new CK.ParagraphBuilder().addText('无关');
  assert.strictEqual(new CK.ParagraphBuilder().addText('ab你'), 'added');
  assert.strictEqual(new CK.Surface().flush(), 'flushed');
  rafs.forEach((cb) => cb());
  const names = lines.map((l) => l.split(' ')[2]);
  assert.deepStrictEqual(names, ['engine-focus', 'touchstart', 'native-input', 'engine-in', 'paint', 'flush', 'next-frame']);
  assert.ok(lines.every((l) => l.startsWith('[mp-t] ')));
  assert.match(lines[0], /editable=true/);
  assert.match(lines[2], /detail=\{"value":"ab你","cursor":3,"keyCode":229\} ts=\d+ lag≈\d+ms/);
  t.stop();
  assert.strictEqual(focusCb, null);
  lines.length = 0;
  new CK.ParagraphBuilder().addText('x');
  assert.strictEqual(lines.length, 0, 'stop 后不再包装');
});

test('被桥丢弃的输入不等上屏;setData 打 keys/value 与回调耗时', () => {
  const lines = [];
  const CK = fakeCK();
  const t = createInputTiming({ log: (l) => lines.push(l), CK });
  t.nativeInput({ detail: { value: '' } });
  t.engineIn(Date.now(), false);
  new CK.ParagraphBuilder().addText('anything');
  assert.ok(!lines.some((l) => / paint /.test(l)));
  const h = t.setData({ 'mpInput.visible': true, 'mpInput.value': 'a' });
  h.sent(); h.done();
  assert.ok(lines.some((l) => /setData \["visible","value"\] value="a"/.test(l)));
  assert.ok(lines.some((l) => /setData-done \+\d+ms/.test(l)));
});
