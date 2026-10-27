'use strict';
/*
 * Torneo semanal de sudoku — giorgiomacri.com
 * Node >= 22.13 (usa node:http y node:sqlite, sin dependencias externas).
 *
 * Variables de entorno:
 *   ADMIN_PASSWORD  (obligatoria, mínimo 8 caracteres)
 *   INVITE_CODE     código inicial para unirse (después se cambia desde el dashboard)
 *   DB_PATH         ruta del archivo SQLite (por defecto ./torneo.db)
 *   PORT, HOST      por defecto 3001 y 127.0.0.1
 */
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { generate } = require('./lib/sudoku');

/* ---------- Reglas ---------- */
const LIMIT_S = 30 * 60;      // tope por tablero
const PENALTY_S = 60;         // por error
const MAX_ERRORS = 3;         // al tercero, eliminado
const CLUES = 24;             // dificultad Experto
const TZ_OFFSET_MIN = -180;   // Argentina: UTC-3, sin horario de verano
const DAY_MS = 86400000;
const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

/* ---------- Config ---------- */
const PORT = +process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'torneo.db');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// Agenda privada: usuario y contraseña propios (si no se configuran, usuario "giorgio" y la contraseña del admin)
const AGENDA_USER = (process.env.AGENDA_USER || 'giorgio').trim().toLowerCase();
const AGENDA_PASSWORD = process.env.AGENDA_PASSWORD || ADMIN_PASSWORD;
const TEST_CLOCK = process.env.TEST_CLOCK === '1';
if (ADMIN_PASSWORD.length < 8) {
  console.error('Falta ADMIN_PASSWORD (mínimo 8 caracteres).');
  process.exit(1);
}

let clockOffset = 0;
const now = () => Date.now() + clockOffset;

/* ---------- Base de datos ---------- */
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pin_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    banned INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS boards (
    week TEXT NOT NULL,
    day INTEGER NOT NULL,
    puzzle TEXT NOT NULL,
    solution TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (week, day)
  );
  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    week TEXT NOT NULL,
    day INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL,
    errors INTEGER NOT NULL DEFAULT 0,
    error_log TEXT NOT NULL DEFAULT '[]',
    grid TEXT NOT NULL,
    score INTEGER,
    UNIQUE (player_id, week, day)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS access_log (
    id INTEGER PRIMARY KEY,
    player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    ip TEXT NOT NULL,
    device TEXT NOT NULL,
    ua TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS access_log_player ON access_log(player_id);
  CREATE INDEX IF NOT EXISTS access_log_ip ON access_log(ip);
  CREATE TABLE IF NOT EXISTS bans (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('ip', 'device')),
    value TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (kind, value)
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS ip_notices (
    id INTEGER PRIMARY KEY,
    ip TEXT NOT NULL UNIQUE,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
if (!db.prepare("SELECT 1 FROM pragma_table_info('ip_notices') WHERE name = 'allow_signup'").get()) {
  db.exec('ALTER TABLE ip_notices ADD COLUMN allow_signup INTEGER NOT NULL DEFAULT 1');
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('ip_notices') WHERE name = 'show_always'").get()) {
  db.exec('ALTER TABLE ip_notices ADD COLUMN show_always INTEGER NOT NULL DEFAULT 1');
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('ip_notices') WHERE name = 'kind'").get()) {
  db.exec("ALTER TABLE ip_notices ADD COLUMN kind TEXT NOT NULL DEFAULT 'ip'");
}
// El cartel aplica a la IP o al dispositivo de quien hace el pedido (el de dispositivo tiene prioridad)
function noticeFor(req) {
  const dev = clientDevice(req);
  return (dev && db.prepare("SELECT * FROM ip_notices WHERE kind = 'device' AND ip = ?").get(dev))
    || db.prepare("SELECT * FROM ip_notices WHERE kind = 'ip' AND ip = ?").get(clientIp(req));
}
for (const col of ['detail', 'page']) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('access_log') WHERE name = ?").get(col)) db.exec(`ALTER TABLE access_log ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS free_games (
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    difficulty INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    seconds INTEGER,
    mistakes INTEGER,
    hints INTEGER,
    status TEXT NOT NULL DEFAULT 'playing'
  );
  CREATE INDEX IF NOT EXISTS free_games_player ON free_games(player_id);
`);
const FREE_LEVELS = ['Muy fácil', 'Fácil', 'Media', 'Difícil', 'Experto'];
for (const [col, def] of [['paused_at', 'INTEGER'], ['paused_ms', 'INTEGER NOT NULL DEFAULT 0'], ['pauses', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('attempts') WHERE name = ?").get(col)) db.exec(`ALTER TABLE attempts ADD COLUMN ${col} ${def}`);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS agenda_days (date TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS agenda_settings (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
`);
// Cuentas nuevas por IP o dispositivo en 24 h (para frenar la creación masiva)
const MAX_NEW_PER_DAY = 3;
// Tiempo mínimo entre cuentas nuevas desde la misma IP
const SIGNUP_COOLDOWN_MS = 5 * 60 * 1000;

function getSetting(k) { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : null; }
function setSetting(k, v) { db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v); }
if (!getSetting('invite_code')) {
  const code = (process.env.INVITE_CODE || crypto.randomBytes(4).toString('hex')).trim();
  setSetting('invite_code', code);
  console.log('Código de invitación inicial:', code);
}

/* ---------- Semanas (hora Argentina) ---------- */
function weekOf(ms) {
  const local = ms + TZ_OFFSET_MIN * 60000;
  const midnight = local - (local % DAY_MS);
  const dow = (new Date(midnight).getUTCDay() + 6) % 7; // 0 = lunes
  return new Date(midnight - dow * DAY_MS).toISOString().slice(0, 10);
}
function weekStart(week) { return Date.parse(week + 'T00:00:00Z') - TZ_OFFSET_MIN * 60000; }
function weekEnd(week) { return weekStart(week) + 7 * DAY_MS; }
function dayUnlock(week, day) { return weekStart(week) + day * DAY_MS; }
function validWeek(w) { return typeof w === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w) && weekOf(weekStart(w)) === w; }

