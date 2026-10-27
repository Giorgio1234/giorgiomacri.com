'use strict';
// Cuenta única del sitio. Usa la tabla cal_users (la del contador) como tabla de cuentas para todo:
//  - is_admin: maneja el panel /admin/, la agenda y el asistente.
//  - player_id: el jugador del sudoku unido a la cuenta (torneo, libre, posiciones).
// Las sesiones son las de cal_sessions; server.js las acepta en todas las rutas (sessionFrom).
// Los jugadores del torneo sin cuenta siguen entrando con apodo + PIN.

const crypto = require('node:crypto');

module.exports = function install(d) {
  const { db, route, fail, readBody, rateLimited, hashPin, checkPin, sha, now, logAccess, OWNER, OWNER_PASSWORD } = d;

  /* ---------- Migración ---------- */
  const cols = db.prepare('PRAGMA table_info(cal_users)').all().map(c => c.name);
  if (!cols.includes('is_admin')) db.exec('ALTER TABLE cal_users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('player_id')) db.exec('ALTER TABLE cal_users ADD COLUMN player_id INTEGER');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS cal_users_player ON cal_users (player_id) WHERE player_id IS NOT NULL');

  const getSetting = k => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : null; };
  const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

  // La cuenta del dueño existe siempre y es admin. Si no estaba, se crea con la contraseña de la agenda.
  let owner = db.prepare('SELECT * FROM cal_users WHERE username = ?').get(OWNER);
  if (!owner && OWNER_PASSWORD) {
    db.prepare('INSERT INTO cal_users (username, pass_hash, created_at, is_admin) VALUES (?, ?, ?, 1)').run(OWNER, hashPin(OWNER_PASSWORD), now());
    owner = db.prepare('SELECT * FROM cal_users WHERE username = ?').get(OWNER);
    console.log(`Cuenta "${OWNER}" creada con la contraseña de la agenda.`);
  }
  if (owner && !getSetting('owner_admin_done')) { db.prepare('UPDATE cal_users SET is_admin = 1 WHERE id = ?').run(owner.id); setSetting('owner_admin_done', '1'); }
  // Unir el jugador de sudoku del dueño (pedido: "giovanni" -> giorgio). Una sola vez.
  const MERGE = (process.env.OWNER_PLAYER || 'giovanni').trim();
  if (owner && MERGE && !getSetting('owner_player_done')) {
    const p = db.prepare('SELECT id, name FROM players WHERE name = ? COLLATE NOCASE').get(MERGE);
    const taken = p && db.prepare('SELECT 1 FROM cal_users WHERE player_id = ?').get(p.id);
    if (p && !taken && !db.prepare('SELECT player_id FROM cal_users WHERE id = ?').get(owner.id).player_id) {
      db.prepare('UPDATE cal_users SET player_id = ? WHERE id = ?').run(p.id, owner.id);
      console.log(`Jugador "${p.name}" unido a la cuenta "${OWNER}".`);
    }
    if (p) setSetting('owner_player_done', '1');
  }

  /* ---------- Rutas ---------- */
  const bearer = req => { const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); return m ? m[1] : null; };
  function meOf(u) {
    const p = u.player_id ? db.prepare('SELECT id, name FROM players WHERE id = ?').get(u.player_id) : null;
    return { kind: 'account', name: u.username, admin: !!u.is_admin, player: p || null };
  }
  function current(req) {
    const t = bearer(req); if (!t) return null;
    const a = db.prepare('SELECT u.*, s.created_at sc FROM cal_sessions s JOIN cal_users u ON u.id = s.user_id WHERE s.token_hash = ?').get(sha(t));
    if (a) return a.disabled || Date.now() - a.sc > 90 * 86400000 ? null : { account: a };
    const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND player_id IS NOT NULL').get(sha(t));
    if (s) { const p = db.prepare('SELECT id, name, banned FROM players WHERE id = ?').get(s.player_id); if (p && !p.banned) return { player: p }; }
    return null;
  }

  // Un solo login: usuario + contraseña de cuenta, o apodo + PIN del torneo (si no tiene cuenta).
  route('POST', '/auth/login', async (req) => {
    if (rateLimited(req, 'auth', 12)) fail(429, 'Demasiados intentos. Esperá unos minutos.');
    const b = await readBody(req);
    const user = String(b.user || '').trim(), pass = String(b.password || '');
    if (!user || !pass) fail(400, 'Completá usuario y contraseña.');
    const u = db.prepare('SELECT * FROM cal_users WHERE username = ?').get(user.toLowerCase());
    if (u && checkPin(pass, u.pass_hash)) {
      if (u.disabled) fail(403, 'Tu cuenta está deshabilitada.');
      const token = crypto.randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO cal_sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)').run(sha(token), u.id, Date.now());
      db.prepare('UPDATE cal_users SET last_login = ? WHERE id = ?').run(now(), u.id);
      if (u.player_id) { try { logAccess(req, u.player_id, 'ingreso', 'cuenta ' + u.username); } catch (e) {} }
      return Object.assign({ token }, meOf(u));
    }
    // Jugador del torneo con apodo y PIN
    const p = /^\d{4,8}$/.test(pass) ? db.prepare('SELECT * FROM players WHERE name = ? COLLATE NOCASE').get(user.replace(/\s+/g, ' ')) : null;
    if (p && checkPin(pass, p.pin_hash)) {
      if (p.banned) fail(403, 'Tu jugador está suspendido del torneo.');
      const linked = db.prepare('SELECT username FROM cal_users WHERE player_id = ?').get(p.id);
      if (linked) fail(401, `Ese jugador está unido a la cuenta "${linked.username}". Entrá con ese usuario y su contraseña.`);
      const token = crypto.randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO sessions (token_hash, player_id, is_admin, created_at) VALUES (?, ?, 0, ?)').run(sha(token), p.id, now());
      try { logAccess(req, p.id, 'ingreso'); } catch (e) {}
      return { token, kind: 'player', name: p.name, admin: false, player: { id: p.id, name: p.name } };
    }
    fail(401, 'Usuario o contraseña incorrectos.');
  });

  route('GET', '/auth/me', async (req) => {
    const c = current(req); if (!c) fail(401, 'Tu sesión venció.');
    if (c.account) return meOf(c.account);
    return { kind: 'player', name: c.player.name, admin: false, player: { id: c.player.id, name: c.player.name } };
  });

  route('POST', '/auth/logout', async (req) => {
    const t = bearer(req);
    if (t) { db.prepare('DELETE FROM cal_sessions WHERE token_hash = ?').run(sha(t)); db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t)); }
    return { ok: true };
  });

  // Cambiar contraseña de la cuenta (cierra las otras sesiones)
  route('POST', '/auth/password', async (req) => {
    const c = current(req); if (!c || !c.account) fail(401, 'Entrá con tu cuenta.');
    if (rateLimited(req, 'auth-pass', 10)) fail(429, 'Demasiados intentos. Esperá unos minutos.');
    const b = await readBody(req), u = c.account;
    if (!checkPin(String(b.current || ''), u.pass_hash)) fail(401, 'La contraseña actual no es correcta.');
    const next = String(b.next || '');
    if (next.length < 8 || next.length > 200) fail(400, 'La nueva contraseña tiene que tener al menos 8 caracteres.');
    db.prepare('UPDATE cal_users SET pass_hash = ? WHERE id = ?').run(hashPin(next), u.id);
    db.prepare('DELETE FROM cal_sessions WHERE user_id = ? AND token_hash != ?').run(u.id, sha(bearer(req)));
    return { ok: true };
  });

  return { current };
};
