'use strict';
// Amigo invisible: el sorteo lo hace el servidor y nadie ve el resultado completo (tampoco el admin).
// Cada participante toca su nombre, elige un PIN la primera vez y ve solo a quién le regala. Puede dejar ideas para
// su regalo, que ve únicamente quien le tiene que regalar.
// El sorteo es un solo ciclo al azar (A→B→C→…→A): nadie se regala a sí mismo y no hay parejas que se regalen entre sí.
// Rutas (bajo /api/sudoku): GET /amigo · POST /amigo/entrar · POST /amigo/visto · POST /amigo/ideas · POST /amigo/admin

const crypto = require('crypto');

const MAX_NAME = 40, MAX_PEOPLE = 60, MAX_WISHES = 600;

module.exports = function install(d) {
  const { db, route, fail, readBody, rateLimited, requireAdmin, now } = d;

  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
  const keyOf = n => n.toLocaleLowerCase('es').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const int = v => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };

  let secret = (db.prepare("SELECT value FROM ai_meta WHERE key = 'secret'").get() || {}).value;
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); db.prepare("INSERT INTO ai_meta (key, value) VALUES ('secret', ?)").run(secret); }

  const current = () => db.prepare('SELECT * FROM ai_draws ORDER BY id DESC LIMIT 1').get() || null;
  const hashPin = pin => { const salt = crypto.randomBytes(12).toString('hex'); return salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex'); };
  const checkPin = (pin, stored) => {
    const [salt, h] = String(stored).split(':');
    const a = crypto.scryptSync(pin, salt, 32), b = Buffer.from(h || '', 'hex');
    return b.length === a.length && crypto.timingSafeEqual(a, b);
  };
  const tokenFor = p => p.id + '.' + crypto.createHmac('sha256', secret).update(p.id + ':' + p.draw_id + ':' + p.pin_hash).digest('hex').slice(0, 40);
  function personFrom(req) {
    const tok = String(req.headers['x-amigo'] || ''), id = int(tok.split('.')[0]);
    if (!id) return null;
    const p = db.prepare('SELECT * FROM ai_people WHERE id = ?').get(id), draw = current();
    if (!p || !p.pin_hash || !draw || p.draw_id !== draw.id) return null;
    const want = tokenFor(p);
    return want.length === tok.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(tok)) ? p : null;
  }
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  }

  // Un solo ciclo al azar: se mezcla la lista (Fisher-Yates con crypto) y cada uno le regala al siguiente.
  function assign(drawId) {
    const ids = db.prepare('SELECT id FROM ai_people WHERE draw_id = ?').all(drawId).map(r => r.id);
    for (let i = ids.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    ids.forEach((id, i) => db.prepare('UPDATE ai_people SET target_id = ?, seen_at = NULL WHERE id = ?').run(ids[(i + 1) % ids.length], id));
    db.prepare('UPDATE ai_draws SET drawn_at = ? WHERE id = ?').run(now(), drawId);
  }

  route('GET', '/amigo', async (req) => {
    const draw = current();
    if (!draw) return { draw: null, people: [] };
    const people = db.prepare('SELECT id, name, pin_hash IS NOT NULL AS claimed, seen_at IS NOT NULL AS seen FROM ai_people WHERE draw_id = ? ORDER BY name COLLATE NOCASE').all(draw.id)
      .map(p => ({ id: p.id, name: p.name, claimed: !!p.claimed, seen: !!p.seen }));
    const p = personFrom(req);
    let me = null;
    if (p) {
      const t = db.prepare('SELECT name, wishes FROM ai_people WHERE id = ?').get(p.target_id) || { name: '?', wishes: '' };
      me = { id: p.id, name: p.name, wishes: p.wishes, seen: !!p.seen_at, target: { name: t.name, wishes: t.wishes } };
    }
    return { draw: { id: draw.id, title: draw.title, budget: draw.budget, date: draw.date, notes: draw.notes, drawn_at: draw.drawn_at }, people, me };
  });

  route('POST', '/amigo/entrar', async (req) => {
    if (rateLimited(req, 'amigo-login', 30)) fail(429, 'Demasiados intentos. Esperá unos minutos.');
    const b = await readBody(req, 1024);
    const draw = current();
    if (!draw) fail(404, 'Todavía no hay sorteo.');
    const p = db.prepare('SELECT * FROM ai_people WHERE id = ? AND draw_id = ?').get(int(b.id), draw.id);
    if (!p) fail(404, 'Ese nombre no está en el sorteo.');
    const pin = String(b.pin ?? '').trim();
    if (!/^\d{4,8}$/.test(pin)) fail(400, 'El PIN tiene que ser de 4 a 8 números.');
    if (p.pin_hash) {
      if (!checkPin(pin, p.pin_hash)) fail(401, 'PIN incorrecto. Si no fuiste vos quien entró con este nombre, avisale a Giorgio.');
    } else {
      tx(() => db.prepare('UPDATE ai_people SET pin_hash = ?, claimed_at = ? WHERE id = ? AND pin_hash IS NULL').run(hashPin(pin), now(), p.id));
    }
    const fresh = db.prepare('SELECT * FROM ai_people WHERE id = ?').get(p.id);
    if (!checkPin(pin, fresh.pin_hash)) fail(409, 'Alguien entró con este nombre recién. Probá de nuevo.');
    return { token: tokenFor(fresh), name: fresh.name };
  });

  route('POST', '/amigo/visto', async (req) => {
    const p = personFrom(req);
    if (!p) fail(401, 'Entrá de nuevo.');
    if (!p.seen_at) db.prepare('UPDATE ai_people SET seen_at = ? WHERE id = ?').run(now(), p.id);
    return { ok: true };
  });

  route('POST', '/amigo/ideas', async (req) => {
    const p = personFrom(req);
    if (!p) fail(401, 'Entrá de nuevo.');
    const b = await readBody(req, 4096);
    db.prepare('UPDATE ai_people SET wishes = ? WHERE id = ?').run(text(b.wishes, MAX_WISHES), p.id);
    return { ok: true };
  });

  // Admin: crea el sorteo, edita los datos y libera nombres. Nunca devuelve quién le regala a quién.
  const ACTIONS = {
    create(b) {
      const names = [...new Map(String(b.names ?? '').split(/\n|,/).map(x => str(x, MAX_NAME)).filter(Boolean).map(n => [keyOf(n), n])).values()];
      if (names.length < 3) fail(400, 'Hacen falta al menos 3 personas.');
      if (names.length > MAX_PEOPLE) fail(400, 'Máximo ' + MAX_PEOPLE + ' personas.');
      const id = Number(db.prepare('INSERT INTO ai_draws (title, budget, date, notes, created_at, drawn_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(str(b.title, 80) || 'Amigo invisible', str(b.budget, 60), str(b.date, 60), text(b.notes, 500), now(), now()).lastInsertRowid);
      names.forEach(n => db.prepare('INSERT INTO ai_people (draw_id, name, name_key) VALUES (?, ?, ?)').run(id, n, keyOf(n)));
      assign(id);
    },
    info(b) {
      const draw = current(); if (!draw) fail(404, 'Todavía no hay sorteo.');
      db.prepare('UPDATE ai_draws SET title = ?, budget = ?, date = ?, notes = ? WHERE id = ?')
        .run(str(b.title, 80) || draw.title, str(b.budget, 60), str(b.date, 60), text(b.notes, 500), draw.id);
    },
    release(b) { // si alguien entró con el nombre equivocado: se borra el PIN y puede volver a elegirlo el dueño
      const draw = current(); if (!draw) fail(404, 'Todavía no hay sorteo.');
      const r = db.prepare('UPDATE ai_people SET pin_hash = NULL, claimed_at = NULL WHERE id = ? AND draw_id = ?').run(int(b.id), draw.id);
      if (!r.changes) fail(404, 'Esa persona no está en el sorteo.');
    },
    redraw() { // nuevo sorteo con la misma gente (conserva PINs e ideas)
      const draw = current(); if (!draw) fail(404, 'Todavía no hay sorteo.');
      assign(draw.id);
    },
  };
  route('POST', '/amigo/admin', async (req) => {
    requireAdmin(req);
    const b = await readBody(req, 16384);
    const fn = ACTIONS[b.action];
    if (!fn) fail(400, 'Acción desconocida.');
    tx(() => fn(b));
    return { ok: true };
  });
};
