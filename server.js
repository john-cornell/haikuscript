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

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/repl.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function handleBuildExe(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let il;
    try { il = JSON.parse(body).il; } catch { il = null; }
    if (!il) {
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

      // In WSL, Windows executables must be called through cmd.exe with converted paths
      const isWSL = process.platform === 'linux' && fs.existsSync('/proc/version') &&
        fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');

      if (isWSL) {
        // WSL: convert file paths (ILASM_PATH is already in Windows format) and call through cmd.exe
        const { spawnSync } = require('child_process');
        const winIlPath = spawnSync('wslpath', ['-w', ilPath]).stdout.toString().trim();
        const winExePath = spawnSync('wslpath', ['-w', exePath]).stdout.toString().trim();

        execFile('cmd.exe', ['/c', ILASM_PATH, winIlPath, '/exe', `/output:${winExePath}`],
          (ilasmErr, stdout, stderr) => {
            fs.unlink(ilPath, () => {});
            if (ilasmErr) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: stderr || stdout || ilasmErr.message }));
            }
            fs.readFile(exePath, (readErr, exeData) => {
              fs.unlink(exePath, () => {});
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
      } else {
        // Windows: direct call
        execFile(ILASM_PATH, [ilPath, '/exe', `/output:${exePath}`], (ilasmErr, stdout, stderr) => {
          fs.unlink(ilPath, () => {});
          if (ilasmErr) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: stderr || stdout || ilasmErr.message }));
          }
        fs.readFile(exePath, (readErr, exeData) => {
          fs.unlink(exePath, () => {});
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
      }
    });
  });
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/build-exe') return handleBuildExe(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405);
  res.end();
}).listen(PORT, () => {
  console.log(`HaikuScript REPL server: http://localhost:${PORT}/repl.html`);
});