function ensureWeek(week) {
  const ins = db.prepare('INSERT OR IGNORE INTO boards (week, day, puzzle, solution, created_at) VALUES (?, ?, ?, ?, ?)');
  const have = db.prepare('SELECT day FROM boards WHERE week = ?').all(week).map(r => r.day);
  for (let d = 0; d < 7; d++) {
    if (have.includes(d)) continue;
    const g = generate(CLUES);
    ins.run(week, d, g.puzzle.join(''), g.solution.join(''), now());
  }
}
function getBoard(week, day) { if (week === weekOf(now())) ensureWeek(week); return db.prepare('SELECT * FROM boards WHERE week = ? AND day = ?').get(week, day); }

/* ---------- Intentos ---------- */
// Tiempo jugado: lo transcurrido menos lo que estuvo en pausa (incluida la pausa en curso)
function pausedMs(a, at) { const end = a.finished_at || at; return (a.paused_ms || 0) + (a.paused_at ? Math.max(0, end - a.paused_at) : 0); }
function elapsedS(a, at) { return Math.max(0, Math.floor(((a.finished_at || at) - a.started_at - pausedMs(a, at)) / 1000)); }
function liveScore(a, at) { return elapsedS(a, at) + a.errors * PENALTY_S; }

// Cierra intentos vencidos (pasaron los 30 minutos o cerró la semana).
function settle(a) {
  if (!a || a.status !== 'playing') return a;
  const t = now();
  if (a.paused_at) {
    // En pausa el reloj no corre: solo lo cierra el fin de la semana
    if (t < weekEnd(a.week)) return a;
    db.prepare("UPDATE attempts SET status = 'timeout', finished_at = ?, score = ?, paused_ms = paused_ms + MAX(0, ? - paused_at), paused_at = NULL WHERE id = ?")
      .run(weekEnd(a.week), LIMIT_S, weekEnd(a.week), a.id);
    return db.prepare('SELECT * FROM attempts WHERE id = ?').get(a.id);
  }
  const deadline = Math.min(a.started_at + (a.paused_ms || 0) + (LIMIT_S - a.errors * PENALTY_S) * 1000, weekEnd(a.week));
  if (t >= deadline) {
    db.prepare("UPDATE attempts SET status = 'timeout', finished_at = ?, score = ? WHERE id = ?").run(deadline, LIMIT_S, a.id);
    return db.prepare('SELECT * FROM attempts WHERE id = ?').get(a.id);
  }
  return a;
}
function getAttempt(pid, week, day) { return settle(db.prepare('SELECT * FROM attempts WHERE player_id = ? AND week = ? AND day = ?').get(pid, week, day)); }

function attemptView(a, board, withBoard) {
  const t = now();
  const v = {
    status: a.status,
    errors: a.errors,
    errorLog: JSON.parse(a.error_log),
    startedAt: a.started_at,
    finishedAt: a.finished_at,
    elapsed: elapsedS(a, t),
    score: a.status === 'playing' ? null : a.score,
    paused: !!a.paused_at,
    pauses: a.pauses || 0,
    pausedS: Math.floor(pausedMs(a, t) / 1000),
    now: t,
    limit: LIMIT_S,
    penalty: PENALTY_S,
    maxErrors: MAX_ERRORS
  };
  if (withBoard && !a.paused_at) { v.puzzle = board.puzzle; v.grid = a.grid; }
  return v;
}

/* ---------- Tabla de posiciones ---------- */
function standings(week, detail) {
  if (week === weekOf(now())) ensureWeek(week);
  const t = now(), end = weekEnd(week), closed = t >= end;
  const players = db.prepare('SELECT id, name, banned, created_at FROM players WHERE created_at < ? ORDER BY name').all(end);
  const atts = db.prepare('SELECT * FROM attempts WHERE week = ?').all(week).map(settle);
  const byPlayer = {};
  atts.forEach(a => { (byPlayer[a.player_id] = byPlayer[a.player_id] || {})[a.day] = a; });

  const rows = players.filter(p => !p.banned || detail).map(p => {
    let total = 0, errors = 0, played = 0, lastFinish = 0;
    const days = [];
    for (let d = 0; d < 7; d++) {
      const a = (byPlayer[p.id] || {})[d];
      const unlocked = t >= dayUnlock(week, d);
      let cell;
      if (a) {
        cell = { status: a.status, errors: a.errors, score: a.status === 'playing' ? null : a.score, live: a.status === 'playing' ? liveScore(a, t) : null, paused: !!a.paused_at };
        if (detail) { cell.startedAt = a.started_at; cell.finishedAt = a.finished_at; cell.errorLog = JSON.parse(a.error_log); cell.pauses = a.pauses || 0; cell.pausedS = Math.floor(pausedMs(a, t) / 1000); }
        total += a.status === 'playing' ? LIMIT_S : a.score;
        errors += a.errors;
        if (a.status !== 'playing') played++;
        if (a.finished_at) lastFinish = Math.max(lastFinish, a.finished_at);
      } else {
        cell = { status: !unlocked ? 'locked' : closed ? 'missed' : 'open', errors: 0, score: unlocked && closed ? LIMIT_S : null };
        total += LIMIT_S;
      }
      days.push(cell);
    }
    return { id: p.id, name: p.name, banned: !!p.banned, total, errors, played, lastFinish, days };
  });
  rows.sort((a, b) => (a.banned - b.banned) || (a.total - b.total) || (a.errors - b.errors) || (a.lastFinish - b.lastFinish) || a.name.localeCompare(b.name));
  let pos = 0;
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    if (!prev || prev.total !== r.total || prev.errors !== r.errors) pos = i + 1;
    r.position = r.banned ? null : pos;
    delete r.lastFinish;
  });
  return rows;
}

function weeksList() {
  const cur = weekOf(now());
  const w = db.prepare('SELECT DISTINCT week FROM boards ORDER BY week DESC').all().map(r => r.week).filter(x => x <= cur);
  if (!w.includes(cur)) w.unshift(cur);
  return w;
}
function weekInfo(week) {
  const t = now();
  return {
    week,
    current: weekOf(t),
    start: weekStart(week),
    end: weekEnd(week),
    closed: t >= weekEnd(week),
    now: t,
    rules: { limit: LIMIT_S, penalty: PENALTY_S, maxErrors: MAX_ERRORS },
    days: DAY_NAMES.map((name, d) => ({ day: d, name, unlockAt: dayUnlock(week, d), unlocked: t >= dayUnlock(week, d) })),
    weeks: weeksList()
  };
}

