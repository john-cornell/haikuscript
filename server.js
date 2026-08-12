// Static file server for the HaikuScript REPL, plus one POST route that
// shells out to ilasm.exe to build a real .exe from generated IL text.
// Zero npm dependencies — Node built-ins only.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const ILASM_PATH = process.env.ILASM_PATH ||
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\ilasm.exe';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.hk': 'text/plain', '.md': 'text/plain',
  '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.ico': 'image/x-icon'
};

function sendFile(res, filePath, onMissing) {
  fs.readFile(filePath, (err, data) => {
    if (err) return onMissing();
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function notFound(res) { res.writeHead(404); res.end('Not found'); }

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) { res.writeHead(403); return res.end(); }
  sendFile(res, filePath, () => {
    // The `serve` package this replaced answered extensionless "clean URLs"
    // (/repl -> repl.html) and 301'd /repl.html to /repl. Browsers cache 301s
    // indefinitely, so anyone who ran the old setup still gets silently sent
    // to /repl — resolve those here instead of 404ing on a correct link.
    if (path.extname(filePath)) return notFound(res);
    sendFile(res, filePath + '.html', () => notFound(res));
  });
}

function handleBuildExe(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let il;
    try { il = JSON.parse(body).il; } catch { il = null; }
    if (typeof il !== 'string' || !il) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing "il" in request body' }));
    }

    const id = crypto.randomBytes(6).toString('hex');
    const tmpDir = os.tmpdir();
    const ilPath = path.join(tmpDir, `haiku-${id}.il`);
    const exePath = path.join(tmpDir, `haiku-${id}.exe`);

    fs.writeFile(ilPath, il, (writeErr) => {
      if (writeErr) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: writeErr.message }));
      }

      execFile(ILASM_PATH, [ilPath, '/exe', `/output:${exePath}`], (ilasmErr, stdout, stderr) => {
        fs.unlink(ilPath, () => {});
        if (ilasmErr) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: stderr || stdout || ilasmErr.message }));
        }
        fs.readFile(exePath, (readErr, exeData) => {
          fs.unlink(exePath, () => {});
          fs.unlink(exePath.replace(/\.exe$/, '.pdb'), () => {});
          if (readErr) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: readErr.message }));
          }
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="HaikuProgram.exe"'
          });
          res.end(exeData);
        });
      });
    });
  });
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/build-exe') return handleBuildExe(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405);
  res.end();
}).listen(PORT, '127.0.0.1', () => {
  console.log(`HaikuScript REPL server: http://localhost:${PORT}/repl.html`);
});
