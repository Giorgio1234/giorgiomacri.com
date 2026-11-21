'use strict';
// Subir archivos (/subir): cualquiera puede mandar archivos, sin cuenta. Solo el admin los ve, los descarga y los borra.
//
// Los archivos se suben en partes de menos de 1 MB (así entran por el límite por defecto de Nginx, client_max_body_size 1m)
// y se guardan en FILES_DIR (por defecto /var/lib/sudoku-torneo/archivos), con un nombre al azar: el nombre original
// queda solo en la base. Nunca se sirven en público: el admin los baja con un link firmado que vence.
//
// Variables de entorno (opcionales):
//   FILES_DIR          carpeta de los archivos
//   FILES_MAX_MB       tamaño máximo por archivo (por defecto 2048)
//   FILES_QUOTA_GB     total entre todos los archivos (por defecto 20)
//   FILES_IP_DAILY_MB  cuánto puede subir una misma IP en 24 h (por defecto 4096; el admin no tiene este límite)
//   FILES_RESERVE_MB   espacio libre que siempre se deja en el disco (por defecto 3072)
//
// Rutas:
//   GET    /api/sudoku/archivos/estado                      público: si se reciben archivos y los límites
//   POST   /api/sudoku/archivos/subida                      público: { name, size, sender?, note? } -> { id, token, chunk }
//   PUT    /api/sudoku/archivos/subida/:id/:parte           público, encabezado X-Subida: cuerpo = bytes de la parte
//   POST   /api/sudoku/archivos/subida/:id/fin              público, X-Subida
//   DELETE /api/sudoku/archivos/subida/:id                  público, X-Subida: cancela una subida sin terminar
//   GET    /api/sudoku/archivos                             admin: lista, disco y límites
//   POST   /api/sudoku/archivos/admin                       admin: { action: 'open', value } | { action: 'seen' }
//   DELETE /api/sudoku/archivos/:id                         admin
//   GET    /api/sudoku/archivos/d/:id?e=&s=[&ver=1]         link firmado del admin (descarga o vista previa)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CHUNK = 960 * 1024;                 // por debajo de 1 MB (límite por defecto de Nginx)
const MB = 1024 * 1024;
const LINK_MS = 12 * 3600 * 1000;         // los links de descarga del admin valen 12 horas
const STALE_MS = 24 * 3600 * 1000;        // subidas sin terminar se borran a las 24 horas
const MAX_PENDING_PER_IP = 6;
const ID_RE = /^[0-9a-f]{20}$/;

// Tipos que se pueden ver en el navegador (el resto siempre se descarga). Nunca HTML ni SVG.
const VIEW = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', heic: '',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8'
};