/* ---------- Seguridad ---------- */
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(pin, salt, 32).toString('hex');
}
function checkPin(pin, stored) {
  const [, salt, hash] = stored.split('$');
  const a = crypto.scryptSync(pin, Buffer.from(salt, 'hex'), 32), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function newSession(playerId, isAdmin) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, player_id, is_admin, created_at) VALUES (?, ?, ?, ?)').run(sha(token), playerId, typeof isAdmin === 'number' ? isAdmin : isAdmin ? 1 : 0, now());
  return token;
}
function sessionFrom(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha(m[1]));
  if (!s) return accountSession(m[1]);
  // is_admin: 1 = panel del torneo (7 días), 2 = agenda privada (60 días)
  if (s.is_admin === 1 && Date.now() - s.created_at > 7 * DAY_MS) return null;
  if (s.is_admin === 2 && Date.now() - s.created_at > 60 * DAY_MS) return null;
  return s;
}

// Cuenta del sitio (lib/cuentas.js): vale como jugador (si tiene uno unido) y como admin (si es admin)
function accountSession(token) {
  let a;
  try { a = db.prepare('SELECT u.*, s.created_at AS sc FROM cal_sessions s JOIN cal_users u ON u.id = s.user_id WHERE s.token_hash = ?').get(sha(token)); } catch (e) { return null; }
  if (!a || a.disabled || Date.now() - a.sc > 90 * DAY_MS) return null;
  return { player_id: a.player_id || null, is_admin: a.is_admin ? 1 : 0, account: a, created_at: Date.now() };
}

