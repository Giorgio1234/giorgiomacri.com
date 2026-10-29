'use strict';
// Tracker de estudio: materias, guías y ejercicios por cuenta del sitio.
// Un documento JSON por usuario, con control de versión (updated_at) para no pisar cambios de otro dispositivo.
// Rutas: GET y PUT /api/sudoku/estudio

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const COLORS = ['persimmon', 'sage', 'blue', 'blush', 'candle'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SUBJECTS = 40, MAX_GUIDES = 60, MAX_EX = 300, MAX_LOG = 1000, MAX_EXAMS = 12;
const KINDS = ['parcial', 'parcialito', 'recuperatorio', 'final'];

module.exports = function install(d) {
  const { db, route, fail, readBody, sessionFrom, now, validDate } = d;

  db.exec(`
    CREATE TABLE IF NOT EXISTS study_state (
      user_id INTEGER PRIMARY KEY REFERENCES cal_users(id) ON DELETE CASCADE,
      data TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
  `);

  function user(req) {
    const s = sessionFrom(req);
    if (!s || !s.account) fail(401, 'Entrá con tu cuenta para usar el tracker de estudio.');
    return s.account;
  }

  const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  const int = (v, lo, hi) => { const x = Math.round(Number(v)); return isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo; };
  const id = v => (ID_RE.test(String(v || '')) ? String(v) : null);

  function cleanGuide(g) {
    if (!g || typeof g !== 'object') return null;
    const gid = id(g.id); const name = str(g.name, 80);
    if (!gid || !name) return null;
    const n = int(g.n, 1, MAX_EX);
    let s = String(g.s || '').replace(/[^0-3]/g, '0').slice(0, n);
    s = s.padEnd(n, '0');
    return { id: gid, name, n, s, note: str(g.note, 2000), exam: id(g.exam) || '' };
  }
  function cleanSubject(m) {
    if (!m || typeof m !== 'object') return null;
    const mid = id(m.id); const name = str(m.name, 60);
    if (!mid || !name) return null;
    const seen = new Set();
    const guides = (Array.isArray(m.guides) ? m.guides : []).map(cleanGuide)
      .filter(g => g && !seen.has(g.id) && seen.add(g.id)).slice(0, MAX_GUIDES);
    const date = v => (typeof v === 'string' && DATE_RE.test(v) && validDate(v) ? v : '');
    // Exámenes: parcial, recuperatorio (de un parcial) o final. Las materias viejas tenían un solo exam/examLabel.
    const eseen = new Set();
    let exams = (Array.isArray(m.exams) ? m.exams : []).map(e => {
      if (!e || typeof e !== 'object') return null;
      const eid = id(e.id); if (!eid || eseen.has(eid)) return null; eseen.add(eid);
      const kind = KINDS.includes(e.kind) ? e.kind : 'parcial';
      const out = { id: eid, kind, name: str(e.name, 40), date: date(e.date), of: id(e.of) || '', passed: !!e.passed };
      // El parcialito tiene su propia lista de guías (pueden repetirse con las de un parcial)
      if (kind === 'parcialito') out.guides = [...new Set((Array.isArray(e.guides) ? e.guides : []).map(id).filter(x => x && seen.has(x)))];
      return out;
    }).filter(Boolean).slice(0, MAX_EXAMS);
    if (!Array.isArray(m.exams) && date(m.exam)) exams = [{ id: 'x' + mid.slice(0, 30), kind: 'parcial', name: str(m.examLabel, 40) || 'Parcial', date: date(m.exam), of: '', passed: false }];
    const isParcial = x => exams.some(e => e.id === x && e.kind === 'parcial');
    exams.forEach(e => { if (e.kind !== 'recuperatorio' || !isParcial(e.of)) e.of = ''; });
    guides.forEach(g => { if (g.exam && !isParcial(g.exam)) g.exam = ''; });
    return { id: mid, name, color: COLORS.includes(m.color) ? m.color : 'persimmon', archived: !!m.archived, exams, guides };
  }
  function clean(data) {
    if (!data || typeof data !== 'object') fail(400, 'Faltan los datos.');
    const seen = new Set();
    const subjects = (Array.isArray(data.subjects) ? data.subjects : []).map(cleanSubject)
      .filter(m => m && !seen.has(m.id) && seen.add(m.id));
    if (subjects.length > MAX_SUBJECTS) fail(400, 'Son demasiadas materias (máximo ' + MAX_SUBJECTS + ').');
    const log = {};
    if (data.log && typeof data.log === 'object') {
      Object.keys(data.log).filter(k => DATE_RE.test(k) && validDate(k)).sort().slice(-MAX_LOG)
        .forEach(k => { const v = int(data.log[k], 0, 100000); if (v > 0) log[k] = v; });
    }
    return { subjects, log };
  }

  route('GET', '/estudio', async (req) => {
    const u = user(req);
    const r = db.prepare('SELECT data, updated_at FROM study_state WHERE user_id = ?').get(u.id);
    let data = { subjects: [], log: {} };
    if (r) { try { data = JSON.parse(r.data); } catch (e) {} }
    return { user: u.username, data, updatedAt: r ? r.updated_at : 0 };
  });

  route('PUT', '/estudio', async (req) => {
    const u = user(req);
    const b = await readBody(req, 512 * 1024);
    const data = clean(b.data);
    const cur = db.prepare('SELECT updated_at FROM study_state WHERE user_id = ?').get(u.id);
    const base = Number(b.base) || 0;
    if ((cur ? cur.updated_at : 0) !== base) fail(409, 'Cambiaste el tracker desde otro dispositivo. Recargá para ver lo último.');
    const t = Math.max(now(), (cur ? cur.updated_at : 0) + 1);
    db.prepare('INSERT INTO study_state (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(u.id, JSON.stringify(data), t);
    return { ok: true, updatedAt: t };
  });
};
