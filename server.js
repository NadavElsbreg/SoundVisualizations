// server.js - simple static server using Node's http module
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = process.env.PORT || 8080;
const root = path.resolve(__dirname);

const mime = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webm': 'video/webm',
  '.json': 'application/json'
};

http.createServer((req, res) => {
  let uri = decodeURIComponent(req.url.split('?')[0]);
  if (uri === '/') uri = '/index.html';
  const filePath = path.join(root, uri);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, {'Content-Type':'text/plain'});
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = mime[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': type });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
}).listen(port, () => {
  console.log(`Static server running at http://localhost:${port}/`);
});