function clientIp(req) { return String(req.headers['x-real-ip'] || req.socket.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 64); }
function clientDevice(req) { const d = String(req.headers['x-device'] || ''); return /^[A-Za-z0-9-]{8,64}$/.test(d) ? d : ''; }
function clientUa(req) { return String(req.headers['user-agent'] || '').slice(0, 300); }
function bannedOrigin(req) {
  const ip = clientIp(req), dev = clientDevice(req);
  return db.prepare("SELECT * FROM bans WHERE (kind = 'ip' AND value = ?) OR (kind = 'device' AND value = ? AND value != '')").get(ip, dev);
}
function blockIfBanned(req) { if (bannedOrigin(req)) fail(403, 'No podés acceder al torneo desde esta conexión o este dispositivo.'); }
function logAccess(req, playerId, event, detail, page) {
  db.prepare('INSERT INTO access_log (player_id, event, ip, device, ua, at, detail, page) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(playerId, event, clientIp(req), clientDevice(req), clientUa(req), now(), String(detail || '').slice(0, 200), String(page || '').slice(0, 40));
}

const hits = new Map();
function rateLimited(req, key, max) {
  const ip = clientIp(req);
  const k = key + ':' + ip, t = Date.now();
  const h = hits.get(k);
  if (!h || t > h.reset) { hits.set(k, { n: 1, reset: t + 10 * 60000 }); return false; }
  h.n++;
  return h.n > max;
}

/* ---------- HTTP ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (s, m) => { throw new HttpError(s, m); };

function readBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Pedido demasiado grande.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new HttpError(400, 'JSON inválido.')); }
    });
    req.on('error', reject);
  });
}

function requirePlayer(req) {
  const s = sessionFrom(req);
  if (!s || !s.player_id) fail(401, 'Tenés que entrar al torneo.');
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(s.player_id);
  if (!p) fail(401, 'Tu jugador ya no existe.');
  if (p.banned) fail(403, 'Tu jugador está suspendido del torneo.');
  blockIfBanned(req);
  return p;
}
function requireAdmin(req) {
  const s = sessionFrom(req);
  if (!s || s.is_admin !== 1) fail(401, 'Sesión de administrador vencida. Volvé a entrar.');
}
function requireAgenda(req) {
  const s = sessionFrom(req);
  if (!s || !(s.is_admin === 2 || (s.account && s.account.is_admin))) fail(401, 'Tenés que entrar a la agenda.');
}
function requireViewer(req) {
  const s = sessionFrom(req);
  if (!s) fail(401, 'Tenés que entrar al torneo.');
  return s;
}
function weekParam(url) {
  const w = url.searchParams.get('week') || weekOf(now());
  if (!validWeek(w)) fail(400, 'Semana inválida.');
  return w;
}
function dayParam(v) {
  const d = Number(v);
  if (!Number.isInteger(d) || d < 0 || d > 6) fail(400, 'Día inválido.');
  return d;
}
const NAME_RE = /^[\p{L}\p{N} ._-]{2,20}$/u;

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^/api/sudoku' + pattern + '$'), fn });

/* Jugadores */
route('POST', '/join', async (req) => {
  try { return await joinHandler(req); }
  catch (e) {
    if (e instanceof HttpError) { try { logAccess(req, null, 'rechazado', (req._joinName ? req._joinName + ': ' : '') + e.message); } catch (x) {} }
    throw e;
  }
});
async function joinHandler(req) {
  if (rateLimited(req, 'join', 15)) fail(429, 'Demasiados intentos. Esperá unos minutos.');
  blockIfBanned(req);
  const b = await readBody(req);
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  req._joinName = name.slice(0, 20);
  const pin = String(b.pin || '');
  if (!NAME_RE.test(name)) fail(400, 'El apodo tiene que tener entre 2 y 20 letras o números.');
  if (!/^\d{4,8}$/.test(pin)) fail(400, 'El PIN tiene que ser de 4 a 8 números.');
  let p = db.prepare('SELECT * FROM players WHERE name = ?').get(name);
  if (p) {
    if (!checkPin(pin, p.pin_hash)) fail(401, 'Ese apodo ya existe y el PIN no coincide.');
    if (p.banned) fail(403, 'Tu jugador está suspendido del torneo.');
    logAccess(req, p.id, 'ingreso');
  } else {
    const notice = noticeFor(req);
    if (notice && !notice.allow_signup) fail(403, 'No se pueden crear cuentas desde esta conexión.');
    if (String(b.code || '').trim().toLowerCase() !== getSetting('invite_code').toLowerCase()) fail(403, 'El código del torneo no es correcto.');
    const lastFromIp = db.prepare("SELECT MAX(at) AS at FROM access_log WHERE event = 'alta' AND ip = ?").get(clientIp(req)).at;
    if (lastFromIp && now() - lastFromIp < SIGNUP_COOLDOWN_MS) {
      const wait = Math.ceil((SIGNUP_COOLDOWN_MS - (now() - lastFromIp)) / 60000);
      fail(429, `Ya se creó una cuenta desde esta conexión hace poco. Probá de nuevo en ${wait} minuto${wait === 1 ? '' : 's'}.`);
    }
    const since = now() - DAY_MS, dev = clientDevice(req);
    const recent = db.prepare("SELECT COUNT(DISTINCT player_id) AS n FROM access_log WHERE event = 'alta' AND at > ? AND (ip = ? OR (device = ? AND device != ''))").get(since, clientIp(req), dev).n;
    if (recent >= MAX_NEW_PER_DAY) fail(429, 'Ya se crearon varias cuentas desde esta conexión hoy. Si ya tenés una, entrá con tu apodo y PIN.');
    const r = db.prepare('INSERT INTO players (name, pin_hash, created_at) VALUES (?, ?, ?)').run(name, hashPin(pin), now());
    p = db.prepare('SELECT * FROM players WHERE id = ?').get(r.lastInsertRowid);
    logAccess(req, p.id, 'alta');
  }
  // Si entra con la cuenta del sitio puesta y todavía no tiene jugador, se unen
  const bt = /^Bearer (.+)$/.exec(req.headers.authorization || ''), acc = bt && accountSession(bt[1]);
  if (acc && !acc.account.player_id) {
    const other = db.prepare('SELECT username FROM cal_users WHERE player_id = ?').get(p.id);
    if (other) fail(409, `Ese jugador ya está unido a la cuenta "${other.username}".`);
    db.prepare('UPDATE cal_users SET player_id = ? WHERE id = ?').run(p.id, acc.account.id);
    return { token: bt[1], player: { id: p.id, name: p.name }, linked: true };
  }
  return { token: newSession(p.id, false), player: { id: p.id, name: p.name } };
}

route('GET', '/me', async (req) => { const p = requirePlayer(req); return { id: p.id, name: p.name }; });

/* Juego libre: registro por cuenta (solo si el jugador entró al torneo en ese navegador) */
route('POST', '/free/start', async (req) => {
  const p = requirePlayer(req);
  const b = await readBody(req);
  const diff = Number(b.difficulty);
  if (!Number.isInteger(diff) || diff < 0 || diff >= FREE_LEVELS.length) fail(400, 'Dificultad inválida.');
  db.prepare("UPDATE free_games SET status = 'abandoned' WHERE player_id = ? AND status = 'playing'").run(p.id);
  const r = db.prepare('INSERT INTO free_games (player_id, difficulty, started_at) VALUES (?, ?, ?)').run(p.id, diff, now());
  return { id: Number(r.lastInsertRowid) };
});

route('POST', '/free/finish', async (req) => {
  const p = requirePlayer(req);
  const b = await readBody(req);
  const g = db.prepare('SELECT * FROM free_games WHERE id = ? AND player_id = ?').get(Number(b.id), p.id);
  if (!g) fail(404, 'No existe esa partida.');
  if (g.status === 'solved') return { ok: true };
  const clamp = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
  db.prepare("UPDATE free_games SET status = 'solved', finished_at = ?, seconds = ?, mistakes = ?, hints = ? WHERE id = ?")
    .run(now(), clamp(b.seconds, 24 * 3600), clamp(b.mistakes, 999), clamp(b.hints, 3), g.id);
  return { ok: true };
});

/* ---------- Agenda privada ---------- */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(d) { return DATE_RE.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d; }
function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function getSettingJson(key, def) { const r = db.prepare('SELECT data FROM agenda_settings WHERE key = ?').get(key); try { return r ? JSON.parse(r.data) : def; } catch (e) { return def; } }

route('POST', '/agenda/login', async (req) => {
  if (rateLimited(req, 'agenda', 8)) fail(429, 'Demasiados intentos. Esperá unos minutos.');
  const b = await readBody(req);
  const okUser = sameText(String(b.user || '').trim().toLowerCase(), AGENDA_USER);
  const okPass = sameText(String(b.password || ''), AGENDA_PASSWORD);
  if (!okUser || !okPass) fail(401, 'Usuario o contraseña incorrectos.');
  return { token: newSession(null, 2) };
});

route('GET', '/agenda/data', async (req, url) => {
  requireAgenda(req);
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  if (!validDate(from) || !validDate(to) || to < from) fail(400, 'Fechas inválidas.');
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS > 62) fail(400, 'Pedí como mucho dos meses por vez.');
  const days = {};
  db.prepare('SELECT date, data, updated_at FROM agenda_days WHERE date >= ? AND date <= ?').all(from, to)
    .forEach(r => { try { days[r.date] = Object.assign(JSON.parse(r.data), { updatedAt: r.updated_at }); } catch (e) {} });
  return { days, recurring: getSettingJson('recurring', []), habits: getSettingJson('habits', []), now: now() };
});