module.exports = function install(d) {
  const { db, route, fail, rateLimited, requireAdmin, sessionFrom, clientIp, now, RAW, dataDir } = d;
  const DIR = process.env.FILES_DIR || path.join(dataDir, 'archivos');
  const num = (v, def) => { const x = Number(v); return isFinite(x) && x > 0 ? x : def; };
  const MAX_BYTES = Math.round(num(process.env.FILES_MAX_MB, 2048) * MB);
  const QUOTA = Math.round(num(process.env.FILES_QUOTA_GB, 20) * 1024 * MB);
  const IP_DAILY = Math.round(num(process.env.FILES_IP_DAILY_MB, 4096) * MB);
  const RESERVE = Math.round(num(process.env.FILES_RESERVE_MB, 3072) * MB);

  fs.mkdirSync(DIR, { recursive: true, mode: 0o750 });

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      sender TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      account TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      ua TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'uploading',
      parts TEXT NOT NULL DEFAULT '',
      up_hash TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      done_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS files_ip ON files(ip, created_at);
    CREATE TABLE IF NOT EXISTS files_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const meta = k => { const r = db.prepare('SELECT value FROM files_meta WHERE key = ?').get(k); return r ? r.value : null; };
  const setMeta = (k, v) => db.prepare('INSERT INTO files_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
  if (!meta('secret')) setMeta('secret', crypto.randomBytes(32).toString('hex'));
  if (meta('open') == null) setMeta('open', '1');
  const SECRET = meta('secret');
  const isOpen = () => meta('open') === '1';

  const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  const fileOf = id => path.join(DIR, id + '.bin');
  const partsOf = size => Math.max(1, Math.ceil(size / CHUNK));
  const ext = name => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(name); return m ? m[1].toLowerCase() : ''; };
  const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  function cleanName(v) {
    let n = String(v ?? '').replace(/[\u0000-\u001f\u007f/\\]/g, '_').replace(/^\.+/, '').trim();
    if (n.length > 180) { const e = ext(n); n = n.slice(0, 170 - e.length).trim() + (e ? '.' + e : ''); }
    return n || 'archivo';
  }

  function disk() {
    try { const s = fs.statfsSync(DIR); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch (e) { return { free: 0, total: 0 }; }
  }
  function used() { return db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files').get().n; }
  // Lo que falta escribir de las subidas en curso (para no prometer espacio que ya está reservado)
  function pendingBytes() {
    let n = 0;
    for (const f of db.prepare("SELECT size, parts FROM files WHERE status = 'uploading'").all()) {
      const missing = f.parts.split('').filter(c => c !== '1').length;
      n += Math.min(f.size, missing * CHUNK);
    }
    return n;
  }
  function removeFile(id) {
    try { fs.unlinkSync(fileOf(id)); } catch (e) { if (e.code !== 'ENOENT') console.error('archivos: no se pudo borrar', id, e.message); }
    db.prepare('DELETE FROM files WHERE id = ?').run(id);
  }
  function cleanup() {
    for (const f of db.prepare("SELECT id FROM files WHERE status = 'uploading' AND created_at < ?").all(now() - STALE_MS)) removeFile(f.id);
  }
  cleanup();
  setInterval(cleanup, 30 * 60 * 1000).unref();

  function adminAccount(req) { const s = sessionFrom(req); return s && s.account && s.account.is_admin ? s.account : null; }
  function account(req) { const s = sessionFrom(req); return s && s.account ? s.account : null; }

  // Subida en curso, con su token (lo tiene solo el navegador que la empezó)
  function upload(req, id) {
    if (!ID_RE.test(id)) fail(404, 'Esa subida no existe.');
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
    const t = String(req.headers['x-subida'] || '');
    if (!f || !t || sha(t) !== f.up_hash) fail(404, 'Esa subida no existe o venció. Probá de nuevo.');
    return f;
  }

  function readRaw(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > limit) { const e = new Error('Parte demasiado grande.'); e.status = 413; reject(e); req.destroy(); }
        else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  function readJson(req) {
    return readRaw(req, 8192).then(b => { if (!b.length) return {}; try { return JSON.parse(b.toString('utf8')); } catch (e) { fail(400, 'JSON inválido.'); } });
  }

  /* ---------- Público: subir ---------- */
  route('GET', '/archivos/estado', async () => ({ open: isOpen(), maxBytes: MAX_BYTES, chunk: CHUNK }));

  route('POST', '/archivos/subida', async (req) => {
    const b = await readJson(req);
    if (b.website) fail(400, 'No se pudo subir.'); // campo trampa para bots
    const admin = adminAccount(req);
    if (!isOpen() && !admin) fail(403, 'Por ahora no se están recibiendo archivos.');
    if (!admin && rateLimited(req, 'files-new', 60)) fail(429, 'Subiste muchos archivos seguidos. Esperá unos minutos.');
    const size = Number(b.size);
    if (!Number.isInteger(size) || size < 1) fail(400, 'El archivo está vacío.');
    const name = cleanName(b.name);
    if (size > MAX_BYTES) fail(413, `«${name}» pesa demasiado: el máximo es ${fmt(MAX_BYTES)}.`);
    const ip = clientIp(req);
    if (!admin) {
      const pending = db.prepare("SELECT COUNT(*) AS n FROM files WHERE ip = ? AND status = 'uploading'").get(ip).n;
      if (pending >= MAX_PENDING_PER_IP) fail(429, 'Tenés muchas subidas a medias. Esperá a que terminen.');
      const today = db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE ip = ? AND created_at > ?').get(ip, now() - 24 * 3600 * 1000).n;
      if (today + size > IP_DAILY) fail(429, `Llegaste al máximo de ${fmt(IP_DAILY)} por día. Probá mañana.`);
    }
    if (used() + size > QUOTA) fail(507, 'No hay más lugar para archivos por ahora.');
    if (disk().free - pendingBytes() - size < RESERVE) fail(507, 'No hay más lugar para archivos por ahora.');

    const id = crypto.randomBytes(10).toString('hex');
    const token = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(fileOf(id), '', { mode: 0o640 });
    const acct = account(req);
    db.prepare('INSERT INTO files (id, name, size, sender, note, account, ip, ua, parts, up_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, size, str(b.sender, 60), str(b.note, 500), acct ? acct.username : '', ip,
        String(req.headers['user-agent'] || '').slice(0, 300), '0'.repeat(partsOf(size)), sha(token), now());
    return { id, token, chunk: CHUNK, parts: partsOf(size) };
  });

  route('PUT', '/archivos/subida/([0-9a-f]+)/(\\d+)', async (req, url, m) => {
    const f = upload(req, m[1]);
    if (f.status !== 'uploading') fail(409, 'Ese archivo ya terminó de subirse.');
    const n = partsOf(f.size), i = Number(m[2]);
    if (!Number.isInteger(i) || i < 0 || i >= n) fail(400, 'Parte inválida.');
    const expected = i < n - 1 ? CHUNK : f.size - CHUNK * (n - 1);
    const buf = await readRaw(req, CHUNK);
    if (buf.length !== expected) fail(400, 'La parte llegó incompleta. Se vuelve a intentar.');
    // Puede haberse cancelado mientras llegaba
    const cur = db.prepare('SELECT parts, status FROM files WHERE id = ?').get(f.id);
    if (!cur || cur.status !== 'uploading') fail(404, 'Esa subida se canceló.');
    const fd = fs.openSync(fileOf(f.id), 'r+');
    try { fs.writeSync(fd, buf, 0, buf.length, i * CHUNK); } finally { fs.closeSync(fd); }
    const parts = cur.parts.slice(0, i) + '1' + cur.parts.slice(i + 1);
    db.prepare('UPDATE files SET parts = ? WHERE id = ?').run(parts, f.id);
    return { ok: true };
  });

  route('POST', '/archivos/subida/([0-9a-f]+)/fin', async (req, url, m) => {
    const f = upload(req, m[1]);
    if (f.status === 'ready') return { ok: true };
    const missing = [];
    for (let i = 0; i < f.parts.length; i++) if (f.parts[i] !== '1') missing.push(i);
    if (missing.length) return { ok: false, missing: missing.slice(0, 200) };
    let size = -1; try { size = fs.statSync(fileOf(f.id)).size; } catch (e) {}
    if (size !== f.size) { removeFile(f.id); fail(500, 'El archivo llegó dañado. Subilo de nuevo.'); }
    db.prepare("UPDATE files SET status = 'ready', up_hash = '', done_at = ? WHERE id = ?").run(now(), f.id);
    return { ok: true };
  });

  route('DELETE', '/archivos/subida/([0-9a-f]+)', async (req, url, m) => {
    const f = upload(req, m[1]);
    if (f.status === 'uploading') removeFile(f.id);
    return { ok: true };
  });

  /* ---------- Admin ---------- */
  const sign = (id, e) => crypto.createHmac('sha256', SECRET).update(id + '.' + e).digest('base64url');
  function links(id) {
    const e = now() + LINK_MS, s = sign(id, e), base = `/api/sudoku/archivos/d/${id}?e=${e}&s=${s}`;
    return { url: base, view: base + '&ver=1' };
  }

  route('GET', '/archivos', async (req) => {
    requireAdmin(req);
    const rows = db.prepare("SELECT id, name, size, sender, note, account, ip, created_at, done_at FROM files WHERE status = 'ready' ORDER BY done_at DESC").all();
    const uploading = db.prepare("SELECT COUNT(*) AS n FROM files WHERE status = 'uploading'").get().n;
    return {
      files: rows.map(r => Object.assign(r, links(r.id), { viewable: !!VIEW[ext(r.name)] })),
      uploading, used: used(), disk: disk(), open: isOpen(),
      limits: { maxBytes: MAX_BYTES, quota: QUOTA, ipDaily: IP_DAILY, reserve: RESERVE },
      lastSeen: Number(meta('seen') || 0)
    };
  });

  route('POST', '/archivos/admin', async (req) => {
    requireAdmin(req);
    const b = await readJson(req);
    if (b.action === 'open') { setMeta('open', b.value ? '1' : '0'); return { open: isOpen() }; }
    if (b.action === 'seen') { setMeta('seen', now()); return { ok: true }; }
    fail(400, 'Acción desconocida.');
  });

  route('DELETE', '/archivos/([0-9a-f]+)', async (req, url, m) => {
    requireAdmin(req);
    if (!ID_RE.test(m[1]) || !db.prepare('SELECT 1 FROM files WHERE id = ?').get(m[1])) fail(404, 'Ese archivo ya no existe.');
    removeFile(m[1]);
    return { ok: true };
  });

  // Descarga con link firmado (los links se piden con la cuenta de admin; un <a href> no puede mandar el token)
  route('GET', '/archivos/d/([0-9a-f]+)', async (req, url, m, res) => {
    const id = m[1], e = Number(url.searchParams.get('e')), s = String(url.searchParams.get('s') || '');
    const good = sign(id, e);
    if (!ID_RE.test(id) || !e || e < now() || s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) {
      fail(403, 'El link venció. Volvé a abrir la lista de archivos.');
    }
    const f = db.prepare("SELECT * FROM files WHERE id = ? AND status = 'ready'").get(id);
    if (!f) fail(404, 'Ese archivo ya no existe.');
    let st; try { st = fs.statSync(fileOf(id)); } catch (err) { fail(404, 'Ese archivo ya no está en el disco.'); }

    const type = VIEW[ext(f.name)];
    const inline = url.searchParams.get('ver') === '1' && !!type;
    const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', inline ? type : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // El visor de PDF de Chrome no anda con "sandbox"; para lo demás, nada del archivo puede correr código
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'" + (type === 'application/pdf' && inline ? '' : '; sandbox'));
    res.setHeader('Accept-Ranges', 'bytes');

    // Rangos (para adelantar videos y retomar descargas)
    let start = 0, end = st.size - 1;
    const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (r && (r[1] || r[2])) {
      if (r[1]) { start = +r[1]; if (r[2]) end = Math.min(+r[2], st.size - 1); }
      else { start = Math.max(0, st.size - +r[2]); }
      if (start > end || start >= st.size) {
        res.statusCode = 416; res.setHeader('Content-Range', `bytes */${st.size}`); res.end(); return RAW;
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    }
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') { res.end(); return RAW; }
    const stream = fs.createReadStream(fileOf(id), { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return RAW;
  });

  function fmt(n) {
    if (n >= 1024 * MB) return (n / 1024 / MB).toFixed(n % (1024 * MB) ? 1 : 0).replace('.', ',') + ' GB';
    return Math.round(n / MB) + ' MB';
  }
};
