'use strict';
// Matense Awards · votación de los premios (/awards/votar).
// - Votan las personas del amigo invisible (el último sorteo): eligen quiénes son y entran con el mismo PIN.
//   Si alguien todavía no tenía PIN, lo elige acá y le sirve también para el amigo invisible.
// - Las categorías NO están en el código (el repo es público): el admin las pega desde el Excel en /awards/votar/admin/.
//   Tipos: "person" (se vota a alguien del grupo, no a uno mismo), "text" (se escribe una anécdota),
//   "person_text" (persona + anécdota opcional) y "option" (opciones fijas, ej. las duplas).
// - Cada uno puede cambiar sus votos mientras la votación esté abierta. Solo el admin ve los resultados, y nunca
//   quién votó a quién.
// Rutas (bajo /api/sudoku): GET /awards/votar · POST /awards/votar/entrar · POST /awards/votar/voto
//   · GET /awards/votar/resultados (admin) · POST /awards/votar/admin (admin)

const crypto = require('crypto');

const MAX_TEXT = 1000, MAX_TITLE = 120, MAX_DESC = 400, MAX_CATS = 80;

module.exports = function install(d) {
  const { db, route, fail, readBody, rateLimited, requireAdmin, now } = d;

  db.exec(`
    CREATE TABLE IF NOT EXISTS vt_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS vt_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pos INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]', final INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS vt_votes (
      voter_id INTEGER NOT NULL, category_id INTEGER NOT NULL, choice TEXT, text TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL, PRIMARY KEY (voter_id, category_id));
    -- Por si todavía no se armó el amigo invisible (la tabla la crea amigo.js)
    CREATE TABLE IF NOT EXISTS ai_draws (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, budget TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, drawn_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_people (
      id INTEGER PRIMARY KEY AUTOINCREMENT, draw_id INTEGER NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL,
      pin_hash TEXT, target_id INTEGER, wishes TEXT NOT NULL DEFAULT '', claimed_at INTEGER, seen_at INTEGER,
      UNIQUE (draw_id, name_key));
  `);

  const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const text = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
  const int = v => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };
  const meta = k => (db.prepare('SELECT value FROM vt_meta WHERE key = ?').get(k) || {}).value;
  const setMeta = (k, v) => db.prepare('INSERT INTO vt_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
  let secret = meta('secret');
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); setMeta('secret', secret); }
  const isOpen = () => meta('open') !== '0';
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  }

  /* ---------- Quiénes votan: la gente del amigo invisible ---------- */
  const draw = () => db.prepare('SELECT id FROM ai_draws ORDER BY id DESC LIMIT 1').get() || null;
  const people = () => { const d0 = draw(); return d0 ? db.prepare('SELECT id, name FROM ai_people WHERE draw_id = ? ORDER BY name COLLATE NOCASE').all(d0.id) : []; };
  const hashPin = pin => { const salt = crypto.randomBytes(12).toString('hex'); return salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex'); };
  const checkPin = (pin, stored) => {
    const [salt, h] = String(stored).split(':');
    const a = crypto.scryptSync(pin, salt, 32), b = Buffer.from(h || '', 'hex');
    return b.length === a.length && crypto.timingSafeEqual(a, b);
  };
  const tokenFor = p => p.id + '.' + crypto.createHmac('sha256', secret).update(p.id + ':' + p.draw_id + ':' + p.pin_hash).digest('hex').slice(0, 40);
  function voterFrom(req) {
    const tok = String(req.headers['x-votar'] || ''), id = int(tok.split('.')[0]);
    if (!id) return null;
    const p = db.prepare('SELECT * FROM ai_people WHERE id = ?').get(id), d0 = draw();
    if (!p || !p.pin_hash || !d0 || p.draw_id !== d0.id) return null;
    const want = tokenFor(p);
    return want.length === tok.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(tok)) ? p : null;
  }

  /* ---------- Categorías ---------- */
  const catRow = c => ({ id: c.id, pos: c.pos, title: c.title, description: c.description, kind: c.kind, options: JSON.parse(c.options), final: !!c.final });
  const categories = () => db.prepare('SELECT * FROM vt_categories ORDER BY final, pos, id').all().map(catRow);

  // Interpreta las filas pegadas desde el Excel (columnas: número, nombre, explicación, se vota) o un JSON.
  function parseImport(raw) {
    raw = String(raw ?? '').trim();
    if (!raw) fail(400, 'Pegá las categorías.');
    let rows;
    if (raw[0] === '[') {
      try { rows = JSON.parse(raw); } catch (e) { fail(400, 'El JSON no es válido.'); }
      rows = rows.map(r => [r.numero ?? r.pos ?? '', r.titulo ?? r.title ?? r.nombre ?? '', r.explicacion ?? r.description ?? '', r.tipo ?? r.kind ?? r.se_vota ?? 'persona', r.opciones ?? r.options]);
    } else {
      rows = raw.split(/\r?\n/).map(l => l.split('\t'));
      if (rows.every(r => r.length < 2)) rows = raw.split(/\r?\n/).map(l => l.split(';')); // por si viene separado con punto y coma
    }
    const out = [];
    rows.forEach((r, i) => {
      const [num, title0, desc0, how0, opts0] = r.map(x => (typeof x === 'string' ? x.trim().replace(/^"|"$/g, '') : x));
      const title = str(title0, MAX_TITLE);
      if (!title) return;
      if (i === 0 && /premio|nombre/i.test(String(title0)) && !/^\d+$/.test(String(num || ''))) return; // encabezado
      const how = String(how0 || 'persona').toLowerCase();
      const desc = str(desc0, MAX_DESC);
      let kind = 'person', options = [];
      if (/dupla|^opciones/.test(how)) {
        kind = 'option';
        options = Array.isArray(opts0) ? opts0.map(o => str(o, 60)).filter(Boolean)
          : desc.split(/\s+/).filter(t => t.includes('/')).map(t => t.split('/').filter(Boolean).join(' y '));
        if (options.length < 2) fail(400, '«' + title + '»: no encontré las opciones (escribilas en la explicación, por ejemplo "Beli/Pepe Chiqui/Poda").');
      } else if (/an[eé]cdota|texto/.test(how)) kind = /persona/.test(how) ? 'person_text' : 'text';
      out.push({ pos: /^\d+$/.test(String(num || '')) ? Number(num) : out.length + 1, title, description: kind === 'option' ? '' : desc, kind, options });
    });
    if (!out.length) fail(400, 'No encontré ninguna categoría.');
    if (out.length > MAX_CATS) fail(400, 'Máximo ' + MAX_CATS + ' categorías.');
    return out;
  }

  /* ---------- Público ---------- */
  route('GET', '/awards/votar', async (req) => {
    const p = voterFrom(req), cats = categories(), ppl = people();
    const done = db.prepare('SELECT voter_id, COUNT(*) n FROM vt_votes GROUP BY voter_id').all();
    const total = cats.length;
    const out = {
      open: isOpen(), categories: cats, people: ppl.map(x => ({ id: x.id, name: x.name })),
      finished: total ? done.filter(x => x.n >= total && ppl.some(q => q.id === x.voter_id)).length : 0,
      claimed: ppl.length ? db.prepare('SELECT id FROM ai_people WHERE draw_id = ? AND pin_hash IS NOT NULL').all(draw().id).map(r => r.id) : [],
      me: null,
    };
    if (p) {
      const votes = {};
      db.prepare('SELECT category_id, choice, text FROM vt_votes WHERE voter_id = ?').all(p.id).forEach(v => { votes[v.category_id] = { choice: v.choice, text: v.text }; });
      out.me = { id: p.id, name: p.name, votes };
    }
    return out;
  });

  route('POST', '/awards/votar/entrar', async (req) => {
    if (rateLimited(req, 'votar-login', 30)) fail(429, 'Demasiados intentos. Esperá unos minutos.');
    const b = await readBody(req, 1024), d0 = draw();
    if (!d0) fail(404, 'Todavía no hay lista de personas (se toma del amigo invisible).');
    const p = db.prepare('SELECT * FROM ai_people WHERE id = ? AND draw_id = ?').get(int(b.id), d0.id);
    if (!p) fail(404, 'Ese nombre no está en la lista.');
    const pin = String(b.pin ?? '').trim();
    if (!/^\d{4,8}$/.test(pin)) fail(400, 'El PIN tiene que ser de 4 a 8 números.');
    if (p.pin_hash) {
      if (!checkPin(pin, p.pin_hash)) fail(401, 'PIN incorrecto. Es el mismo del amigo invisible.');
    } else {
      tx(() => db.prepare('UPDATE ai_people SET pin_hash = ?, claimed_at = ? WHERE id = ? AND pin_hash IS NULL').run(hashPin(pin), now(), p.id));
    }
    const fresh = db.prepare('SELECT * FROM ai_people WHERE id = ?').get(p.id);
    if (!checkPin(pin, fresh.pin_hash)) fail(409, 'Alguien entró con este nombre recién. Probá de nuevo.');
    return { token: tokenFor(fresh), name: fresh.name };
  });

  route('POST', '/awards/votar/voto', async (req) => {
    if (rateLimited(req, 'votar-voto', 600)) fail(429, 'Demasiados votos seguidos. Esperá unos minutos.');
    const p = voterFrom(req);
    if (!p) fail(401, 'Entrá de nuevo con tu nombre y PIN.');
    if (!isOpen()) fail(409, 'La votación está cerrada.');
    const b = await readBody(req, 8192);
    const c0 = db.prepare('SELECT * FROM vt_categories WHERE id = ?').get(int(b.category_id));
    if (!c0) fail(404, 'Ese premio ya no existe.');
    const c = catRow(c0);
    if (b.clear) { db.prepare('DELETE FROM vt_votes WHERE voter_id = ? AND category_id = ?').run(p.id, c.id); return { ok: true }; }
    let choice = null;
    const t = text(b.text, MAX_TEXT);
    if (c.kind === 'person' || c.kind === 'person_text') {
      const id = int(b.choice);
      if (!people().some(x => x.id === id)) fail(400, 'Elegí a alguien.');
      if (id === p.id) fail(400, 'No te podés votar a vos mismo.');
      choice = String(id);
    } else if (c.kind === 'option') {
      const i = int(b.choice);
      if (!(i >= 0 && i < c.options.length)) fail(400, 'Elegí una opción.');
      choice = String(i);
    } else if (!t) fail(400, 'Escribí tu anécdota.');
    db.prepare(`INSERT INTO vt_votes (voter_id, category_id, choice, text, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(voter_id, category_id) DO UPDATE SET choice = excluded.choice, text = excluded.text, updated_at = excluded.updated_at`)
      .run(p.id, c.id, choice, c.kind === 'person' || c.kind === 'option' ? '' : t, now());
    return { ok: true };
  });

  /* ---------- Admin ---------- */
  // Resultados: conteo por premio y anécdotas sin autor. Nunca se muestra quién votó a quién.
  route('GET', '/awards/votar/resultados', async (req) => {
    requireAdmin(req);
    const ppl = people(), name = new Map(ppl.map(x => [String(x.id), x.name])), cats = categories();
    const votes = db.prepare('SELECT * FROM vt_votes').all();
    const results = cats.map(c => {
      const vs = votes.filter(v => v.category_id === c.id && (c.kind === 'text' || name.has(String(v.voter_id))));
      const counts = new Map();
      vs.forEach(v => { if (v.choice != null) counts.set(v.choice, (counts.get(v.choice) || 0) + 1); });
      const label = ch => (c.kind === 'option' ? c.options[Number(ch)] : name.get(ch)) || '?';
      const tally = [...counts.entries()].map(([ch, n]) => ({ label: label(ch), votes: n })).sort((a, b) => b.votes - a.votes || a.label.localeCompare(b.label));
      const texts = vs.filter(v => v.text).sort((a, b) => a.updated_at - b.updated_at)
        .map(v => ({ text: v.text, about: v.choice != null && c.kind === 'person_text' ? label(v.choice) : null }));
      return { id: c.id, title: c.title, kind: c.kind, final: c.final, total: vs.length, tally, texts };
    });
    const per = new Map(); votes.forEach(v => per.set(v.voter_id, (per.get(v.voter_id) || 0) + 1));
    return { open: isOpen(), categories: cats.length, voters: ppl.map(x => ({ id: x.id, name: x.name, votes: per.get(x.id) || 0 })), results };
  });

  const ACTIONS = {
    import(b) {
      const rows = parseImport(b.rows);
      const hasVotes = db.prepare('SELECT COUNT(*) n FROM vt_votes').get().n;
      if (hasVotes && !b.force) fail(409, 'Ya hay ' + hasVotes + ' votos. Si importás de nuevo se borran todos.');
      db.prepare('DELETE FROM vt_votes').run();
      db.prepare('DELETE FROM vt_categories').run();
      const ins = db.prepare('INSERT INTO vt_categories (pos, title, description, kind, options, final) VALUES (?, ?, ?, ?, ?, ?)');
      rows.forEach(r => ins.run(r.pos, r.title, r.description, r.kind, JSON.stringify(r.options), 0));
      return { imported: rows.length };
    },
    edit(b) {
      const c = db.prepare('SELECT * FROM vt_categories WHERE id = ?').get(int(b.id));
      if (!c) fail(404, 'Ese premio no existe.');
      db.prepare('UPDATE vt_categories SET title = ?, description = ? WHERE id = ?').run(str(b.title, MAX_TITLE) || c.title, str(b.description, MAX_DESC), c.id);
    },
    remove(b) {
      const c = db.prepare('SELECT * FROM vt_categories WHERE id = ?').get(int(b.id));
      if (!c) fail(404, 'Ese premio no existe.');
      db.prepare('DELETE FROM vt_votes WHERE category_id = ?').run(c.id);
      db.prepare('DELETE FROM vt_categories WHERE id = ?').run(c.id);
    },
    open(b) { setMeta('open', b.open ? '1' : '0'); },
  };
  route('POST', '/awards/votar/admin', async (req) => {
    requireAdmin(req);
    const b = await readBody(req, 65536);
    const fn = ACTIONS[b.action];
    if (!fn) fail(400, 'Acción desconocida.');
    return tx(() => fn(b)) || { ok: true };
  });
};