route('PUT', '/agenda/day/(\\d{4}-\\d{2}-\\d{2})', async (req, url, m) => {
  requireAgenda(req);
  const date = m[1];
  if (!validDate(date)) fail(400, 'Fecha inválida.');
  const b = await readBody(req, 256 * 1024);
  const d = b && typeof b.data === 'object' && b.data ? b.data : null;
  if (!d) fail(400, 'Faltan los datos del día.');
  const clean = {
    priorities: Array.isArray(d.priorities) ? d.priorities.slice(0, 3) : [],
    tasks: Array.isArray(d.tasks) ? d.tasks.slice(0, 200) : [],
    events: Array.isArray(d.events) ? d.events.slice(0, 100) : [],
    skip: Array.isArray(d.skip) ? d.skip.slice(0, 100) : [],
    habitsDone: Array.isArray(d.habitsDone) ? d.habitsDone.slice(0, 50) : [],
    notes: typeof d.notes === 'string' ? d.notes.slice(0, 20000) : ''
  };
  const empty = !clean.priorities.some(p => p && p.text) && !clean.tasks.length && !clean.events.length && !clean.skip.length && !clean.habitsDone.length && !clean.notes;
  if (empty) db.prepare('DELETE FROM agenda_days WHERE date = ?').run(date);
  else db.prepare('INSERT INTO agenda_days (date, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(date, JSON.stringify(clean), now());
  return { ok: true, updatedAt: now() };
});

route('PUT', '/agenda/settings', async (req) => {
  requireAgenda(req);
  const b = await readBody(req, 128 * 1024);
  const put = (key, val, max) => db.prepare('INSERT INTO agenda_settings (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(val.slice(0, max)), now());
  if (Array.isArray(b.recurring)) put('recurring', b.recurring, 200);
  if (Array.isArray(b.habits)) put('habits', b.habits, 30);
  return { ok: true };
});

route('POST', '/logout', async (req) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (m) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(m[1])); db.prepare('DELETE FROM cal_sessions WHERE token_hash = ?').run(sha(m[1])); }
  return { ok: true };
});

route('GET', '/week', async (req, url) => {
  const s = requireViewer(req);
  const week = weekParam(url);
  if (week > weekOf(now())) fail(400, 'Esa semana todavía no empezó.');
  if (week !== weekOf(now()) && !db.prepare('SELECT 1 FROM boards WHERE week = ?').get(week)) fail(404, 'No hubo torneo esa semana.');
  const info = weekInfo(week);
  info.standings = standings(week, false);
  info.me = s.player_id || null;
  return info;
});

// Cartel especial para la IP que hace el pedido (público, sin sesión)
const PAGES = { libre: 'Libre', torneo: 'Torneo', posiciones: 'Posiciones' };
route('GET', '/notice', async (req, url) => {
  const page = PAGES[url.searchParams.get('p')] || '';
  const recent = db.prepare("SELECT 1 FROM access_log WHERE event = 'visita' AND ip = ? AND device = ? AND page = ? AND at > ?")
    .get(clientIp(req), clientDevice(req), page, now() - 10 * 60000);
  if (!recent) logAccess(req, null, 'visita', '', page);
  const n = noticeFor(req);
  if (!n) return {};
  // key cambia si se edita el mensaje, así un cartel de "una sola vez" vuelve a aparecer
  return { message: n.message, always: !!n.show_always, key: n.id + '-' + sha(n.message).slice(0, 10) };
});

// Tabla pública (sin sesión): posiciones de la semana y campeones de semanas cerradas.
route('GET', '/scoreboard', async (req, url) => {
  const week = weekParam(url);
  if (week > weekOf(now())) fail(400, 'Esa semana todavía no empezó.');
  if (week !== weekOf(now()) && !db.prepare('SELECT 1 FROM boards WHERE week = ?').get(week)) fail(404, 'No hubo torneo esa semana.');
  const info = weekInfo(week);
  info.standings = standings(week, false);
  info.me = null;
  info.champions = info.weeks
    .filter(w => now() >= weekEnd(w))
    .map(w => {
      const top = standings(w, false).filter(r => r.position === 1 && r.played > 0);
      return { week: w, start: weekStart(w), names: top.map(r => r.name), total: top.length ? top[0].total : null };
    })
    .filter(c => c.names.length);
  return info;
});

route('GET', '/boards/(\\d)', async (req, url, m) => {
  const p = requirePlayer(req);
  const week = weekParam(url), day = dayParam(m[1]);
  const a = getAttempt(p.id, week, day);
  if (!a) return { status: now() < dayUnlock(week, day) ? 'locked' : now() >= weekEnd(week) ? 'missed' : 'open' };
  return attemptView(a, getBoard(week, day), true);
});

route('POST', '/boards/(\\d)/start', async (req, url, m) => {
  const p = requirePlayer(req);
  const day = dayParam(m[1]), week = weekOf(now());
  if (now() < dayUnlock(week, day)) fail(403, 'Ese tablero todavía no se desbloqueó.');
  const board = getBoard(week, day);
  let a = getAttempt(p.id, week, day);
  if (!a) {
    db.prepare("INSERT INTO attempts (player_id, week, day, started_at, status, grid) VALUES (?, ?, ?, ?, 'playing', ?)").run(p.id, week, day, now(), board.puzzle);
    logAccess(req, p.id, 'partida');
    a = getAttempt(p.id, week, day);
  }
  return Object.assign(attemptView(a, board, true), { week, day });
});

// Pausa: frena el reloj y oculta el tablero. Reanudar suma la pausa al tiempo descontado.
route('POST', '/boards/(\\d)/(pause|resume)', async (req, url, m) => {
  const p = requirePlayer(req);
  const b = await readBody(req);
  const day = dayParam(m[1]), action = m[2];
  const week = validWeek(b.week) ? b.week : weekOf(now());
  const a = getAttempt(p.id, week, day);
  if (!a) fail(404, 'No empezaste este tablero.');
  const board = getBoard(week, day);
  if (a.status !== 'playing') return Object.assign(attemptView(a, board, true), { result: 'closed' });
  const t = now();
  if (action === 'pause' && !a.paused_at) {
    db.prepare('UPDATE attempts SET paused_at = ?, pauses = pauses + 1 WHERE id = ?').run(t, a.id);
  } else if (action === 'resume' && a.paused_at) {
    db.prepare('UPDATE attempts SET paused_ms = paused_ms + ?, paused_at = NULL WHERE id = ?').run(Math.max(0, t - a.paused_at), a.id);
  }
  return Object.assign(attemptView(getAttempt(p.id, week, day), board, true), { result: action });
});

