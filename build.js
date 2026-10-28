'use strict';
// Arma las páginas publicables en site/: copia el CSS/JS compartido dentro de cada HTML y agrega el esqueleto <!doctype html>.
// Uso: node build.js
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const SITE = path.join(ROOT, 'site');
const PREVIEW = path.join(ROOT, 'preview'); // versiones sin esqueleto (no se publican)

// [fuente en src/, destino dentro de site/]
const PAGES = [
  ['home.html', 'index.html'],
  ['free.html', 'sudoku/index.html'],
  ['torneo.html', 'sudoku/torneo/index.html'],
  ['admin.html', 'admin/index.html'],
  ['admin-redirect.html', 'sudoku/admin/index.html'],
  ['posiciones.html', 'sudoku/posiciones/index.html'],
  ['pomodoro.html', 'pomodoro/index.html'],
  ['poker.html', 'poker/index.html'],
  ['agenda.html', 'agenda/index.html'],
  ['calorias.html', 'calorias/index.html'],
  ['asistente.html', 'asistente/index.html'],
  ['radio.html', 'radio/index.html'],
  ['flash.html', 'flash/index.html']
];

function inline(src) {
  return src.replace(/\/\*@([\w./-]+)\*\//g, (_, f) => fs.readFileSync(path.join(SRC, f), 'utf8'));
}
// Íconos del sitio (src/static/). Si una página trae su propio apple-touch-icon, se respeta.
function icons(html) {
  let h = '<link rel="icon" href="/favicon.ico" sizes="any">\n<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">\n';
  if (!html.includes('apple-touch-icon')) h += '<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n';
  return h;
}
function wrap(html) {
  const split = html.indexOf('</style>') + '</style>'.length;
  return '<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' + icons(html) +
    html.slice(0, split) + '\n</head>\n<body>\n' + html.slice(split).trim() + '\n</body>\n</html>\n';
}

fs.rmSync(SITE, { recursive: true, force: true });
fs.rmSync(PREVIEW, { recursive: true, force: true });
for (const [src, dst] of PAGES) {
  const body = inline(fs.readFileSync(path.join(SRC, src), 'utf8'));
  const out = path.join(SITE, dst);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, wrap(body));
  fs.mkdirSync(PREVIEW, { recursive: true });
  fs.writeFileSync(path.join(PREVIEW, dst.replace(/\//g, '_')), body);
}
// Archivos tal cual (íconos, imágenes): src/static/ se copia a site/ con la misma estructura
const STATIC = path.join(SRC, 'static');
if (fs.existsSync(STATIC)) fs.cpSync(STATIC, SITE, { recursive: true });
console.log('site/ listo:', PAGES.map(p => p[1]).join(', '));
