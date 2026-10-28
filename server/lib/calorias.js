'use strict';
// Contador de calorías: cuentas propias (las crea el admin), datos por usuario y estimaciones con IA.
// Rutas bajo /api/sudoku/cal/* y /api/sudoku/admin/cal/*.

const crypto = require('node:crypto');
const sesiones = require('./sesiones');

const NUT = ['kcal', 'prot', 'carb', 'sug', 'fat', 'sat', 'fib', 'sod'];
const MEALS = ['Desayuno', 'Almuerzo', 'Merienda', 'Cena', 'Colación'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const USER_RE = /^[a-z0-9._-]{3,24}$/;
const AI_URL = 'https://api.anthropic.com/v1/messages';
const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
const IMG_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

module.exports = function install(d) {
  const { db, route, fail, readBody, rateLimited, hashPin, checkPin, sha, now, requireAdmin, validDate, DAY_MS, TZ_OFFSET_MIN, AGENDA_USER } = d;
  // Proveedor: OpenRouter si hay OPENROUTER_API_KEY; si no, Anthropic directo.
  const OR = () => !!process.env.OPENROUTER_API_KEY;
  const AI_KEY = () => process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  const AI_MODEL = () => process.env.CAL_AI_MODEL || (OR() ? 'deepseek/deepseek-v4.1-flash-1017' : 'claude-haiku-5-5');
  const AI_LIMIT = () => Math.max(0, parseInt(process.env.CAL_AI_DAILY || '30', 10) || 30);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cal_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, last_login INTEGER
    );
    CREATE TABLE IF NOT EXISTS cal_sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES cal_users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cal_profile (user_id INTEGER PRIMARY KEY REFERENCES cal_users(id) ON DELETE CASCADE, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cal_foods (
      user_id INTEGER NOT NULL REFERENCES cal_users(id) ON DELETE CASCADE, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE IF NOT EXISTS cal_entries (
      user_id INTEGER NOT NULL REFERENCES cal_users(id) ON DELETE CASCADE, id TEXT NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE INDEX IF NOT EXISTS cal_entries_date ON cal_entries (user_id, date);
    CREATE TABLE IF NOT EXISTS cal_weights (
      user_id INTEGER NOT NULL REFERENCES cal_users(id) ON DELETE CASCADE, date TEXT NOT NULL, kg REAL NOT NULL,
      PRIMARY KEY (user_id, date)
    );
    CREATE TABLE IF NOT EXISTS cal_ai_usage (
      user_id INTEGER NOT NULL REFERENCES cal_users(id) ON DELETE CASCADE, day TEXT NOT NULL, n INTEGER NOT NULL,
      PRIMARY KEY (user_id, day)
    );
  `);

  /* ---------- Limpieza de datos ---------- */
  const numv = v => { const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0; };
  const r2 = v => Math.round(v * 100) / 100;
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  function cleanNut(o) { const r = {}; NUT.forEach(k => { r[k] = r2(Math.min(100000, Math.max(0, numv(o && o[k])))); }); return r; }
  function cleanGoals(o) { const r = {}; NUT.forEach(k => { const v = numv(o && o[k]); if (v > 0) r[k] = r2(Math.min(100000, v)); }); return r; }
  function cleanFood(f) {
    if (!f || typeof f !== 'object') fail(400, 'Faltan los datos del alimento.');
    const name = str(f.name, 80); if (!name) fail(400, 'El alimento necesita un nombre.');
    const p = numv(f.portionG);
    return { name, brand: str(f.brand, 60), unit: f.unit === 'ml' ? 'ml' : 'g', portionG: p > 0 ? r2(Math.min(100000, p)) : null, per100: cleanNut(f.per100) };
  }
  function cleanEntry(e) {
    if (!e || typeof e !== 'object') fail(400, 'Faltan los datos del registro.');
    if (!validDate(e.date)) fail(400, 'Fecha inválida.');
    const name = str(e.name, 120); if (!name) fail(400, 'El registro necesita un nombre.');
    const out = { date: e.date, meal: MEALS.includes(e.meal) ? e.meal : 'Colación', name, qtyLabel: str(e.qtyLabel, 120), n: cleanNut(e.n), createdAt: Math.round(numv(e.createdAt)) || now() };
    if (e.foodId && ID_RE.test(String(e.foodId))) out.foodId = String(e.foodId);
    return out;
  }
  function cleanProfile(p) {
    const out = { goals: cleanGoals(p && p.goals) };
    const b = p && p.body;
    if (b && typeof b === 'object') {
      const inr = (v, lo, hi) => { const x = numv(v); return x >= lo && x <= hi ? r2(x) : null; };
      out.body = {
        sex: b.sex === 'f' ? 'f' : 'm', age: inr(b.age, 10, 100), heightCm: inr(b.heightCm, 100, 250), weightKg: inr(b.weightKg, 30, 300),
        goal: ['lose', 'maintain', 'gain'].includes(b.goal) ? b.goal : 'maintain', rate: inr(b.rate, 0, 1) || 0,
        train: Math.round(inr(b.train, 0, 14) || 0), daily: ['sit', 'mid', 'active'].includes(b.daily) ? b.daily : 'sit',
        at: Math.round(numv(b.at)) || now()
      };
    }
    if (p && p.skippedOnboarding) out.skippedOnboarding = true;
    const w = p && p.weightGoal;
    if (w && numv(w.kg) >= 30 && numv(w.kg) <= 300) {
      out.weightGoal = { kg: Math.round(numv(w.kg) * 10) / 10 };
      if (numv(w.startKg) >= 30 && numv(w.startKg) <= 300) out.weightGoal.startKg = r2(numv(w.startKg));
      if (validDate(w.startDate)) out.weightGoal.startDate = w.startDate;
    }
    return out;
  }
  const parse = s => { try { return JSON.parse(s); } catch (e) { return null; } };
  const newId = () => 'e' + Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
  const localDay = () => new Date(now() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);

  /* ---------- Sesiones ---------- */
  function calUser(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) fail(401, 'Tenés que entrar.');
    const s = db.prepare('SELECT * FROM cal_sessions WHERE token_hash = ?').get(sha(m[1]));
    if (!s || !sesiones.alive(db, s.token_hash, s.created_at, s.last_used)) fail(401, 'Tu sesión venció. Volvé a entrar.');
    const u = db.prepare('SELECT * FROM cal_users WHERE id = ?').get(s.user_id);
    if (!u) fail(401, 'Tu usuario ya no existe.');
    if (u.disabled) fail(403, 'Tu usuario está deshabilitado.');
    return u;
  }
  function aiInfo(uid) {
    const r = db.prepare('SELECT n FROM cal_ai_usage WHERE user_id = ? AND day = ?').get(uid, localDay());
    return { enabled: !!AI_KEY(), used: r ? r.n : 0, limit: AI_LIMIT() };
  }

  route('POST', '/cal/login', async (req) => {
    if (rateLimited(req, 'cal-login', 10)) fail(429, 'Demasiados intentos. Esperá unos minutos.');
    const b = await readBody(req);
    const u = db.prepare('SELECT * FROM cal_users WHERE username = ?').get(str(b.user, 40).toLowerCase());
    const pass = String(b.password || '');
    // compara igual aunque el usuario no exista, para no revelar cuáles existen
    const ok = u ? checkPin(pass, u.pass_hash) : (checkPin(pass, hashPin('x')), false);
    if (!ok) fail(401, 'Usuario o contraseña incorrectos.');
    if (u.disabled) fail(403, 'Tu usuario está deshabilitado.');
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO cal_sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)').run(sha(token), u.id, Date.now());
    db.prepare('UPDATE cal_users SET last_login = ? WHERE id = ?').run(now(), u.id);
    return { token, user: u.username };
  });

  route('POST', '/cal/logout', async (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (m) db.prepare('DELETE FROM cal_sessions WHERE token_hash = ?').run(sha(m[1]));
    return { ok: true };
  });

  route('POST', '/cal/password', async (req) => {
    const u = calUser(req);
    if (rateLimited(req, 'cal-pass', 10)) fail(429, 'Demasiados intentos. Esperá unos minutos.');
    const b = await readBody(req);
    if (!checkPin(String(b.current || ''), u.pass_hash)) fail(401, 'La contraseña actual no es correcta.');
    const next = String(b.next || '');
    if (next.length < 8 || next.length > 200) fail(400, 'La nueva contraseña tiene que tener al menos 8 caracteres.');
    db.prepare('UPDATE cal_users SET pass_hash = ? WHERE id = ?').run(hashPin(next), u.id);
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    db.prepare('DELETE FROM cal_sessions WHERE user_id = ? AND token_hash != ?').run(u.id, sha(m[1]));
    return { ok: true };
  });

  /* ---------- Datos ---------- */
  route('GET', '/cal/state', async (req, url) => {
    const u = calUser(req);
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    if (!validDate(from) || !validDate(to) || to < from) fail(400, 'Fechas inválidas.');
    if ((Date.parse(to) - Date.parse(from)) / DAY_MS > 120) fail(400, 'Pedí como mucho 120 días por vez.');
    const p = db.prepare('SELECT data FROM cal_profile WHERE user_id = ?').get(u.id);
    const foods = db.prepare('SELECT id, data FROM cal_foods WHERE user_id = ?').all(u.id).map(r => Object.assign({ id: r.id }, parse(r.data)));
    const entries = db.prepare('SELECT id, data FROM cal_entries WHERE user_id = ? AND date >= ? AND date <= ?').all(u.id, from, to).map(r => Object.assign({ id: r.id }, parse(r.data)));
    const weights = db.prepare('SELECT date, kg FROM cal_weights WHERE user_id = ? ORDER BY date').all(u.id).map(r => ({ id: r.date, date: r.date, kg: r.kg }));
    return { user: u.username, chat: !!u.is_admin && !!process.env.OPENROUTER_API_KEY, profile: (p && parse(p.data)) || { goals: {} }, foods, entries, weights, ai: aiInfo(u.id) };
  });

  route('PUT', '/cal/profile', async (req) => {
    const u = calUser(req);
    const clean = cleanProfile(await readBody(req));
    db.prepare('INSERT INTO cal_profile (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(u.id, JSON.stringify(clean), now());
    return { ok: true, profile: clean };
  });

  route('PUT', '/cal/foods/([A-Za-z0-9_-]{1,64})', async (req, url, m) => {
    const u = calUser(req);
    const f = cleanFood((await readBody(req)).food);
    const n = db.prepare('SELECT COUNT(*) c FROM cal_foods WHERE user_id = ?').get(u.id).c;
    if (n >= 1000 && !db.prepare('SELECT 1 FROM cal_foods WHERE user_id = ? AND id = ?').get(u.id, m[1])) fail(400, 'Llegaste al máximo de 1000 alimentos.');
    db.prepare('INSERT INTO cal_foods (user_id, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(u.id, m[1], JSON.stringify(f), now());
    return Object.assign({ id: m[1] }, f);
  });
  route('DELETE', '/cal/foods/([A-Za-z0-9_-]{1,64})', async (req, url, m) => {
    const u = calUser(req);
    db.prepare('DELETE FROM cal_foods WHERE user_id = ? AND id = ?').run(u.id, m[1]);
    return { ok: true };
  });

  function putEntry(uid, id, e) {
    db.prepare('INSERT INTO cal_entries (user_id, id, date, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET date = excluded.date, data = excluded.data, updated_at = excluded.updated_at')
      .run(uid, id, e.date, JSON.stringify(e), now());
  }
  route('POST', '/cal/entries', async (req) => {
    const u = calUser(req);
    const b = await readBody(req, 64 * 1024);
    const list = Array.isArray(b.entries) ? b.entries.slice(0, 30) : [b.entry];
    const out = list.map(x => { const e = cleanEntry(x), id = newId(); putEntry(u.id, id, e); return Object.assign({ id }, e); });
    return { entries: out };
  });
  route('PUT', '/cal/entries/([A-Za-z0-9_-]{1,64})', async (req, url, m) => {
    const u = calUser(req);
    if (!db.prepare('SELECT 1 FROM cal_entries WHERE user_id = ? AND id = ?').get(u.id, m[1])) fail(404, 'Ese registro ya no existe.');
    const e = cleanEntry((await readBody(req)).entry);
    putEntry(u.id, m[1], e);
    return Object.assign({ id: m[1] }, e);
  });
  route('DELETE', '/cal/entries/([A-Za-z0-9_-]{1,64})', async (req, url, m) => {
    const u = calUser(req);
    db.prepare('DELETE FROM cal_entries WHERE user_id = ? AND id = ?').run(u.id, m[1]);
    return { ok: true };
  });

  route('PUT', '/cal/weights/(\\d{4}-\\d{2}-\\d{2})', async (req, url, m) => {
    const u = calUser(req);
    if (!validDate(m[1])) fail(400, 'Fecha inválida.');
    const kg = r2(numv((await readBody(req)).kg));
    if (!kg) db.prepare('DELETE FROM cal_weights WHERE user_id = ? AND date = ?').run(u.id, m[1]);
    else {
      if (kg < 30 || kg > 300) fail(400, 'Revisá el valor en kg.');
      db.prepare('INSERT INTO cal_weights (user_id, date, kg) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET kg = excluded.kg').run(u.id, m[1], kg);
    }
    return { ok: true };
  });

  /* ---------- Importar / exportar ---------- */
  route('GET', '/cal/export', async (req) => {
    const u = calUser(req);
    const obj = rows => Object.fromEntries(rows.map(r => [r.id, parse(r.data)]));
    const p = db.prepare('SELECT data FROM cal_profile WHERE user_id = ?').get(u.id);
    return {
      format: 'gm-calorias-v1', exportedAt: now(), user: u.username,
      profile: (p && parse(p.data)) || { goals: {} },
      foods: obj(db.prepare('SELECT id, data FROM cal_foods WHERE user_id = ?').all(u.id)),
      entries: obj(db.prepare('SELECT id, data FROM cal_entries WHERE user_id = ? ORDER BY date').all(u.id)),
      weights: Object.fromEntries(db.prepare('SELECT date, kg FROM cal_weights WHERE user_id = ? ORDER BY date').all(u.id).map(r => [r.date, { date: r.date, kg: r.kg }]))
    };
  });

  // Suma (no reemplaza): mismos ids se actualizan, lo demás queda.
  route('POST', '/cal/import', async (req) => {
    const u = calUser(req);
    const b = await readBody(req, 4 * 1024 * 1024);
    if (!b || b.format !== 'gm-calorias-v1') fail(400, 'Ese archivo no es una exportación del contador.');
    const asList = x => Array.isArray(x) ? x : (x && typeof x === 'object' ? Object.entries(x).map(([id, v]) => Object.assign({ id }, v)) : []);
    const res = { foods: 0, entries: 0, weights: 0, skipped: 0, profile: false };
    db.exec('BEGIN');
    try {
      asList(b.foods).slice(0, 1000).forEach(f => {
        try {
          const id = ID_RE.test(String(f.id)) ? String(f.id) : newId();
          db.prepare('INSERT INTO cal_foods (user_id, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
            .run(u.id, id, JSON.stringify(cleanFood(f)), now());
          res.foods++;
        } catch (e) { res.skipped++; }
      });
      asList(b.entries).slice(0, 50000).forEach(x => {
        try { putEntry(u.id, ID_RE.test(String(x.id)) ? String(x.id) : newId(), cleanEntry(x)); res.entries++; } catch (e) { res.skipped++; }
      });
      asList(b.weights).slice(0, 20000).forEach(w => {
        const kg = r2(numv(w.kg)), date = validDate(w.date) ? w.date : w.id;
        if (!validDate(date) || kg < 30 || kg > 300) { res.skipped++; return; }
        db.prepare('INSERT INTO cal_weights (user_id, date, kg) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET kg = excluded.kg').run(u.id, date, kg);
        res.weights++;
      });
      if (b.profile && typeof b.profile === 'object') {
        db.prepare('INSERT INTO cal_profile (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
          .run(u.id, JSON.stringify(cleanProfile(b.profile)), now());
        res.profile = true;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return res;
  });

  /* ---------- IA ---------- */
  function takeAi(uid) {
    if (!AI_KEY()) fail(503, 'La estimación con IA no está configurada en el servidor.');
    const day = localDay(), info = aiInfo(uid);
    if (info.used >= info.limit) fail(429, `Llegaste a las ${info.limit} consultas de hoy. Mañana se renuevan.`);
    db.prepare('INSERT INTO cal_ai_usage (user_id, day, n) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET n = n + 1').run(uid, day);
    db.prepare('DELETE FROM cal_ai_usage WHERE day < ?').run(new Date(Date.parse(day) - 60 * DAY_MS).toISOString().slice(0, 10));
    return day;
  }
  function refundAi(uid, day) { db.prepare('UPDATE cal_ai_usage SET n = MAX(0, n - 1) WHERE user_id = ? AND day = ?').run(uid, day); }
  function cleanImage(img) {
    if (!img) return null;
    if (typeof img !== 'object' || !IMG_TYPES.includes(img.media_type) || typeof img.data !== 'string') fail(400, 'Imagen inválida.');
    if (img.data.length > 1400000 || !/^[A-Za-z0-9+/=]+$/.test(img.data)) fail(413, 'La foto es demasiado grande.');
    return { type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } };
  }
  async function askJson(prompt, image) {
    let url, headers, body;
    if (OR()) {
      // formato OpenAI de OpenRouter; la foto va como data URL
      const content = image ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:' + image.source.media_type + ';base64,' + image.source.data } }] : prompt;
      url = process.env.CAL_AI_URL || OR_URL;
      headers = { Authorization: 'Bearer ' + AI_KEY(), 'Content-Type': 'application/json', 'HTTP-Referer': 'https://giorgiomacri.com', 'X-Title': 'giorgiomacri.com calorias' };
      // poco razonamiento: si piensa mucho se come el límite de tokens y no queda respuesta
      body = { model: AI_MODEL(), max_tokens: 6000, reasoning: { effort: 'low', exclude: true }, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: 'Respondés únicamente con un objeto JSON válido, sin texto antes ni después, sin markdown y sin cuentas: solo números finales.' }, { role: 'user', content }] };
    } else {
      const content = image ? [image, { type: 'text', text: prompt }] : prompt;
      url = process.env.CAL_AI_URL || AI_URL;
      headers = { 'x-api-key': AI_KEY(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
      body = { model: AI_MODEL(), max_tokens: 4000, messages: [{ role: 'user', content }] };
    }
    let r;
    try {
      r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    } catch (e) { const x = new Error('net'); x.refund = true; throw x; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j && j.error && !j.choices && !j.content)) {
      console.error('IA calorías:', r.status, JSON.stringify(j && j.error || '').slice(0, 300));
      const x = new Error('api'); x.refund = true; x.status = r.ok ? 502 : r.status; throw x;
    }
    const msg = OR() && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
    const text = OR()
      ? (Array.isArray(msg) ? msg.map(c => c && c.text || '').join('') : String(msg || ''))
      : (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const out = extractJson(text);
    if (!out) {
      const fin = OR() && j.choices && j.choices[0] ? j.choices[0].finish_reason : j.stop_reason;
      console.error('IA calorías: respuesta sin JSON (fin: ' + fin + '):', JSON.stringify(text.slice(0, 400)));
      const x = new Error('parse'); throw x;
    }
    return out;
  }
  // Saca el JSON de la respuesta aunque venga con ```json, texto alrededor, comas de más o un array suelto
  function extractJson(text) {
    let t = String(text || '').replace(/```(?:json)?/gi, '').trim();
    const tries = [t];
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) tries.push(t.slice(a, b + 1));
    const c = t.indexOf('['), e = t.lastIndexOf(']');
    if (c >= 0 && e > c && (a < 0 || c < a)) tries.push(t.slice(c, e + 1));
    for (const x of tries) {
      for (const y of [x, x.replace(/,\s*([}\]])/g, '$1').replace(/\/\/[^\n]*/g, '')]) {
        const v = parse(y);
        if (Array.isArray(v)) return { items: v };
        if (v && typeof v === 'object') return v;
      }
    }
    return null;
  }
  async function runAi(req, build) {
    const u = calUser(req);
    if (rateLimited(req, 'cal-ai', 40)) fail(429, 'Demasiadas consultas seguidas. Probá en un rato.');
    const b = await readBody(req, 2 * 1024 * 1024);
    const text = str(b.text, 2000), image = cleanImage(b.image);
    if (!text && !image) fail(400, 'Escribí algo o subí una foto.');
    const day = takeAi(u.id);
    try {
      const prompt = build(u, text, !!image);
      let out;
      try { out = await askJson(prompt, image); }
      catch (e) { if (e.message !== 'parse') throw e; out = await askJson(prompt, image); } // un reintento si vino sin JSON
      return { result: out, ai: aiInfo(u.id) };
    } catch (e) {
      if (e.refund) refundAi(u.id, day);
      if (e.message === 'parse') fail(502, 'No entendí la respuesta. Probá de nuevo.');
      if (e.status === 429 || e.status === 529) fail(503, 'El servicio de IA está ocupado. Probá en un rato.');
      fail(502, 'No se pudo completar la estimación. Probá de nuevo.');
    }
  }

  route('POST', '/cal/ai/describe', async (req) => runAi(req, (u, text, photo) => {
    const lib = db.prepare('SELECT data FROM cal_foods WHERE user_id = ? ORDER BY updated_at DESC LIMIT 80').all(u.id)
      .map(r => parse(r.data)).filter(Boolean).map(f => ({ name: f.name, brand: f.brand || '', unit: f.unit || 'g', portionG: f.portionG || null, per100: f.per100 }));
    return `Sos un asistente de nutrición. Estimá los valores nutricionales de lo que comió la persona. Vive en Argentina: interpretá comidas, marcas y porciones típicas rioplatenses.
Si algún ítem coincide con un alimento de su lista guardada, usá esos valores exactos (están por 100 g o 100 ml) y escalalos a la cantidad descripta.
Lista guardada (JSON): ${JSON.stringify(lib)}
Descripción: ${JSON.stringify(text || '(ver foto)')}${photo ? '\nHay una foto del plato adjunta; usala para estimar porciones.' : ''}
Separá en ítems individuales. Respondé SOLO con JSON válido, sin texto extra, con esta forma:
{"items":[{"name":"string","qty":"porción asumida, ej: 2 unidades (~180 g)","kcal":0,"prot":0,"carb":0,"sug":0,"fat":0,"sat":0,"fib":0,"sod":0}]}
Valores totales para la cantidad comida. kcal en kilocalorías, sod en miligramos, el resto en gramos.`;
  }));

  route('POST', '/cal/ai/label', async (req) => runAi(req, (u, text) =>
    `Leé esta tabla de información nutricional de un producto envasado argentino.${text ? '\nTexto de la tabla:\n' + text : ''}
Respondé SOLO con JSON válido, sin texto extra:
{"name":"string o null","brand":"string o null","unit":"g" o "ml","portionG":número o null,"basis":"100" o "porcion","values":{"kcal":n,"prot":n,"carb":n,"sug":n,"fat":n,"sat":n,"fib":n,"sod":n}}
Si la tabla tiene columna por 100 g o 100 ml, usá esa y basis "100"; si solo trae valores por porción, basis "porcion". portionG es el tamaño de la porción en g o ml. Energía en kcal (no kJ), sodio en mg, el resto en gramos. Un nutriente que no figure va como null.`));

  /* ---------- Administración de cuentas ---------- */
  route('GET', '/admin/cal/users', async (req) => {
    requireAdmin(req);
    const day = localDay();
    const users = db.prepare(`SELECT u.id, u.username, u.created_at, u.disabled, u.last_login, u.is_admin, u.player_id,
        (SELECT name FROM players p WHERE p.id = u.player_id) player_name,
        (SELECT COUNT(*) FROM cal_entries e WHERE e.user_id = u.id) entries,
        (SELECT MAX(date) FROM cal_entries e WHERE e.user_id = u.id) last_entry,
        (SELECT n FROM cal_ai_usage a WHERE a.user_id = u.id AND a.day = ?) ai_today
      FROM cal_users u ORDER BY u.username`).all(day);
    users.forEach(x => { x.is_admin = x.username === AGENDA_USER ? 1 : 0; });
    const players = db.prepare('SELECT id, name FROM players ORDER BY name COLLATE NOCASE').all();
    return { users, players, ai: { enabled: !!AI_KEY(), provider: OR() ? 'OpenRouter' : 'Anthropic', model: AI_MODEL(), limit: AI_LIMIT() } };
  });
  route('POST', '/admin/cal/users', async (req) => {
    requireAdmin(req);
    const b = await readBody(req);
    const username = str(b.username, 40).toLowerCase(), pw = String(b.password || '');
    if (!USER_RE.test(username)) fail(400, 'El usuario va de 3 a 24 caracteres: letras minúsculas, números, punto, guion o guion bajo.');
    if (pw.length < 8 || pw.length > 200) fail(400, 'La contraseña tiene que tener al menos 8 caracteres.');
    if (db.prepare('SELECT 1 FROM cal_users WHERE username = ?').get(username)) fail(409, 'Ese usuario ya existe.');
    const r = db.prepare('INSERT INTO cal_users (username, pass_hash, created_at) VALUES (?, ?, ?)').run(username, hashPin(pw), now());
    return { id: Number(r.lastInsertRowid), username };
  });
  route('POST', '/admin/cal/users/(\\d+)', async (req, url, m) => {
    requireAdmin(req);
    const u = db.prepare('SELECT * FROM cal_users WHERE id = ?').get(+m[1]);
    if (!u) fail(404, 'Ese usuario no existe.');
    const b = await readBody(req);
    if (b.password !== undefined) {
      const pw = String(b.password);
      if (pw.length < 8 || pw.length > 200) fail(400, 'La contraseña tiene que tener al menos 8 caracteres.');
      db.prepare('UPDATE cal_users SET pass_hash = ? WHERE id = ?').run(hashPin(pw), u.id);
      db.prepare('DELETE FROM cal_sessions WHERE user_id = ?').run(u.id);
    }
    if (b.is_admin !== undefined) fail(400, 'El admin es fijo: solo la cuenta del dueño.');
    if (b.player_id !== undefined) {
      const pid = b.player_id ? +b.player_id : null;
      if (pid) {
        if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(pid)) fail(404, 'Ese jugador no existe.');
        const other = db.prepare('SELECT username FROM cal_users WHERE player_id = ? AND id != ?').get(pid, u.id);
        if (other) fail(409, `Ese jugador ya está unido a la cuenta ${other.username}.`);
      }
      db.prepare('UPDATE cal_users SET player_id = ? WHERE id = ?').run(pid, u.id);
    }
    if (b.reset_ai) db.prepare('DELETE FROM cal_ai_usage WHERE user_id = ? AND day = ?').run(u.id, localDay());
    if (b.disabled !== undefined) {
      if (b.disabled && u.is_admin) fail(400, 'No podés deshabilitar la cuenta de admin.');
      db.prepare('UPDATE cal_users SET disabled = ? WHERE id = ?').run(b.disabled ? 1 : 0, u.id);
      if (b.disabled) db.prepare('DELETE FROM cal_sessions WHERE user_id = ?').run(u.id);
    }
    return { ok: true };
  });
  route('DELETE', '/admin/cal/users/(\\d+)', async (req, url, m) => {
    requireAdmin(req);
    const id = +m[1];
    const target = db.prepare('SELECT is_admin FROM cal_users WHERE id = ?').get(id);
    if (target && target.is_admin) fail(400, 'No podés borrar la cuenta de admin.');
    ['cal_sessions', 'cal_profile', 'cal_foods', 'cal_entries', 'cal_weights', 'cal_ai_usage'].forEach(t => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id));
    db.prepare('DELETE FROM cal_users WHERE id = ?').run(id);
    return { ok: true };
  });
};