route('POST', '/boards/(\\d)/move', async (req, url, m) => {
  const p = requirePlayer(req);
  const b = await readBody(req);
  const day = dayParam(m[1]);
  const week = validWeek(b.week) ? b.week : weekOf(now());
  const cell = Number(b.cell), value = Number(b.value);
  if (!Number.isInteger(cell) || cell < 0 || cell > 80) fail(400, 'Celda inválida.');
  if (!Number.isInteger(value) || value < 1 || value > 9) fail(400, 'Número inválido.');
  const a = getAttempt(p.id, week, day);
  if (!a) fail(404, 'No empezaste este tablero.');
  const board = getBoard(week, day);
  if (a.status !== 'playing') return Object.assign(attemptView(a, board, true), { result: 'closed' });
  if (a.paused_at) fail(409, 'El tablero está en pausa. Reanudalo para seguir.');
  if (a.grid[cell] !== '0') return Object.assign(attemptView(a, board, true), { result: 'filled' });

  const t = now();
  if (board.solution[cell] === String(value)) {
    const grid = a.grid.slice(0, cell) + value + a.grid.slice(cell + 1);
    if (grid === board.solution) {
      const score = Math.min(LIMIT_S, elapsedS(a, t) + a.errors * PENALTY_S);
      db.prepare("UPDATE attempts SET grid = ?, status = 'solved', finished_at = ?, score = ? WHERE id = ?").run(grid, t, score, a.id);
    } else {
      db.prepare('UPDATE attempts SET grid = ? WHERE id = ?').run(grid, a.id);
    }
    const fresh = getAttempt(p.id, week, day);
    return Object.assign(attemptView(fresh, board, true), { result: 'correct' });
  }
  const errors = a.errors + 1;
  const log = JSON.parse(a.error_log); log.push({ cell, value, at: t });
  if (errors >= MAX_ERRORS) {
    db.prepare("UPDATE attempts SET errors = ?, error_log = ?, status = 'eliminated', finished_at = ?, score = ? WHERE id = ?").run(errors, JSON.stringify(log), t, LIMIT_S, a.id);
  } else {
    db.prepare('UPDATE attempts SET errors = ?, error_log = ? WHERE id = ?').run(errors, JSON.stringify(log), a.id);
  }
  const fresh = getAttempt(p.id, week, day);
  return Object.assign(attemptView(fresh, board, true), { result: 'wrong' });
});

/* Administración */
route('POST', '/admin/login', async (req) => {
  if (rateLimited(req, 'admin', 8)) fail(429, 'Demasiados intentos. Esperá unos minutos.');
  const b = await readBody(req);
  const a = sha(String(b.password || '')), e = sha(ADMIN_PASSWORD);
  if (!crypto.timingSafeEqual(Buffer.from(a), Buffer.from(e))) fail(401, 'Contraseña incorrecta.');
  return { token: newSession(null, true) };
});

route('GET', '/admin/overview', async (req, url) => {
  requireAdmin(req);
  const week = weekParam(url);
  if (week > weekOf(now())) fail(400, 'Esa semana todavía no empezó.');
  const info = weekInfo(week);
  info.standings = standings(week, true);
  info.players = db.prepare(`
    SELECT p.id, p.name, p.banned, p.created_at AS createdAt,
      (SELECT COUNT(*) FROM attempts a WHERE a.player_id = p.id) AS attempts
    FROM players p ORDER BY p.name`).all().map(p => Object.assign(p, { banned: !!p.banned }));
  info.boards = db.prepare('SELECT b.day, b.created_at AS createdAt, (SELECT COUNT(*) FROM attempts a WHERE a.week = b.week AND a.day = b.day) AS attempts FROM boards b WHERE b.week = ? ORDER BY b.day').all(week);
  info.inviteCode = getSetting('invite_code');
  const lastLog = db.prepare('SELECT ip, device, ua, at FROM access_log WHERE player_id = ? ORDER BY at DESC LIMIT 1');
  const altaLog = db.prepare("SELECT ip, device, ua, at FROM access_log WHERE player_id = ? AND event = 'alta' LIMIT 1");
  const sharedIp = db.prepare('SELECT COUNT(DISTINCT b.player_id) AS n FROM access_log a JOIN access_log b ON b.ip = a.ip AND b.player_id != a.player_id WHERE a.player_id = ?');
  const sharedDev = db.prepare("SELECT COUNT(DISTINCT b.player_id) AS n FROM access_log a JOIN access_log b ON b.device = a.device AND a.device != '' AND b.player_id != a.player_id WHERE a.player_id = ?");
  const freeCount = db.prepare("SELECT COUNT(*) AS played, SUM(status = 'solved') AS solved FROM free_games WHERE player_id = ?");
  const banIp = db.prepare("SELECT 1 FROM bans WHERE kind = 'ip' AND value = ?"), banDev = db.prepare("SELECT 1 FROM bans WHERE kind = 'device' AND value = ?");
  info.players.forEach(p => {
    const a = altaLog.get(p.id), l = lastLog.get(p.id);
    p.signupIp = a ? a.ip : null;
    p.lastIp = l ? l.ip : null;
    p.device = (a || l) ? (a || l).device : null;
    p.ua = (a || l) ? (a || l).ua : null;
    p.sharedIp = sharedIp.get(p.id).n;
    p.sharedDevice = sharedDev.get(p.id).n;
    const fg = freeCount.get(p.id);
    p.freePlayed = fg.played; p.freeSolved = fg.solved || 0;
    p.originBanned = !!((p.signupIp && banIp.get(p.signupIp)) || (p.lastIp && banIp.get(p.lastIp)) || (p.device && banDev.get(p.device)));
  });
  info.bans = db.prepare('SELECT id, kind, value, note, created_at AS createdAt FROM bans ORDER BY created_at DESC').all();
  info.notices = db.prepare('SELECT id, kind, ip AS value, message, allow_signup AS allowSignup, show_always AS showAlways, created_at AS createdAt FROM ip_notices ORDER BY created_at DESC').all()
    .map(n => Object.assign(n, { allowSignup: !!n.allowSignup, showAlways: !!n.showAlways }));
  info.myIp = clientIp(req);
  return info;
});

