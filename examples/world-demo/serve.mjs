// Local static server for dist/ (development only; Render serves the same files in production).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const root = resolve(import.meta.dirname, 'dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain', '.wasm': 'application/wasm' };
const port = Number(process.env.PORT ?? 8787);
createServer(async (request, response) => {
  try {
    let path = resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://x').pathname));
    if (path !== root && !path.startsWith(root + sep)) throw new Error('outside root');
    if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
    response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    response.end(await readFile(path));
  } catch { response.writeHead(404).end('not found'); }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
