#!/usr/bin/env node
// Renders each portal's public/favicon.svg into favicon.ico (16/32/48 px, PNG-in-ICO) and
// apple-touch-icon.png (180 px) using a locally installed headless Chrome.
//
//   node scripts/build-favicons.mjs ["C:\\path\\to\\chrome.exe"]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  process.argv[2],
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chrome = candidates.find((p) => existsSync(p));
if (!chrome) throw new Error('No Chrome/Edge found — pass its path as the first argument');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'favicons-'));

function render(svg, size) {
  const html = path.join(tmp, `icon-${size}.html`);
  const png = path.join(tmp, `icon-${size}.png`);
  writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`);
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000',
    `--window-size=${size},${size}`, `--screenshot=${png}`, `file:///${html.replace(/\\/g, '/')}`,
  ], { stdio: 'ignore' });
  return readFileSync(png);
}

/** ICO container with PNG-encoded images (supported by every current browser and Windows Vista+). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

for (const app of ['user-portal', 'admin-portal']) {
  const dir = path.join(root, 'frontend', 'projects', app, 'public');
  const svg = readFileSync(path.join(dir, 'favicon.svg'), 'utf8');
  const sizes = [16, 32, 48];
  writeFileSync(path.join(dir, 'favicon.ico'), ico(sizes.map((size) => ({ size, data: render(svg, size) }))));
  writeFileSync(path.join(dir, 'apple-touch-icon.png'), render(svg, 180));
  console.log(`✔ ${app}: favicon.ico (${sizes.join('/')} px) + apple-touch-icon.png (180 px)`);
}
rmSync(tmp, { recursive: true, force: true });