// Historial de accesos de un jugador y otras cuentas que comparten IP o dispositivo
route('GET', '/admin/players/(\\d+)/log', async (req, url, m) => {
  requireAdmin(req);
  const id = Number(m[1]);
  const p = db.prepare('SELECT id, name FROM players WHERE id = ?').get(id);
  if (!p) fail(404, 'No existe ese jugador.');
  const log = db.prepare('SELECT event, ip, device, ua, at FROM access_log WHERE player_id = ? ORDER BY at DESC LIMIT 100').all(id);
  const ips = [...new Set(log.map(l => l.ip))], devs = [...new Set(log.map(l => l.device).filter(Boolean))];
  const ph = a => a.map(() => '?').join(',') || "''";
  const related = db.prepare(`
    SELECT DISTINCT pl.id, pl.name, pl.banned FROM access_log a JOIN players pl ON pl.id = a.player_id
    WHERE a.player_id != ? AND (a.ip IN (${ph(ips)}) OR a.device IN (${ph(devs)}))
    ORDER BY pl.name`).all(id, ...ips, ...devs);
  const bans = db.prepare('SELECT kind, value FROM bans').all();
  return { player: p, log, ips, devices: devs, related, bans };
});

// Historial de juegos libres de un jugador
route('GET', '/admin/players/(\\d+)/free', async (req, url, m) => {
  requireAdmin(req);
  const id = Number(m[1]);
  const p = db.prepare('SELECT id, name FROM players WHERE id = ?').get(id);
  if (!p) fail(404, 'No existe ese jugador.');
  const summary = FREE_LEVELS.map((name, d) => {
    const r = db.prepare(`SELECT COUNT(*) AS played, SUM(status = 'solved') AS solved,
      MIN(CASE WHEN status = 'solved' THEN seconds END) AS best,
      AVG(CASE WHEN status = 'solved' THEN seconds END) AS avg
      FROM free_games WHERE player_id = ? AND difficulty = ?`).get(id, d);
    return { difficulty: d, name, played: r.played, solved: r.solved || 0, best: r.best, avg: r.avg == null ? null : Math.round(r.avg) };
  });
  const games = db.prepare('SELECT id, difficulty, started_at AS startedAt, finished_at AS finishedAt, seconds, mistakes, hints, status FROM free_games WHERE player_id = ? ORDER BY started_at DESC LIMIT 50').all(id);
  return { player: p, summary, games };
});

// Cuentas creadas desde una IP o un dispositivo
route('GET', '/admin/origin', async (req, url) => {
  requireAdmin(req);
  const kind = url.searchParams.get('kind'), value = url.searchParams.get('value') || '';
  if (!['ip', 'device'].includes(kind) || !value) fail(400, 'Origen inválido.');
  const col = kind === 'ip' ? 'ip' : 'device';
  const players = db.prepare(`
    SELECT DISTINCT pl.id, pl.name, pl.created_at AS createdAt,
      (SELECT COUNT(*) FROM attempts t WHERE t.player_id = pl.id) AS attempts
    FROM access_log a JOIN players pl ON pl.id = a.player_id
    WHERE a.${col} = ? ORDER BY pl.created_at DESC`).all(value);
  return { kind, value, players };
});

route('POST', '/admin/bans', async (req) => {
  requireAdmin(req);
  const b = await readBody(req);
  const kind = b.kind, value = String(b.value || '').trim();
  if (!['ip', 'device'].includes(kind) || !value || value.length > 64) fail(400, 'Bloqueo inválido.');
  if (kind === 'ip' && value === clientIp(req)) fail(400, 'Esa es tu propia IP. Si la bloqueás, no vas a poder jugar desde acá.');
  db.prepare('INSERT INTO bans (kind, value, note, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, value) DO UPDATE SET note = excluded.note')
    .run(kind, value, String(b.note || '').slice(0, 120), now());
  return { ok: true };
});

route('DELETE', '/admin/bans/(\\d+)', async (req, url, m) => {
  requireAdmin(req);
  const r = db.prepare('DELETE FROM bans WHERE id = ?').run(Number(m[1]));
  if (!r.changes) fail(404, 'Ese bloqueo no existe.');
  return { ok: true };
});

// Conexiones en vivo: últimos eventos (visitas, registros, ingresos, partidas y rechazos)
route('GET', '/admin/live', async (req, url) => {
  requireAdmin(req);
  const after = Number(url.searchParams.get('after')) || 0;
  const rows = db.prepare(`
    SELECT a.id, a.event, a.ip, a.device, a.ua, a.at, a.detail, a.page, p.name
    FROM access_log a LEFT JOIN players p ON p.id = a.player_id
    WHERE a.id > ? ORDER BY a.id DESC LIMIT 200`).all(after);
  const since = now() - 5 * 60000;
  const active = db.prepare("SELECT COUNT(DISTINCT ip || '|' || device) AS n FROM access_log WHERE at > ?").get(since).n;
  const bans = db.prepare('SELECT kind, value FROM bans').all();
  const notices = db.prepare('SELECT kind, ip AS value FROM ip_notices').all();
  return { rows, active, bans, notices, now: now() };
});

route('POST', '/admin/notices', async (req) => {
  requireAdmin(req);
  const b = await readBody(req);
  const kind = b.kind === 'device' ? 'device' : 'ip';
  const ip = String(b.value || b.ip || '').trim(), message = String(b.message || '').trim();
  if (kind === 'ip' && !/^[0-9a-fA-F:.]{3,45}$/.test(ip)) fail(400, 'Escribí una IP válida, por ejemplo 186.109.93.226.');
  if (kind === 'device' && !/^[A-Za-z0-9-]{8,64}$/.test(ip)) fail(400, 'Ese identificador de dispositivo no es válido. Copialo desde "Accesos".');
  if (!message || message.length > 500) fail(400, 'El mensaje tiene que tener entre 1 y 500 caracteres.');
  const allow = b.allowSignup === false ? 0 : 1, always = b.showAlways === false ? 0 : 1;
  db.prepare('INSERT INTO ip_notices (ip, kind, message, allow_signup, show_always, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ip) DO UPDATE SET kind = excluded.kind, message = excluded.message, allow_signup = excluded.allow_signup, show_always = excluded.show_always')
    .run(ip, kind, message, allow, always, now());
  return { ok: true };
});

