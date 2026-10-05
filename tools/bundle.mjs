#!/usr/bin/env node
// Inlines the stylesheet and scripts referenced by index.html into one
// self-contained HTML file.
//
//   node tools/bundle.mjs [out=dist/iran-1902-war-map.html] [--fragment]
//
// --fragment drops the <!doctype>/<html>/<head>/<body> wrapper, for hosts
// that supply their own document skeleton.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const fragment = args.includes('--fragment');
const out = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'dist', 'iran-1902-war-map.html'));

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="(css\/[^"]+)">/g, (_, href) =>
  `<style>\n${fs.readFileSync(path.join(ROOT, href), 'utf8')}</style>`);
html = html.replace(/<script src="(js\/[^"]+)"><\/script>/g, (_, src) =>
  // "</script" inside data would end the tag early; escape it defensively.
  `<script>\n${fs.readFileSync(path.join(ROOT, src), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`);

if (fragment) {
  const head = html.match(/<head>([\s\S]*?)<\/head>/)[1]
    .replace(/<meta charset[^>]*>\s*/, '')
    .replace(/<meta name="viewport"[^>]*>\s*/, '');
  const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
  html = head.trim() + '\n' + body.trim() + '\n';
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`${out}: ${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB`);
