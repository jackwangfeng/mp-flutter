'use strict';
// Deterministic loopback backend for the Douyin acceptance fixture.
const http = require('http');
const fs = require('fs');
const path = require('path');
const image = fs.readFileSync(path.join(__dirname, 'apps/mpf_douyin/assets/logo.png'));
const port = Number(process.env.MPF_DOUYIN_TEST_PORT || 18883);
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (url.pathname === '/image/png') {
    res.writeHead(200, {'Content-Type':'image/png', 'Content-Length':image.length});
    res.end(image);
    return;
  }
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.from(JSON.stringify({args:Object.fromEntries(url.searchParams), data:Buffer.concat(chunks).toString('utf8')}));
    res.writeHead(200, {'Content-Type':'application/json; charset=utf-8', 'Content-Length':body.length});
    res.end(body);
  });
}).listen(port, '127.0.0.1', () => console.log('Douyin fixture backend: http://127.0.0.1:' + port));