route('DELETE', '/admin/notices/(\\d+)', async (req, url, m) => {
  requireAdmin(req);
  const r = db.prepare('DELETE FROM ip_notices WHERE id = ?').run(Number(m[1]));
  if (!r.changes) fail(404, 'Ese cartel no existe.');
  return { ok: true };
});

route('POST', '/admin/players/delete', async (req) => {
  requireAdmin(req);
  const b = await readBody(req);
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger).slice(0, 500);
  if (!ids.length) fail(400, 'No elegiste jugadores.');
  const del = db.prepare('DELETE FROM players WHERE id = ?');
  let n = 0; ids.forEach(id => { n += del.run(id).changes; });
  return { deleted: n };
});

route('POST', '/admin/settings', async (req) => {
  requireAdmin(req);
  const b = await readBody(req);
  const code = String(b.inviteCode || '').trim();
  if (!/^[\p{L}\p{N}_-]{4,32}$/u.test(code)) fail(400, 'El código tiene que tener entre 4 y 32 letras, números, - o _.');
  setSetting('invite_code', code);
  return { inviteCode: code };
});

route('POST', '/admin/players/(\\d+)', async (req, url, m) => {
  requireAdmin(req);
  const id = Number(m[1]);
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
  if (!p) fail(404, 'No existe ese jugador.');
  const b = await readBody(req);
  if (b.name !== undefined) {
    const name = String(b.name).trim().replace(/\s+/g, ' ');
    if (!NAME_RE.test(name)) fail(400, 'El apodo tiene que tener entre 2 y 20 letras o números.');
    const other = db.prepare('SELECT id FROM players WHERE name = ? AND id != ?').get(name, id);
    if (other) fail(409, 'Ya hay otro jugador con ese apodo.');
    db.prepare('UPDATE players SET name = ? WHERE id = ?').run(name, id);
  }
  if (b.pin !== undefined) {
    if (!/^\d{4,8}$/.test(String(b.pin))) fail(400, 'El PIN tiene que ser de 4 a 8 números.');
    db.prepare('UPDATE players SET pin_hash = ? WHERE id = ?').run(hashPin(String(b.pin)), id);
    db.prepare('DELETE FROM sessions WHERE player_id = ?').run(id);
  }
  if (b.banned !== undefined) {
    db.prepare('UPDATE players SET banned = ? WHERE id = ?').run(b.banned ? 1 : 0, id);
    if (b.banned) db.prepare('DELETE FROM sessions WHERE player_id = ?').run(id);
  }
  return { ok: true };
});

route('DELETE', '/admin/players/(\\d+)', async (req, url, m) => {
  requireAdmin(req);
  const r = db.prepare('DELETE FROM players WHERE id = ?').run(Number(m[1]));
  if (!r.changes) fail(404, 'No existe ese jugador.');
  return { ok: true };
});

route('POST', '/admin/attempts/reset', async (req) => {
  requireAdmin(req);
  const b = await readBody(req);
  if (!validWeek(b.week)) fail(400, 'Semana inválida.');
  const r = db.prepare('DELETE FROM attempts WHERE player_id = ? AND week = ? AND day = ?').run(Number(b.playerId), b.week, dayParam(b.day));
  if (!r.changes) fail(404, 'Ese jugador no tiene intento en ese tablero.');
  return { ok: true };
});

route('POST', '/admin/boards/regenerate', async (req) => {
  requireAdmin(req);
  const b = await readBody(req);
  if (!validWeek(b.week)) fail(400, 'Semana inválida.');
  const day = dayParam(b.day);
  if (now() >= weekEnd(b.week)) fail(400, 'Esa semana ya cerró.');
  const n = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE week = ? AND day = ?').get(b.week, day).n;
  if (n && !b.force) fail(409, `Ya hay ${n} intento(s) en ese tablero. Confirmá para borrarlos y regenerar.`);
  const g = generate(CLUES);
  db.prepare('DELETE FROM attempts WHERE week = ? AND day = ?').run(b.week, day);
  db.prepare('INSERT INTO boards (week, day, puzzle, solution, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(week, day) DO UPDATE SET puzzle = excluded.puzzle, solution = excluded.solution, created_at = excluded.created_at')
    .run(b.week, day, g.puzzle.join(''), g.solution.join(''), now());
  return { ok: true, removedAttempts: n };
});

/* Contador de calorías */
require('./lib/calorias')({ db, route, fail, readBody, rateLimited, hashPin, checkPin, sha, now, requireAdmin, validDate, DAY_MS, TZ_OFFSET_MIN, AGENDA_USER });
/* Cuenta única */
require('./lib/cuentas')({ db, route, fail, readBody, rateLimited, hashPin, checkPin, sha, now, logAccess,
  OWNER: (process.env.CHAT_OWNER || AGENDA_USER || 'giorgio').trim().toLowerCase(), OWNER_PASSWORD: AGENDA_PASSWORD });
/* Asistente con herramientas */
require('./lib/asistente')({ db, route, fail, readBody, rateLimited, sha, now, sessionFrom, validDate, DAY_MS, TZ_OFFSET_MIN, AGENDA_USER });

if (TEST_CLOCK) {
  route('POST', '/__clock', async (req) => { const b = await readBody(req); clockOffset = Number(b.offsetMs) || 0; return { now: now() }; });
  route('GET', '/__solution', async (req, url) => { const b = getBoard(weekParam(url), dayParam(url.searchParams.get('day'))); return { solution: b.solution }; });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    let match = null, r = null;
    for (const x of routes) { const m = x.re.exec(url.pathname); if (m) { if (x.method === req.method) { r = x; match = m; break; } match = match || m; } }
    if (!r) fail(match ? 405 : 404, 'No encontrado.');
    const out = await r.fn(req, url, match);
    res.end(JSON.stringify(out));
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    res.statusCode = status;
    res.end(JSON.stringify({ error: status === 500 ? 'Error del servidor.' : e.message }));
  }
});
server.listen(PORT, HOST, () => console.log(`Torneo de sudoku escuchando en http://${HOST}:${PORT}`));

process.on('SIGTERM', () => { server.close(() => { db.close(); process.exit(0); }); });
