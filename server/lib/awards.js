'use strict';
// Awards: formulario público para proponer ideas de premios (título y, si quieren, una explicación).
// Cualquiera puede mandar; solo el admin ve y borra lo recibido.
// Rutas: POST /api/sudoku/awards/ideas · GET /api/sudoku/awards/ideas (admin) · DELETE /api/sudoku/awards/ideas/:id (admin)

const MAX_TITLE = 100, MAX_DESC = 1000, MAX_ROWS = 5000;

module.exports = function install(d) {
  const { db, route, fail, readBody, rateLimited, sessionFrom, requireAdmin, now } = d;

  db.exec(`
    CREATE TABLE IF NOT EXISTS award_ideas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
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
    const ideas = db.prepare('SELECT id, title, description, author, created_at AS at FROM award_ideas ORDER BY id DESC').all();
    return { ideas };
  });

  route('DELETE', '/awards/ideas/(\\d+)', async (req, url, m) => {
    requireAdmin(req);
    const r = db.prepare('DELETE FROM award_ideas WHERE id = ?').run(Number(m[1]));
    if (!r.changes) fail(404, 'Esa idea ya no existe.');
    return { ok: true };
  });
};
