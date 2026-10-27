'use strict';
// Asistente: chat con herramientas (OpenRouter) que carga calorías, maneja la agenda y propone cambios al código del sitio.
// Solo para el dueño. Los cambios de código quedan en espera hasta que el dueño toca "Publicar".
// Rutas bajo /api/sudoku/asistente/*.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const NUT = ['kcal', 'prot', 'carb', 'sug', 'fat', 'sat', 'fib', 'sod'];
const MEALS = ['Desayuno', 'Almuerzo', 'Merienda', 'Cena', 'Colación'];
const COLORS = ['persimmon', 'sage', 'blue', 'blush', 'candle'];
const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
const FILE_RE = /^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:html|css|js)$/;
const DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

module.exports = function install(d) {
  const { db, route, fail, readBody, rateLimited, sha, now, sessionFrom, validDate, DAY_MS, TZ_OFFSET_MIN, AGENDA_USER } = d;
  const KEY = () => process.env.OPENROUTER_API_KEY || '';
  const MODEL = () => process.env.CHAT_MODEL || process.env.CAL_AI_MODEL || 'deepseek/deepseek-v4.1-flash-1017';
  const OWNER = () => (process.env.CHAT_OWNER || AGENDA_USER || 'giorgio').trim().toLowerCase();
  const DAILY = () => Math.max(1, parseInt(process.env.CHAT_DAILY || '150', 10) || 150);
  const GH_TOKEN = () => process.env.GITHUB_TOKEN || '';
  const GH_REPO = () => process.env.CHAT_GIT_REPO || 'Giorgio1234/giorgiomacri.com';
  const WORK = process.env.CHAT_WORKDIR || path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, '..', 'x.db')), 'site-work');

  db.exec(`CREATE TABLE IF NOT EXISTS chat_usage (day TEXT PRIMARY KEY, n INTEGER NOT NULL);`);

  const numv = v => { const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0; };
  const r2 = v => Math.round(v * 100) / 100;
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const parse = s => { try { return JSON.parse(s); } catch (e) { return null; } };
  const localNow = () => new Date(now() + TZ_OFFSET_MIN * 60000);
  const localDay = () => localNow().toISOString().slice(0, 10);
  const dow = date => new Date(date + 'T12:00:00Z').getUTCDay();
  const uid = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  function needDate(x) { if (!validDate(x)) throw new ToolError('Fecha inválida (usá AAAA-MM-DD): ' + x); return x; }
  class ToolError extends Error {}

  /* ---------- Acceso: solo el dueño ---------- */
  function owner(req) {
    const s = sessionFrom(req);
    if (s && (s.is_admin === 2 || (s.account && s.account.is_admin))) return true; // sesión vieja de la agenda o cuenta admin
    fail(401, 'El asistente es solo para el admin. Entrá con tu cuenta.');
  }
  function calUid() {
    const u = db.prepare('SELECT id FROM cal_users WHERE username = ?').get(OWNER());
    if (!u) throw new ToolError(`No existe la cuenta de calorías "${OWNER()}". Hay que crearla en el panel de admin.`);
    return u.id;
  }

  /* ---------- Calorías ---------- */
  function cleanNut(o) { const r = {}; NUT.forEach(k => { r[k] = r2(Math.min(100000, Math.max(0, numv(o && o[k])))); }); return r; }
  const totals = list => { const t = {}; NUT.forEach(k => t[k] = 0); list.forEach(e => NUT.forEach(k => t[k] += numv(e.n && e.n[k]))); NUT.forEach(k => t[k] = r2(t[k])); return t; };
  function calEntries(u, from, to) {
    return db.prepare('SELECT id, data FROM cal_entries WHERE user_id = ? AND date >= ? AND date <= ?').all(u, from, to).map(r => Object.assign({ id: r.id }, parse(r.data)));
  }
  function calProfile(u) { const p = db.prepare('SELECT data FROM cal_profile WHERE user_id = ?').get(u); return (p && parse(p.data)) || { goals: {} }; }
  function putEntry(u, id, e) {
    db.prepare('INSERT INTO cal_entries (user_id, id, date, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET date = excluded.date, data = excluded.data, updated_at = excluded.updated_at')
      .run(u, id, e.date, JSON.stringify(e), now());
  }
  const short = e => ({ id: e.id, meal: e.meal, name: e.name, qty: e.qtyLabel, kcal: e.n.kcal, prot: e.n.prot, carb: e.n.carb, fat: e.n.fat });
  function getFood(u, id) { const r = db.prepare('SELECT data FROM cal_foods WHERE user_id = ? AND id = ?').get(u, id); return r ? parse(r.data) : null; }

  const T = {};
  T.cal_get_day = ({ date }) => {
    const u = calUid(); needDate(date);
    const list = calEntries(u, date, date).sort((a, b) => a.createdAt - b.createdAt);
    const w = db.prepare('SELECT kg FROM cal_weights WHERE user_id = ? AND date = ?').get(u, date);
    return { date, entries: list.map(short), totals: totals(list), goals: calProfile(u).goals || {}, weight_kg: w ? w.kg : null };
  };
  T.cal_summary = ({ from, to }) => {
    const u = calUid(); needDate(from); needDate(to);
    if (to < from || (Date.parse(to) - Date.parse(from)) / DAY_MS > 92) throw new ToolError('Rango inválido (máximo 92 días).');
    const by = {}; calEntries(u, from, to).forEach(e => (by[e.date] = by[e.date] || []).push(e));
    const days = Object.keys(by).sort().map(dd => Object.assign({ date: dd }, totals(by[dd])));
    const weights = db.prepare('SELECT date, kg FROM cal_weights WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date').all(u, from, to);
    const p = calProfile(u);
    return { days, weights, goals: p.goals || {}, weight_goal: p.weightGoal || null };
  };
  T.cal_search_foods = ({ query }) => {
    const u = calUid(), q = str(query, 60).toLowerCase();
    const all = db.prepare('SELECT id, data FROM cal_foods WHERE user_id = ?').all(u).map(r => Object.assign({ id: r.id }, parse(r.data)));
    const words = q.split(/\s+/).filter(Boolean);
    const hits = all.filter(f => { const t = (f.name + ' ' + (f.brand || '')).toLowerCase(); return !words.length || words.some(w => t.includes(w)); });
    return { foods: hits.slice(0, 30).map(f => ({ id: f.id, name: f.name, brand: f.brand, unit: f.unit, portion: f.portionG, per100: f.per100 })) };
  };
  T.cal_add_entries = ({ date, entries }, act) => {
    const u = calUid(); needDate(date);
    if (!Array.isArray(entries) || !entries.length) throw new ToolError('Faltan los alimentos.');
    const out = entries.slice(0, 30).map((x, i) => {
      const e = { date, meal: MEALS.includes(x.meal) ? x.meal : 'Colación', name: str(x.name, 120) || 'Sin nombre', qtyLabel: str(x.qty, 120), createdAt: now() + i };
      const f = x.food_id ? getFood(u, String(x.food_id)) : null;
      if (f && numv(x.amount) > 0) {
        const grams = numv(x.amount) * (x.amount_unit === 'porciones' && f.portionG ? f.portionG : 1);
        e.foodId = String(x.food_id); e.name = f.name;
        e.qtyLabel = x.amount_unit === 'porciones' && f.portionG ? `${numv(x.amount)} ${numv(x.amount) === 1 ? 'porción' : 'porciones'} (${r2(grams)} ${f.unit || 'g'})` : `${r2(grams)} ${f.unit || 'g'}`;
        e.n = {}; NUT.forEach(k => e.n[k] = r2(numv(f.per100 && f.per100[k]) * grams / 100));
      } else {
        e.n = cleanNut(x);
        if (!e.qtyLabel.includes('estimado') && !x.food_id) e.qtyLabel = (e.qtyLabel ? e.qtyLabel + ' ' : '') + '(estimado)';
      }
      const id = 'e' + uid(); putEntry(u, id, e);
      return Object.assign({ id }, e);
    });
    act('calorias', `Agregué ${out.length === 1 ? out[0].name : out.length + ' alimentos'} (${Math.round(out.reduce((a, e) => a + e.n.kcal, 0))} kcal) al ${date}`);
    return { added: out.map(short), day_totals: totals(calEntries(u, date, date)) };
  };
  T.cal_update_entry = (x, act) => {
    const u = calUid();
    const r = db.prepare('SELECT data FROM cal_entries WHERE user_id = ? AND id = ?').get(u, String(x.id));
    if (!r) throw new ToolError('No existe ese registro.');
    const e = parse(r.data);
    if (x.date) e.date = needDate(x.date);
    if (MEALS.includes(x.meal)) e.meal = x.meal;
    if (x.name) e.name = str(x.name, 120);
    if (x.qty !== undefined) e.qtyLabel = str(x.qty, 120);
    if (numv(x.factor) > 0) NUT.forEach(k => e.n[k] = r2(numv(e.n[k]) * numv(x.factor)));
    NUT.forEach(k => { if (x[k] !== undefined && x[k] !== null) e.n[k] = r2(Math.max(0, numv(x[k]))); });
    putEntry(u, String(x.id), e);
    act('calorias', `Actualicé "${e.name}"`);
    return { updated: short(Object.assign({ id: x.id }, e)) };
  };
  T.cal_delete_entries = ({ ids }, act) => {
    const u = calUid(); let n = 0;
    (Array.isArray(ids) ? ids : []).slice(0, 50).forEach(id => { n += db.prepare('DELETE FROM cal_entries WHERE user_id = ? AND id = ?').run(u, String(id)).changes; });
    if (n) act('calorias', `Borré ${n} ${n === 1 ? 'registro' : 'registros'}`);
    return { deleted: n };
  };
  T.cal_log_weight = ({ date, kg }, act) => {
    const u = calUid(); needDate(date); const v = r2(numv(kg));
    if (v < 30 || v > 300) throw new ToolError('Peso fuera de rango.');
    db.prepare('INSERT INTO cal_weights (user_id, date, kg) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET kg = excluded.kg').run(u, date, v);
    act('calorias', `Anoté ${v} kg el ${date}`);
    return { ok: true };
  };
  T.cal_set_goals = (x, act) => {
    const u = calUid(); const p = calProfile(u); p.goals = p.goals || {};
    NUT.forEach(k => { if (x[k] !== undefined && x[k] !== null) { const v = numv(x[k]); if (v > 0) p.goals[k] = r2(v); else delete p.goals[k]; } });
    db.prepare('INSERT INTO cal_profile (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(u, JSON.stringify(p), now());
    act('calorias', 'Cambié tus objetivos diarios');
    return { goals: p.goals };
  };

  /* ---------- Agenda ---------- */
  const blankDay = () => ({ priorities: [{ text: '', done: false }, { text: '', done: false }, { text: '', done: false }], tasks: [], events: [], skip: [], habitsDone: [], notes: '' });
  function agDay(date) {
    const r = db.prepare('SELECT data FROM agenda_days WHERE date = ?').get(date);
    const x = Object.assign(blankDay(), (r && parse(r.data)) || {});
    if (!Array.isArray(x.priorities) || x.priorities.length !== 3) x.priorities = blankDay().priorities;
    ['tasks', 'events', 'skip', 'habitsDone'].forEach(k => { if (!Array.isArray(x[k])) x[k] = []; });
    if (typeof x.notes !== 'string') x.notes = '';
    return x;
  }
  function agSave(date, x) {
    const empty = !x.priorities.some(p => p && p.text) && !x.tasks.length && !x.events.length && !x.skip.length && !x.habitsDone.length && !x.notes;
    if (empty) db.prepare('DELETE FROM agenda_days WHERE date = ?').run(date);
    else db.prepare('INSERT INTO agenda_days (date, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(date, JSON.stringify({ priorities: x.priorities, tasks: x.tasks.slice(0, 200), events: x.events.slice(0, 100), skip: x.skip, habitsDone: x.habitsDone, notes: x.notes.slice(0, 20000) }), now());
  }
  function agSetting(key) { const r = db.prepare('SELECT data FROM agenda_settings WHERE key = ?').get(key); return (r && parse(r.data)) || []; }
  function agPutSetting(key, val) {
    db.prepare('INSERT INTO agenda_settings (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(key, JSON.stringify(val), now());
  }
  function occurs(r, date) {
    if (r.from && date < r.from) return false;
    const w = dow(date);
    return r.repeat === 'daily' || (r.repeat === 'weekdays' && w >= 1 && w <= 5) || (r.repeat === 'weekly' && w === r.dow);
  }
  T.agenda_get_day = ({ date }) => {
    needDate(date); const x = agDay(date), rec = agSetting('recurring'), habits = agSetting('habits');
    const events = x.events.map(e => ({ id: e.id, title: e.title, start: e.start, end: e.end, color: e.color, repeats: 'no' }))
      .concat(rec.filter(r => occurs(r, date) && !x.skip.includes(r.id)).map(r => ({ id: r.id, title: r.title, start: r.start, end: r.end, color: r.color, repeats: r.repeat })))
      .sort((a, b) => a.start.localeCompare(b.start));
    return { date, weekday: DOW[dow(date)], priorities: x.priorities, tasks: x.tasks, events, habits: habits.map(h => ({ name: h.name, done: x.habitsDone.includes(h.id) })), notes: x.notes };
  };
  T.agenda_add_tasks = ({ date, tasks }, act) => {
    needDate(date); const x = agDay(date);
    const add = (Array.isArray(tasks) ? tasks : [tasks]).map(t => str(t, 200)).filter(Boolean).slice(0, 30);
    if (!add.length) throw new ToolError('Faltan las tareas.');
    add.forEach(t => x.tasks.push({ id: uid(), text: t, done: false }));
    agSave(date, x); act('agenda', `Agregué ${add.length === 1 ? '"' + add[0] + '"' : add.length + ' tareas'} el ${date}`);
    return { tasks: x.tasks };
  };
  T.agenda_update_task = ({ date, id, text, done, delete: del }, act) => {
    needDate(date); const x = agDay(date), t = x.tasks.find(y => y.id === id);
    if (!t) throw new ToolError('No existe esa tarea ese día.');
    if (del) x.tasks = x.tasks.filter(y => y !== t);
    else { if (text) t.text = str(text, 200); if (typeof done === 'boolean') t.done = done; }
    agSave(date, x); act('agenda', del ? `Borré la tarea "${t.text}"` : `Actualicé la tarea "${t.text}"`);
    return { tasks: x.tasks };
  };
  T.agenda_move_task = ({ from_date, id, to_date }, act) => {
    needDate(from_date); needDate(to_date);
    const a = agDay(from_date), t = a.tasks.find(y => y.id === id);
    if (!t) throw new ToolError('No existe esa tarea ese día.');
    a.tasks = a.tasks.filter(y => y !== t); agSave(from_date, a);
    const b = agDay(to_date); b.tasks.push(Object.assign({}, t, { id: uid() })); agSave(to_date, b);
    act('agenda', `Pasé "${t.text}" al ${to_date}`);
    return { ok: true };
  };
  T.agenda_set_priority = ({ date, position, text, done }, act) => {
    needDate(date); const i = Math.round(numv(position)) - 1;
    if (i < 0 || i > 2) throw new ToolError('position va de 1 a 3.');
    const x = agDay(date);
    if (text !== undefined) x.priorities[i].text = str(text, 200);
    if (typeof done === 'boolean') x.priorities[i].done = done;
    agSave(date, x); act('agenda', `Prioridad ${i + 1} del ${date}: ${x.priorities[i].text || '(vacía)'}`);
    return { priorities: x.priorities };
  };
  T.agenda_add_block = ({ date, title, start, end, color, repeat }, act) => {
    needDate(date); title = str(title, 80);
    if (!title) throw new ToolError('Falta el título.');
    if (!TIME_RE.test(start) || !TIME_RE.test(end) || end <= start) throw new ToolError('Horario inválido: usá HH:MM y que el fin sea después del inicio.');
    const c = COLORS.includes(color) ? color : 'persimmon';
    if (!repeat || repeat === 'none') {
      const x = agDay(date); x.events.push({ id: uid(), title, start, end, color: c }); agSave(date, x);
    } else {
      if (!['daily', 'weekdays', 'weekly'].includes(repeat)) throw new ToolError('repeat: none, daily, weekdays o weekly.');
      const rec = agSetting('recurring'); rec.push({ id: uid(), repeat, dow: dow(date), from: date, title, start, end, color: c }); agPutSetting('recurring', rec.slice(0, 200));
    }
    act('agenda', `Agregué "${title}" ${start}–${end}${repeat && repeat !== 'none' ? ' (se repite)' : ''} el ${date}`);
    return { ok: true };
  };
  T.agenda_remove_block = ({ date, id, all_repeats }, act) => {
    needDate(date); const x = agDay(date);
    const one = x.events.find(e => e.id === id);
    if (one) { x.events = x.events.filter(e => e !== one); agSave(date, x); act('agenda', `Saqué "${one.title}" del ${date}`); return { ok: true }; }
    const rec = agSetting('recurring'), r = rec.find(e => e.id === id);
    if (!r) throw new ToolError('No existe ese bloque.');
    if (all_repeats) { agPutSetting('recurring', rec.filter(e => e !== r)); act('agenda', `Borré "${r.title}" de todos los días`); }
    else { if (!x.skip.includes(id)) x.skip.push(id); agSave(date, x); act('agenda', `Saqué "${r.title}" solo del ${date}`); }
    return { ok: true };
  };
  T.agenda_add_note = ({ date, text, replace }, act) => {
    needDate(date); const x = agDay(date), t = str(text, 5000);
    x.notes = replace ? t : (x.notes ? x.notes.replace(/\s+$/, '') + '\n' : '') + t;
    agSave(date, x); act('agenda', `Anoté en las notas del ${date}`);
    return { notes: x.notes };
  };
  T.agenda_set_habit = ({ date, habit, done }, act) => {
    needDate(date); const habits = agSetting('habits');
    const h = habits.find(y => y.name.toLowerCase() === str(habit, 60).toLowerCase()) || habits.find(y => y.name.toLowerCase().includes(str(habit, 60).toLowerCase()));
    if (!h) throw new ToolError('No existe ese hábito. Hábitos: ' + habits.map(y => y.name).join(', '));
    const x = agDay(date); x.habitsDone = x.habitsDone.filter(y => y !== h.id); if (done !== false) x.habitsDone.push(h.id);
    agSave(date, x); act('agenda', `${done === false ? 'Desmarqué' : 'Marqué'} "${h.name}" el ${date}`);
    return { ok: true };
  };

  /* ---------- Código del sitio (en espera hasta "Publicar") ---------- */
  function git(args, opts = {}) {
    const auth = GH_TOKEN() ? ['-c', 'http.extraHeader=Authorization: Basic ' + Buffer.from('x-access-token:' + GH_TOKEN()).toString('base64')] : [];
    return new Promise((resolve, reject) => {
      execFile('git', auth.concat(['-c', 'user.name=Asistente giorgiomacri.com', '-c', 'user.email=asistente@giorgiomacri.com'], args),
        { cwd: opts.cwd || WORK, timeout: 60000, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: path.dirname(WORK), GIT_TERMINAL_PROMPT: '0' } },
        (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).replace(/Authorization: Basic \S+/g, '***').slice(0, 600))) : resolve(stdout));
    });
  }
  const remote = () => process.env.CHAT_GIT_URL || `https://github.com/${GH_REPO()}.git`;
  let gitBusy = Promise.resolve();
  const serial = fn => { const p = gitBusy.then(fn, fn); gitBusy = p.catch(() => {}); return p; };
  async function ensureRepo() {
    if (!GH_TOKEN() && !process.env.CHAT_GIT_URL) throw new ToolError('Para tocar el código falta GITHUB_TOKEN en el servidor.');
    if (!fs.existsSync(path.join(WORK, '.git'))) {
      fs.mkdirSync(path.dirname(WORK), { recursive: true });
      await git(['clone', '--quiet', '--depth', '50', remote(), WORK], { cwd: path.dirname(WORK) });
    }
  }
  async function pendingDiff() { return (await git(['status', '--porcelain'])).trim(); }
  async function freshIfClean() {
    await ensureRepo();
    if (!(await pendingDiff())) { await git(['fetch', '--quiet', 'origin', 'main']); await git(['reset', '--quiet', '--hard', 'origin/main']); }
  }
  function safePath(p) {
    p = String(p || '').replace(/^\.?\//, '');
    if (!FILE_RE.test(p) || p.includes('..')) throw new ToolError('Solo se pueden tocar archivos .html, .css o .js dentro de src/.');
    return p;
  }
  let codeReady = false;
  async function code() { if (!codeReady) { await serial(freshIfClean); codeReady = true; } }
  T.site_list_files = async () => {
    await code();
    const out = [];
    const walk = dir => fs.readdirSync(path.join(WORK, dir), { withFileTypes: true }).forEach(e => {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) walk(rel); else out.push({ path: rel, lines: fs.readFileSync(path.join(WORK, rel), 'utf8').split('\n').length });
    });
    walk('src');
    const pages = /const PAGES = \[([\s\S]*?)\];/.exec(fs.readFileSync(path.join(WORK, 'build.js'), 'utf8'));
    return { files: out, pages_in_build: pages ? pages[1].replace(/\s+/g, ' ').trim() : '' };
  };
  T.site_read_file = async ({ path: p, from_line, to_line }) => {
    await code(); p = safePath(p);
    const f = path.join(WORK, p); if (!fs.existsSync(f)) throw new ToolError('No existe ' + p);
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const a = Math.max(1, Math.round(numv(from_line)) || 1), b = Math.min(lines.length, Math.round(numv(to_line)) || a + 399, a + 599);
    return { path: p, total_lines: lines.length, from_line: a, to_line: b, text: lines.slice(a - 1, b).map((l, i) => (a + i) + '\t' + l).join('\n') };
  };
  T.site_search = async ({ text }) => {
    await code(); const q = String(text || ''); if (q.length < 2) throw new ToolError('Buscá al menos 2 caracteres.');
    const hits = [];
    const walk = dir => fs.readdirSync(path.join(WORK, dir), { withFileTypes: true }).forEach(e => {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) return walk(rel);
      fs.readFileSync(path.join(WORK, rel), 'utf8').split('\n').forEach((l, i) => { if (hits.length < 60 && l.includes(q)) hits.push(rel + ':' + (i + 1) + ': ' + l.trim().slice(0, 200)); });
    });
    walk('src');
    return { matches: hits };
  };
  T.site_edit_file = async ({ path: p, old_text, new_text }, act) => {
    await code(); p = safePath(p);
    const f = path.join(WORK, p); if (!fs.existsSync(f)) throw new ToolError('No existe ' + p + '. Para un archivo nuevo usá site_create_file.');
    const s = fs.readFileSync(f, 'utf8'), o = String(old_text ?? '');
    if (!o) throw new ToolError('old_text vacío.');
    const n = s.split(o).length - 1;
    if (n !== 1) throw new ToolError(n ? `old_text aparece ${n} veces; agregá más contexto para que sea único.` : 'old_text no aparece tal cual en el archivo. Leelo de nuevo y copiá el texto exacto.');
    fs.writeFileSync(f, s.replace(o, () => String(new_text ?? '')));
    act('site', `Edité ${p}`);
    return { ok: true };
  };
  T.site_create_file = async ({ path: p, content }, act) => {
    await code(); p = safePath(p);
    const f = path.join(WORK, p); if (fs.existsSync(f)) throw new ToolError('Ya existe ' + p + '; usá site_edit_file.');
    if (String(content || '').length > 300000) throw new ToolError('Archivo demasiado grande.');
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String(content || ''));
    act('site', `Creé ${p}`);
    return { ok: true };
  };
  T.site_add_page = async ({ source, url_path }, act) => {
    await code();
    const src = safePath('src/' + String(source || '').replace(/^src\//, ''));
    const dir = String(url_path || '').replace(/^\/+|\/+$/g, '');
    if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(dir)) throw new ToolError('url_path inválido, ej: "recetas" o "juegos/memoria".');
    const bf = path.join(WORK, 'build.js'), s = fs.readFileSync(bf, 'utf8');
    const entry = `['${src.slice(4)}', '${dir}/index.html']`;
    if (s.includes(`'${dir}/index.html'`)) throw new ToolError('Ya hay una página en /' + dir + '/.');
    const m = /(const PAGES = \[[\s\S]*?)(\n\];)/.exec(s);
    if (!m) throw new ToolError('No encontré PAGES en build.js.');
    fs.writeFileSync(bf, s.replace(m[0], m[1] + ',\n  ' + entry + m[2]));
    act('site', `Sumé /${dir}/ a las páginas`);
    return { ok: true, note: 'Acordate de sumarla también a ITEMS en src/home.html para que aparezca en la portada.' };
  };
  async function build() {
    await new Promise((resolve, reject) => execFile(process.execPath, ['build.js'], { cwd: WORK, timeout: 60000 }, (err, out, se) => err ? reject(new ToolError('Falló node build.js: ' + (se || err.message).slice(0, 800))) : resolve(out)));
  }
  async function status() {
    if (!fs.existsSync(path.join(WORK, '.git'))) return { pending: false };
    await git(['add', '-A']);
    const stat = (await git(['diff', '--cached', '--stat', 'HEAD'])).trim();
    if (!stat) return { pending: false };
    const diff = await git(['diff', '--cached', 'HEAD', '--', 'src', 'build.js']);
    await git(['reset', '--quiet']);
    return { pending: true, stat, diff: diff.slice(0, 60000), truncated: diff.length > 60000 };
  }
  T.site_check = async () => {
    await code(); await build();
    const st = await status();
    return st.pending ? { ok: true, built: true, files: st.stat, note: 'Los cambios están listos y esperan que el dueño toque "Publicar" en el chat.' } : { ok: true, pending: false, note: 'No hay cambios.' };
  };

  /* ---------- Herramientas (esquema para el modelo) ---------- */
  const S = (props, req) => ({ type: 'object', properties: props, required: req || [] });
  const date = { type: 'string', description: 'AAAA-MM-DD' };
  const nutProps = {}; NUT.forEach(k => nutProps[k] = { type: 'number' });
  const TOOLS = {
    cal_get_day: ['Registros de comida, totales, objetivos y peso de un día.', S({ date }, ['date'])],
    cal_summary: ['Totales por día y pesadas en un rango (máx 92 días).', S({ from: date, to: date }, ['from', 'to'])],
    cal_search_foods: ['Busca en Mis alimentos (valores por 100 g/ml). Usalo antes de estimar algo que pueda estar guardado.', S({ query: { type: 'string' } }, ['query'])],
    cal_add_entries: ['Agrega comidas a un día. Si es un alimento guardado pasá food_id y amount (+ amount_unit "g" o "porciones") y el servidor calcula. Si no, pasá tu estimación total para la cantidad comida (kcal, prot, carb, sug, fat, sat, fib en g, sod en mg).',
      S({ date, entries: { type: 'array', items: S(Object.assign({ meal: { type: 'string', enum: MEALS }, name: { type: 'string' }, qty: { type: 'string', description: 'porción, ej "2 unidades (~180 g)"' }, food_id: { type: 'string' }, amount: { type: 'number' }, amount_unit: { type: 'string', enum: ['g', 'porciones'] } }, nutProps), ['meal', 'name']) } }, ['date', 'entries'])],
    cal_update_entry: ['Cambia un registro: comida, nombre, porción, valores, o multiplica todo con factor.', S(Object.assign({ id: { type: 'string' }, date, meal: { type: 'string', enum: MEALS }, name: { type: 'string' }, qty: { type: 'string' }, factor: { type: 'number' } }, nutProps), ['id'])],
    cal_delete_entries: ['Borra registros por id.', S({ ids: { type: 'array', items: { type: 'string' } } }, ['ids'])],
    cal_log_weight: ['Anota el peso de un día.', S({ date, kg: { type: 'number' } }, ['date', 'kg'])],
    cal_set_goals: ['Cambia objetivos diarios (0 lo quita).', S(nutProps)],
    agenda_get_day: ['Prioridades, tareas, bloques (incluye repetidos), hábitos y notas de un día.', S({ date }, ['date'])],
    agenda_add_tasks: ['Agrega tareas a un día.', S({ date, tasks: { type: 'array', items: { type: 'string' } } }, ['date', 'tasks'])],
    agenda_update_task: ['Edita, marca hecha o borra una tarea (id de agenda_get_day).', S({ date, id: { type: 'string' }, text: { type: 'string' }, done: { type: 'boolean' }, delete: { type: 'boolean' } }, ['date', 'id'])],
    agenda_move_task: ['Pasa una tarea a otro día.', S({ from_date: date, id: { type: 'string' }, to_date: date }, ['from_date', 'id', 'to_date'])],
    agenda_set_priority: ['Pone el texto o el estado de una de las 3 prioridades del día.', S({ date, position: { type: 'integer', minimum: 1, maximum: 3 }, text: { type: 'string' }, done: { type: 'boolean' } }, ['date', 'position'])],
    agenda_add_block: ['Agrega un bloque horario. repeat: none, daily, weekdays (lun a vie) o weekly (mismo día de la semana que date, desde date).',
      S({ date, title: { type: 'string' }, start: { type: 'string', description: 'HH:MM' }, end: { type: 'string', description: 'HH:MM' }, color: { type: 'string', enum: COLORS }, repeat: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly'] } }, ['date', 'title', 'start', 'end'])],
    agenda_remove_block: ['Saca un bloque. Si se repite, all_repeats=true lo borra de todos los días; si no, solo de ese día.', S({ date, id: { type: 'string' }, all_repeats: { type: 'boolean' } }, ['date', 'id'])],
    agenda_add_note: ['Agrega texto a las notas del día (replace=true reemplaza todo).', S({ date, text: { type: 'string' }, replace: { type: 'boolean' } }, ['date', 'text'])],
    agenda_set_habit: ['Marca o desmarca un hábito en un día.', S({ date, habit: { type: 'string' }, done: { type: 'boolean' } }, ['date', 'habit'])],
    site_list_files: ['Lista los archivos fuente del sitio (src/) y las páginas de build.js.', S({})],
    site_read_file: ['Lee un archivo de src/ con números de línea (hasta 600 líneas por vez).', S({ path: { type: 'string' }, from_line: { type: 'integer' }, to_line: { type: 'integer' } }, ['path'])],
    site_search: ['Busca un texto exacto en src/.', S({ text: { type: 'string' } }, ['text'])],
    site_edit_file: ['Reemplaza un fragmento exacto y único de un archivo de src/. Copiá old_text tal cual (sin los números de línea).', S({ path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, ['path', 'old_text', 'new_text'])],
    site_create_file: ['Crea un archivo nuevo en src/ (html, css o js).', S({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content'])],
    site_add_page: ['Registra una página nueva en build.js: source es el archivo en src/ (ej "recetas.html"), url_path la ruta (ej "recetas").', S({ source: { type: 'string' }, url_path: { type: 'string' } }, ['source', 'url_path'])],
    site_check: ['Arma el sitio con los cambios para verificar que no se rompió nada. Llamalo al terminar de editar. NO publica: publica el dueño con el botón.', S({})]
  };
  const toolList = Object.entries(TOOLS).map(([name, [description, parameters]]) => ({ type: 'function', function: { name, description, parameters } }));

  function systemPrompt(ctx) {
    const ln = localNow(), today = ln.toISOString().slice(0, 10);
    return `Sos el asistente personal de Giorgio en su sitio giorgiomacri.com. Hablás en español rioplatense, corto y directo.
Hoy es ${DOW[dow(today)]} ${today}, son las ${ln.toISOString().slice(11, 16)} (hora de Argentina). "Ayer", "mañana", "el jueves" se calculan desde hoy.
${ctx && ctx.page ? `Giorgio te escribe desde ${ctx.page}${ctx.date ? ', mirando el día ' + ctx.date : ''}.` : ''}

Podés:
1. Contador de calorías: agregar, cambiar y borrar comidas, anotar el peso, cambiar objetivos. Comidas: ${MEALS.join(', ')}. Si no dice cuál, elegí según la hora (antes de 11 Desayuno, 11-15 Almuerzo, 15-19 Merienda, después Cena). Buscá primero en Mis alimentos (cal_search_foods) y si está usá food_id + amount. Si no, estimá vos con porciones típicas argentinas; valores totales para lo que comió. Después de agregar, decí en una línea cuántas kcal sumó y cómo va el día contra el objetivo.
2. Agenda: tareas, 3 prioridades, bloques horarios (colores: ${COLORS.join(', ')}), hábitos y notas. Para editar o borrar algo, primero leé el día para tener los ids.
3. Código del sitio: el sitio es un catálogo de herramientas; no habla de quién es Giorgio. Fuentes en src/ (una página por archivo .html, sin <!doctype>: empieza con <title>, luego <style> y el contenido; build.js agrega el esqueleto). CSS y JS compartidos en src/shared/ se insertan con marcadores /*@shared/archivo*/. La portada es src/home.html: cada herramienta es un objeto en ITEMS (id, name, url, cat, tag, desc, art, color, featured, keywords). Paleta: persimmon #fd9b65, sage #9ac8ae, candle #f8f5d1, blush #e9d1c7, blue #004b82; fuente Inter Tight; tema oscuro por defecto con claro via data-theme y prefers-color-scheme; tiene que andar bien en celular. No podés tocar el servidor ni la configuración. Antes de editar, leé el archivo. Editá con cambios chicos y exactos (site_edit_file). Al terminar llamá a site_check. Los cambios NO se publican solos: quedan esperando que Giorgio toque "Publicar" en el chat; decíselo.

Reglas: usá las herramientas en vez de inventar datos. Si algo es ambiguo y equivocarse importa (borrar cosas, cambiar mucho código), preguntá antes. No uses tablas ni títulos; texto corto, como mucho una lista breve.`;
  }

  /* ---------- Modelo ---------- */
  async function complete(messages) {
    let r;
    try {
      r = await fetch(process.env.CHAT_AI_URL || OR_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json', 'HTTP-Referer': 'https://giorgiomacri.com', 'X-Title': 'giorgiomacri.com asistente' },
        body: JSON.stringify({ model: MODEL(), messages, tools: toolList, tool_choice: 'auto', max_tokens: 6000 }),
        signal: AbortSignal.timeout(120000)
      });
    } catch (e) { throw new Error('No hay conexión con el modelo.'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.choices || !j.choices[0]) {
      console.error('Asistente:', r.status, JSON.stringify(j.error || j).slice(0, 400));
      throw new Error(r.status === 402 ? 'Se terminó el saldo de OpenRouter.' : r.status === 429 ? 'El modelo está ocupado. Probá en un rato.' : 'El modelo no respondió bien. Probá de nuevo.');
    }
    return j.choices[0].message;
  }
  const LABEL = { cal: 'Revisando tus calorías', agenda: 'Revisando la agenda', site: 'Trabajando en el código' };
  async function runChat(job, history, ctx) {
    const messages = [{ role: 'system', content: systemPrompt(ctx) }].concat(history);
    const act = (kind, text) => job.actions.push({ kind, text });
    for (let round = 0; round < 24; round++) {
      job.step = round ? 'Pensando…' : 'Pensando…';
      const msg = await complete(messages);
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const content = Array.isArray(msg.content) ? msg.content.map(c => c && c.text || '').join('') : String(msg.content || '');
      if (!calls.length) { job.reply = content.trim() || 'Listo.'; return; }
      messages.push({ role: 'assistant', content: content || null, tool_calls: calls });
      for (const c of calls) {
        const name = c.function && c.function.name, fn = T[name];
        let out;
        job.step = LABEL[String(name).split('_')[0]] || 'Trabajando…';
        try {
          if (!fn) throw new ToolError('No existe la herramienta ' + name);
          const args = parse((c.function.arguments) || '{}');
          if (!args || typeof args !== 'object') throw new ToolError('Argumentos inválidos (tienen que ser JSON).');
          out = await fn(args, act);
        } catch (e) {
          if (!(e instanceof ToolError)) console.error('Asistente herramienta', name, e);
          out = { error: e instanceof ToolError ? e.message : 'Falló: ' + String(e.message || e).slice(0, 300) };
        }
        messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(out).slice(0, 60000) });
      }
    }
    job.reply = 'Corté porque estaba dando demasiadas vueltas. Decime cómo seguimos.';
  }

  /* ---------- Rutas ---------- */
  const jobs = new Map();
  setInterval(() => { const t = Date.now(); for (const [k, j] of jobs) if (t - j.at > 15 * 60000) jobs.delete(k); }, 60000).unref();

  route('GET', '/asistente/status', async (req) => {
    owner(req);
    let site = { pending: false };
    try { site = await serial(status); } catch (e) {}
    const u = db.prepare('SELECT n FROM chat_usage WHERE day = ?').get(localDay());
    return { enabled: !!KEY(), model: MODEL(), code: !!(GH_TOKEN() || process.env.CHAT_GIT_URL), used: u ? u.n : 0, limit: DAILY(), site };
  });

  route('POST', '/asistente/chat', async (req) => {
    owner(req);
    if (!KEY()) fail(503, 'Falta OPENROUTER_API_KEY en el servidor.');
    if (rateLimited(req, 'chat', 60)) fail(429, 'Demasiados mensajes seguidos. Esperá unos minutos.');
    const b = await readBody(req, 512 * 1024);
    const hist = (Array.isArray(b.messages) ? b.messages : []).slice(-30)
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
    if (!hist.length || hist[hist.length - 1].role !== 'user') fail(400, 'Falta tu mensaje.');
    const day = localDay(), u = db.prepare('SELECT n FROM chat_usage WHERE day = ?').get(day);
    if (u && u.n >= DAILY()) fail(429, `Llegaste a los ${DAILY()} mensajes de hoy.`);
    db.prepare('INSERT INTO chat_usage (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1').run(day);
    const ctx = { page: str(b.page, 40), date: validDate(b.date) ? b.date : '' };
    const id = crypto.randomBytes(12).toString('hex');
    const job = { at: Date.now(), done: false, step: 'Pensando…', actions: [], reply: '', error: '' };
    jobs.set(id, job);
    codeReady = false;
    runChat(job, hist, ctx).catch(e => { job.error = e.message || 'Algo falló.'; }).finally(() => { job.done = true; });
    return { job: id };
  });

  route('GET', '/asistente/job/([a-f0-9]{24})', async (req, url, m) => {
    owner(req);
    const j = jobs.get(m[1]); if (!j) fail(404, 'Esa respuesta ya no está.');
    const out = { done: j.done, step: j.step, actions: j.actions, reply: j.reply, error: j.error };
    if (j.done && j.actions.some(a => a.kind === 'site')) { try { out.site = await serial(status); } catch (e) {} }
    return out;
  });

  route('POST', '/asistente/site/publish', async (req) => {
    owner(req);
    const b = await readBody(req);
    const msg = str(b.message, 120) || 'Cambio desde el asistente';
    return serial(async () => {
      await ensureRepo();
      if (!(await pendingDiff())) fail(400, 'No hay cambios para publicar.');
      try { await build(); } catch (e) { fail(400, e.message); }
      await git(['add', '-A']);
      await git(['commit', '--quiet', '-m', 'Asistente: ' + msg]);
      try { await git(['push', '--quiet', 'origin', 'HEAD:main']); }
      catch (e) {
        // alguien publicó mientras tanto: traer y reintentar una vez
        try { await git(['pull', '--quiet', '--rebase', 'origin', 'main']); await build(); await git(['add', '-A']); await git(['commit', '--quiet', '--amend', '--no-edit']).catch(() => {}); await git(['push', '--quiet', 'origin', 'HEAD:main']); }
        catch (e2) { await git(['rebase', '--abort']).catch(() => {}); await git(['reset', '--quiet', '--soft', 'HEAD~1']).catch(() => {}); fail(409, 'No pude publicar porque el sitio cambió mientras tanto. Descartá y pedilo de nuevo. (' + e2.message.slice(0, 160) + ')'); }
      }
      const sha1 = (await git(['rev-parse', '--short', 'HEAD'])).trim();
      return { ok: true, commit: sha1 };
    });
  });

  route('POST', '/asistente/site/discard', async (req) => {
    owner(req);
    return serial(async () => {
      await ensureRepo();
      await git(['reset', '--quiet', '--hard', 'HEAD']); await git(['clean', '-fdq']);
      await git(['fetch', '--quiet', 'origin', 'main']); await git(['reset', '--quiet', '--hard', 'origin/main']);
      return { ok: true };
    });
  });

  route('POST', '/asistente/site/undo', async (req) => {
    owner(req);
    return serial(async () => {
      await ensureRepo();
      if (await pendingDiff()) fail(400, 'Primero publicá o descartá los cambios en espera.');
      await git(['fetch', '--quiet', 'origin', 'main']); await git(['reset', '--quiet', '--hard', 'origin/main']);
      const last = (await git(['log', '-1', '--format=%H%x09%s'])).trim().split('\t');
      if (!/^Asistente: /.test(last[1] || '') || /^Asistente: Deshacer/.test(last[1])) fail(400, 'El último cambio publicado no es del asistente; no lo deshago desde acá.');
      await git(['revert', '--no-edit', last[0]]);
      await git(['commit', '--quiet', '--amend', '-m', 'Asistente: Deshacer "' + last[1].slice(11) + '"']);
      await git(['push', '--quiet', 'origin', 'HEAD:main']);
      return { ok: true, undone: last[1].slice(11) };
    });
  });

  // Para pruebas
  module.exports._tools = T;
};
