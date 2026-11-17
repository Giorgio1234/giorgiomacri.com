'use strict';
// Awards: formulario público para proponer ideas de premios (título y, si quieren, una explicación).
// Cualquiera puede mandar; solo el admin ve y borra lo recibido.
// Rutas: POST /api/sudoku/awards/ideas · GET /api/sudoku/awards/ideas (admin) · DELETE /api/sudoku/awards/ideas/:id (admin)
// Votación de los organizadores (link oculto, sin cuenta: cada uno pone su nombre y la página lo recuerda):
//   GET /api/sudoku/awards/votacion · POST /api/sudoku/awards/votacion { voter, id, like }

const MAX_TITLE = 100, MAX_DESC = 1000, MAX_ROWS = 5000, MAX_NAME = 30, MAX_VOTERS = 20;

module.exports = function install(d) {
  const { db, route, fail, readBody, rateLimited, sessionFrom, requireAdmin, now } = d;

  db.exec(`
    CREATE TABLE IF NOT EXISTS award_ideas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS award_votes (
      idea_id INTEGER NOT NULL REFERENCES award_ideas(id) ON DELETE CASCADE,
      voter_key TEXT NOT NULL, voter TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (idea_id, voter_key)
    );
  `);

  const str = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
  const ip = req => String(req.headers['x-real-ip'] || req.socket.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 64);

  route('POST', '/awards/ideas', async (req) => {
    const b = await readBody(req, 8192);
    if (b.website) return { ok: true }; // campo trampa para bots
    const title = str(b.title, MAX_TITLE).replace(/\n/g, ' ');
    const description = str(b.description, MAX_DESC);
    if (!title) fail(400, 'Poné el título del premio.');
    if (rateLimited(req, 'awards', 20)) fail(429, 'Mandaste muchas seguidas. Esperá unos minutos.');
    const n = db.prepare('SELECT COUNT(*) n FROM award_ideas').get().n;
    if (n >= MAX_ROWS) fail(503, 'Ya no se aceptan más ideas por ahora.');
    // Si mandó con la sesión puesta, queda el nombre (cuenta o jugador del torneo)
    let author = '';
    try {
      const s = sessionFrom(req);
      if (s && s.account) author = s.account.username;
      else if (s && s.player_id) { const p = db.prepare('SELECT name FROM players WHERE id = ?').get(s.player_id); author = p ? p.name : ''; }
    } catch (e) {}
    db.prepare('INSERT INTO award_ideas (title, description, author, ip, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(title, description, String(author).slice(0, 40), ip(req), now());
    return { ok: true };
  });

  route('GET', '/awards/ideas', async (req) => {
    requireAdmin(req);
    const ideas = db.prepare('SELECT id, title, description, author, created_at AS at, (SELECT COUNT(*) FROM award_votes v WHERE v.idea_id = award_ideas.id) AS likes FROM award_ideas ORDER BY id DESC').all();
    return { ideas };
  });

  route('DELETE', '/awards/ideas/(\\d+)', async (req, url, m) => {
    requireAdmin(req);
    db.prepare('DELETE FROM award_votes WHERE idea_id = ?').run(Number(m[1]));
    const r = db.prepare('DELETE FROM award_ideas WHERE id = ?').run(Number(m[1]));
    if (!r.changes) fail(404, 'Esa idea ya no existe.');
    return { ok: true };
  });

  /* ---------- Votación ---------- */
  const voterName = v => str(v, MAX_NAME).replace(/\s+/g, ' ');
  const voterKey = n => n.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  function board() {
    const ideas = db.prepare('SELECT id, title, description, created_at AS at FROM award_ideas ORDER BY id DESC').all();
    const votes = db.prepare('SELECT idea_id, voter_key, voter FROM award_votes ORDER BY created_at, rowid').all();
    const by = new Map(ideas.map(i => [i.id, i]));
    ideas.forEach(i => { i.likes = []; });
    const names = new Map(); // voter_key -> el nombre como lo escribió la primera vez
    votes.forEach(v => { if (!names.has(v.voter_key)) names.set(v.voter_key, v.voter); });
    votes.forEach(v => { const i = by.get(v.idea_id); if (i) i.likes.push(names.get(v.voter_key)); });
    const voters = [...names.values()];
    return { ideas, voters };
  }

  route('GET', '/awards/votacion', async () => board());

  route('POST', '/awards/votacion', async (req) => {
    if (rateLimited(req, 'awards-vote', 400)) fail(429, 'Demasiados votos seguidos. Esperá unos minutos.');
    const b = await readBody(req, 4096);
    const name = voterName(b.voter);
    if (!name) fail(400, 'Poné tu nombre para votar.');
    const key = voterKey(name);
    const id = Number(b.id);
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM award_ideas WHERE id = ?').get(id)) fail(404, 'Esa idea ya no existe.');
    if (b.like) {
      const known = db.prepare('SELECT voter FROM award_votes WHERE voter_key = ? ORDER BY created_at, rowid LIMIT 1').get(key);
      const n = db.prepare('SELECT COUNT(DISTINCT voter_key) n FROM award_votes').get().n;
      if (!known && n >= MAX_VOTERS) fail(403, 'Ya votan demasiadas personas distintas.');
      db.prepare('INSERT INTO award_votes (idea_id, voter_key, voter, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(idea_id, voter_key) DO NOTHING')
        .run(id, key, known ? known.voter : name, now());
    } else {
      db.prepare('DELETE FROM award_votes WHERE idea_id = ? AND voter_key = ?').run(id, key);
    }
    return board();
  });
};
