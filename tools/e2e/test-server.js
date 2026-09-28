'use strict';
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// Phase 5 Task 4:验收工程的 MpVideo 需要一个真实可请求的 <video src>。用
// ffmpeg 预生成、提交进仓库的一个极小 mp4(见本文件 startServer 里的
// /media/tiny.mp4 路由头注释)——不在测试运行时现生成,机器没装 ffmpeg 也不
// 影响 E2E。
const TINY_MP4_PATH = path.join(__dirname, 'fixtures/tiny.mp4');

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function solidPng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8 位 RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function startServer({ port }) {
  let token = 'init';
  const red = solidPng(64, 64, [255, 0, 0]);
  // http.Server#close() 只停止接受新连接,回调要等所有已建立的连接都关闭才
  // 触发——keep-alive 连接(WeChat 开发者工具的 wx.request 可能复用长连接)
  // 不会自己断,`await server.close()` 会无限期挂住(2026-09-27 实测:
  // accept-net.js 卡在这里近 4 小时,run.sh 也跟着挂死,详见 run.sh 的
  // per-script 超时兜底)。这里手动记录每个连接的 socket,close() 时强制销毁,
  // 不等它们"自然"断开。
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const body = [];
    req.on('data', (d) => body.push(d));
    req.on('end', () => {
      const u = req.url.split('?')[0];
      if (u === '/api/hello') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ msg: '你好😀', n: 1 })); }
      else if (u === '/api/echo') { res.writeHead(200, { 'X-Method': req.method, 'X-Auth': req.headers.authorization || '', 'Content-Type': 'application/octet-stream' }); res.end(Buffer.concat(body)); }
      else if (u === '/api/404') { res.writeHead(404); res.end('nope'); }
      else if (u === '/api/slow') { setTimeout(() => { res.writeHead(200); res.end('slow'); }, 3000); }
      else if (u === '/img/red.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(red); }
      // Phase 5 Task 4:MpVideo 验收用的一个真实 mp4(见 tools/e2e/fixtures/tiny.mp4,
      // ffmpeg 预生成的 1 秒纯色小视频,提交进仓库,不依赖运行 E2E 的机器装没装 ffmpeg)。
      else if (u === '/media/tiny.mp4') {
        try {
          const buf = fs.readFileSync(TINY_MP4_PATH);
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length });
          res.end(buf);
        } catch (e) { res.writeHead(404); res.end(); }
      }
      else if (u === '/token') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(token); }
      // Phase 4:模拟业务后端。真实后端这里要用 code 调用微信 code2Session
      // 换 openid/session_key(需要 AppSecret);这里只做最小可用的假实现,
      // 让 E2E 能断言"code 被送到了后端并换回了点什么"。
      else if (u === '/api/wx/login') {
        const code = new URLSearchParams(req.url.split('?')[1] || '').get('code') || '';
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ openid: 'mock-' + code.slice(0, 6), ok: true }));
      }
      // 模拟业务后端"统一下单"返回的支付参数;paySign 故意无效——开发者工具会
      // 以 fail 结束 wx.requestPayment,用于验证失败路径可诊断、不挂起。
      else if (u === '/api/wx/prepay') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          timeStamp: '1700000000', nonceStr: 'mock', package: 'prepay_id=mock', signType: 'RSA', paySign: 'invalid',
        }));
      }
      else { res.writeHead(404); res.end(); }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () =>
    resolve({
      close: () => new Promise((r) => {
        server.close(r);
        // close() 的回调等全部连接关闭才触发;不等,直接把当前所有连接砸断。
        for (const s of sockets) s.destroy();
      }),
      setToken: (t) => { token = t; },
    })));
}

module.exports = { startServer, solidPng };
