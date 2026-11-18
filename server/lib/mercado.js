'use strict';
// Awards · Mercado: un "polymarket" de mentira para los premios. Puntos falsos, nada de plata.
//
// - Apostadores: nombre + PIN (sin cuenta del sitio). Arrancan con N puntos para apostar (setting start_points).
// - Participantes: la gente que puede ganar premios. Categorías: los premios finales, cada una con sus nominados.
// - Mercados: "¿Quién gana X?" (uno por categoría, se crea solo), "¿Quién se lleva más premios?", "¿… menos premios?",
//   "Mayor o menor" (¿cuántos premios gana Fulano? Más/Menos de 1,5) y preguntas libres.
// - Pozo compartido (parimutuel), entre ellos y sin "casa": todo lo apostado en un mercado va a un pozo y, al resolverse,
//   se reparte entre los que acertaron en proporción a lo que puso cada uno. La probabilidad que se ve es la parte del
//   pozo que tiene cada opción. Si hay empate, el pozo se divide entre las opciones empatadas; si nadie acertó, se
//   devuelve todo. Mientras el mercado está abierto se puede retirar una apuesta.
// - Como es suma cero, se calcula quién le debe cuántos puntos a quién (con la menor cantidad de transferencias).
// - El admin del sitio carga todo y cierra apuestas. Cargar el ganador de una categoría resuelve su mercado; cuando
//   todas tienen ganador se resuelven solos "más/menos premios" y "mayor o menor". Las preguntas libres, a mano.

const crypto = require('crypto');

const MAX_NAME = 30, MAX_TITLE = 120, MAX_TRADERS = 200, MAX_OPTIONS = 30;

module.exports = function install(d) {
  const { db, route, fail, readBody, rateLimited, requireAdmin, now } = d;

  db.exec(`
    CREATE TABLE IF NOT EXISTS mk_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mk_people (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mk_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      winner_id INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mk_markets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, title TEXT NOT NULL,
      category_id INTEGER, person_id INTEGER, line REAL,
      status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, resolved_at INTEGER);
    -- pool = puntos apostados a la opción; payout = parte del pozo que se llevó al resolverse (null si no se resolvió)
    CREATE TABLE IF NOT EXISTS mk_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, market_id INTEGER NOT NULL, label TEXT NOT NULL,
      person_id INTEGER, pool REAL NOT NULL DEFAULT 0, payout REAL);
    CREATE TABLE IF NOT EXISTS mk_traders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
      pin_hash TEXT, cash REAL NOT NULL, created_at INTEGER NOT NULL);
    -- stake = lo apostado a esa opción; paid = lo que cobró al resolverse
    CREATE TABLE IF NOT EXISTS mk_positions (
      trader_id INTEGER NOT NULL, outcome_id INTEGER NOT NULL, market_id INTEGER NOT NULL,
      stake REAL NOT NULL DEFAULT 0, paid REAL NOT NULL DEFAULT 0, PRIMARY KEY (trader_id, outcome_id));
    CREATE TABLE IF NOT EXISTS mk_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, market_id INTEGER NOT NULL, outcome_id INTEGER NOT NULL,
      trader_id INTEGER NOT NULL, side TEXT NOT NULL, points REAL NOT NULL, probs TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS mk_trades_market ON mk_trades(market_id, id);
    CREATE INDEX IF NOT EXISTS mk_outcomes_market ON mk_outcomes(market_id);
    CREATE INDEX IF NOT EXISTS mk_positions_market ON mk_positions(market_id);
  `);

  /* ---------- Utilidades ---------- */
  const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const text = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
  const keyOf = n => n.toLocaleLowerCase('es').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const int = v => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };
  const r2 = x => Math.round(x * 100) / 100;
  const r6 = x => Math.round(x * 1e6) / 1e6;

  const DEFAULTS = { start_points: '1000', trading_open: '1' };
  const setting = k => { const r = db.prepare('SELECT value FROM mk_settings WHERE key = ?').get(k); return r ? r.value : DEFAULTS[k]; };
  const setSetting = (k, v) => db.prepare('INSERT INTO mk_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
  let secret = setting('secret');
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); setSetting('secret', secret); }

  // Versión del estado: la página pregunta cada pocos segundos y, si no cambió nada, no se manda todo de nuevo.
  let version = Date.now();
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); version++; return out; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  }

  /* ---------- Pozo ---------- */
  // Probabilidad de cada opción = su parte del pozo (sin apuestas: todas iguales).
  function probs(pools) {
    const t = pools.reduce((a, x) => a + x, 0);
    return pools.map(x => (t > 1e-9 ? x / t : 1 / pools.length));
  }
  const outcomesOf = id => db.prepare('SELECT * FROM mk_outcomes WHERE market_id = ? ORDER BY id').all(id);
  const probsMap = outs => { const p = probs(outs.map(o => o.pool)), m = {}; outs.forEach((o, i) => { m[o.id] = r6(p[i]); }); return m; };
  const marketOf = id => { const m = db.prepare('SELECT * FROM mk_markets WHERE id = ?').get(id); if (!m) fail(404, 'Ese mercado no existe.'); return m; };

  /* ---------- Apostadores ---------- */
  const hashPin = pin => { const salt = crypto.randomBytes(12).toString('hex'); return salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex'); };
  const checkPin = (pin, stored) => {
    const [salt, h] = String(stored).split(':');
    const a = crypto.scryptSync(pin, salt, 32), b = Buffer.from(h || '', 'hex');
    return b.length === a.length && crypto.timingSafeEqual(a, b);
  };
  // Token estable por apostador (sirve en todos sus dispositivos); cambia si se resetea el PIN.
  const tokenFor = t => t.id + '.' + crypto.createHmac('sha256', secret).update(t.id + ':' + t.pin_hash).digest('hex').slice(0, 40);
  function traderFrom(req) {
    const tok = String(req.headers['x-mercado'] || '');
    const id = int(tok.split('.')[0]);
    if (!id) return null;
    const t = db.prepare('SELECT * FROM mk_traders WHERE id = ?').get(id);
    if (!t || !t.pin_hash) return null;
    const want = tokenFor(t);
    return want.length === tok.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(tok)) ? t : null;
  }

  route('POST', '/awards/mercado/entrar', async (req) => {
    if (rateLimited(req, 'mk-login', 30)) fail(429, 'Demasiados intentos. Esperá unos minutos.');
    const b = await readBody(req, 2048);
    const name = str(b.name, MAX_NAME), pin = String(b.pin ?? '').trim();
    if (!name) fail(400, 'Poné tu nombre.');
    if (!/^\d{4,8}$/.test(pin)) fail(400, 'El PIN tiene que ser de 4 a 8 números.');
    const key = keyOf(name);
    let t = db.prepare('SELECT * FROM mk_traders WHERE name_key = ?').get(key), isNew = false;
    if (t && t.pin_hash) {
      if (!checkPin(pin, t.pin_hash)) fail(401, 'Ese nombre ya existe y el PIN no coincide.');
    } else if (t) {
      tx(() => db.prepare('UPDATE mk_traders SET pin_hash = ? WHERE id = ?').run(hashPin(pin), t.id)); // PIN reseteado: elige uno nuevo
    } else {
      const n = db.prepare('SELECT COUNT(*) n FROM mk_traders').get().n;
      if (n >= MAX_TRADERS) fail(403, 'No entran más apostadores.');
      const start = Math.max(0, Number(setting('start_points')) || 0);
      tx(() => db.prepare('INSERT INTO mk_traders (name, name_key, pin_hash, cash, created_at) VALUES (?, ?, ?, ?, ?)').run(name, key, hashPin(pin), start, now()));
      isNew = true;
    }
    t = db.prepare('SELECT * FROM mk_traders WHERE name_key = ?').get(key);
    return { token: tokenFor(t), name: t.name, created: isNew };
  });

  /* ---------- Estado ---------- */
  function state(me) {
    const people = db.prepare('SELECT id, name FROM mk_people ORDER BY name COLLATE NOCASE').all();
    const categories = db.prepare('SELECT id, name, description, winner_id FROM mk_categories ORDER BY id').all();
    const markets = db.prepare('SELECT * FROM mk_markets ORDER BY id').all();
    const outs = db.prepare('SELECT * FROM mk_outcomes ORDER BY id').all();
    const bettors = new Map(db.prepare('SELECT market_id, COUNT(DISTINCT trader_id) n FROM mk_positions WHERE stake > 1e-9 GROUP BY market_id').all().map(r => [r.market_id, r.n]));
    const byMarket = new Map(markets.map(m => [m.id, []]));
    outs.forEach(o => { if (byMarket.has(o.market_id)) byMarket.get(o.market_id).push(o); });
    const mk = markets.map(m => {
      const os = byMarket.get(m.id), p = os.length ? probs(os.map(o => o.pool)) : [];
      return {
        id: m.id, kind: m.kind, title: m.title, category_id: m.category_id, person_id: m.person_id, line: m.line,
        status: m.status, created_at: m.created_at, resolved_at: m.resolved_at,
        pool: r2(os.reduce((a, o) => a + o.pool, 0)), traders: bettors.get(m.id) || 0,
        outcomes: os.map((o, i) => ({ id: o.id, label: o.label, person_id: o.person_id, pool: r2(o.pool), p: r6(p[i]), payout: o.payout })),
      };
    });

    // Resultado de cada uno = lo cobrado − lo apostado, solo en mercados resueltos. "En juego" = apostado en los demás.
    const resolvedIds = new Set(markets.filter(m => m.status === 'resolved').map(m => m.id));
    const open = new Map(), result = new Map();
    db.prepare('SELECT * FROM mk_positions WHERE stake > 1e-9 OR paid > 1e-9').all().forEach(x => {
      if (resolvedIds.has(x.market_id)) result.set(x.trader_id, (result.get(x.trader_id) || 0) + x.paid - x.stake);
      else open.set(x.trader_id, (open.get(x.trader_id) || 0) + x.stake);
    });
    const traders = db.prepare('SELECT id, name, cash FROM mk_traders').all().map(t => ({
      id: t.id, name: t.name, cash: r2(t.cash), invested: r2(open.get(t.id) || 0), result: r2(result.get(t.id) || 0),
    })).sort((a, b) => b.result - a.result || (b.cash + b.invested) - (a.cash + a.invested) || a.name.localeCompare(b.name));

    // Quién le debe a quién: el que más debe le paga al que más tiene que cobrar, hasta saldar todo.
    // En puntos enteros sin perder ni inventar puntos: se redondea para abajo y los puntos que faltan para que la
    // suma dé 0 van a los que tenían la parte decimal más grande.
    const raw = traders.map(t => ({ id: t.id, name: t.name, x: (result.get(t.id) || 0) }));
    const net = raw.map(t => ({ id: t.id, name: t.name, v: Math.floor(t.x + 1e-9), f: t.x - Math.floor(t.x + 1e-9) }));
    let left = -net.reduce((a, x) => a + x.v, 0);
    net.slice().sort((a, b) => b.f - a.f).forEach(x => { if (left > 0) { x.v++; left--; } });
    const whole = new Map(net.map(x => [x.id, x.v]));
    traders.forEach(t => { t.result = whole.get(t.id); }); // el ranking muestra los mismos números que las cuentas
    const debtors = net.filter(t => t.v < 0).map(t => ({ ...t, v: -t.v })).sort((a, b) => b.v - a.v);
    const creditors = net.filter(t => t.v > 0).map(t => ({ ...t })).sort((a, b) => b.v - a.v);
    const transfers = [];
    for (let i = 0, j = 0; i < debtors.length && j < creditors.length;) {
      const amt = Math.min(debtors[i].v, creditors[j].v);
      transfers.push({ from: debtors[i].name, from_id: debtors[i].id, to: creditors[j].name, to_id: creditors[j].id, amount: amt });
      debtors[i].v -= amt; creditors[j].v -= amt;
      if (!debtors[i].v) i++;
      if (!creditors[j].v) j++;
    }
    const pending = mk.filter(m => m.status !== 'resolved' && m.pool > 0).length;

    const feed = db.prepare(`SELECT t.id, t.market_id, t.outcome_id, t.trader_id, t.side, t.points, t.probs, t.created_at AS at, tr.name AS trader, o.label
      FROM mk_trades t JOIN mk_traders tr ON tr.id = t.trader_id JOIN mk_outcomes o ON o.id = t.outcome_id ORDER BY t.id DESC LIMIT 60`).all()
      .map(({ probs: pj, ...f }) => ({ ...f, points: r2(f.points), p: r6(JSON.parse(pj)[f.outcome_id] || 0) }));

    let mine = null;
    if (me) {
      const t = db.prepare('SELECT * FROM mk_traders WHERE id = ?').get(me.id);
      mine = {
        id: t.id, name: t.name, cash: r2(t.cash),
        positions: db.prepare('SELECT outcome_id, market_id, stake, paid FROM mk_positions WHERE trader_id = ? AND (stake > 1e-9 OR paid > 1e-9)').all(t.id)
          .map(x => ({ outcome_id: x.outcome_id, market_id: x.market_id, stake: r2(x.stake), paid: r2(x.paid) })),
      };
    }
    return {
      settings: { start_points: Number(setting('start_points')) || 0, trading_open: setting('trading_open') === '1' },
      people, categories, markets: mk, traders, debts: { transfers, pending }, feed, me: mine,
    };
  }

  route('GET', '/awards/mercado', async (req, url) => {
    const me = traderFrom(req), v = String(version) + ':' + (me ? me.id : 0);
    if (url.searchParams.get('v') === v) return { same: true };
    const s = state(me); s.v = v;
    return s;
  });

  // Historia de probabilidades de un mercado (para el gráfico)
  route('GET', '/awards/mercado/historial/(\\d+)', async (req, url, m) => {
    const mk = marketOf(Number(m[1]));
    const rows = db.prepare('SELECT probs, created_at AS at FROM mk_trades WHERE market_id = ? ORDER BY id DESC LIMIT 1000').all(mk.id).reverse();
    return { id: mk.id, created_at: mk.created_at, points: rows.map(r => ({ at: r.at, p: JSON.parse(r.probs) })) };
  });

  /* ---------- Apostar y retirar ---------- */
  route('POST', '/awards/mercado/operar', async (req) => {
    if (rateLimited(req, 'mk-trade', 600)) fail(429, 'Demasiadas apuestas seguidas. Esperá unos minutos.');
    const t = traderFrom(req);
    if (!t) fail(401, 'Entrá con tu nombre y PIN para apostar.');
    const b = await readBody(req, 2048);
    const o = db.prepare('SELECT * FROM mk_outcomes WHERE id = ?').get(int(b.outcome_id));
    if (!o) fail(404, 'Esa opción ya no existe.');
    return tx(() => {
      const mk = marketOf(o.market_id);
      if (setting('trading_open') !== '1') fail(409, 'Las apuestas están cerradas por ahora.');
      if (mk.status !== 'open') fail(409, mk.status === 'resolved' ? 'Ese mercado ya se resolvió.' : 'Ese mercado está cerrado.');
      const cash = db.prepare('SELECT cash FROM mk_traders WHERE id = ?').get(t.id).cash;
      const pos = db.prepare('SELECT * FROM mk_positions WHERE trader_id = ? AND outcome_id = ?').get(t.id, o.id) || { stake: 0 };
      let points;
      if (b.side === 'buy') {
        points = Math.floor(Number(b.points));
        if (!(points >= 1)) fail(400, 'Apostá al menos 1 punto.');
        if (points > cash + 1e-9) fail(400, 'No te alcanzan los puntos (tenés ' + Math.floor(cash) + ').');
      } else if (b.side === 'sell') { // retirar toda la apuesta a esta opción
        points = pos.stake;
        if (!(points > 1e-9)) fail(400, 'No tenés apuesta en esa opción.');
      } else fail(400, 'Operación inválida.');
      const sign = b.side === 'buy' ? 1 : -1;
      db.prepare('UPDATE mk_outcomes SET pool = MAX(0, pool + ?) WHERE id = ?').run(sign * points, o.id);
      db.prepare('UPDATE mk_traders SET cash = cash + ? WHERE id = ?').run(-sign * points, t.id);
      db.prepare(`INSERT INTO mk_positions (trader_id, outcome_id, market_id, stake) VALUES (?, ?, ?, ?)
        ON CONFLICT(trader_id, outcome_id) DO UPDATE SET stake = MAX(0, stake + excluded.stake)`).run(t.id, o.id, mk.id, sign * points);
      db.prepare('INSERT INTO mk_trades (market_id, outcome_id, trader_id, side, points, probs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(mk.id, o.id, t.id, b.side, points, JSON.stringify(probsMap(outcomesOf(mk.id))), now());
      return { ok: true, points: r2(points) };
    });
  });

  /* ---------- Resolver ---------- */
  function wins() { // premios ganados por participante (solo categorías con ganador)
    const c = new Map(db.prepare('SELECT id FROM mk_people').all().map(p => [p.id, 0]));
    const cats = db.prepare('SELECT winner_id FROM mk_categories').all();
    cats.forEach(x => { if (x.winner_id != null && c.has(x.winner_id)) c.set(x.winner_id, c.get(x.winner_id) + 1); });
    return { counts: c, total: cats.length, decided: cats.filter(x => x.winner_id != null).length };
  }
  function payoutsAuto(mk, outs) {
    if (mk.kind === 'category') {
      const c = db.prepare('SELECT winner_id FROM mk_categories WHERE id = ?').get(mk.category_id);
      if (!c || c.winner_id == null) fail(400, 'Primero elegí el ganador de la categoría.');
      return outs.map(o => (o.person_id === c.winner_id ? 1 : 0));
    }
    const w = wins();
    if (!w.total || w.decided < w.total) fail(400, 'Faltan ganadores: hay ' + w.decided + ' de ' + w.total + ' categorías resueltas.');
    if (mk.kind === 'over') {
      const n = w.counts.get(mk.person_id) || 0;
      return outs.map(o => (o.label.startsWith('Más') ? (n > mk.line ? 1 : 0) : (n > mk.line ? 0 : 1)));
    }
    if (mk.kind === 'most' || mk.kind === 'least') {
      const vals = outs.map(o => w.counts.get(o.person_id) || 0);
      const best = mk.kind === 'most' ? Math.max(...vals) : Math.min(...vals);
      const k = vals.filter(v => v === best).length; // empate: el pozo se reparte entre los empatados
      return vals.map(v => (v === best ? 1 / k : 0));
    }
    fail(400, 'Este mercado se resuelve eligiendo el resultado a mano.');
  }
  // Reparte el pozo: cada opción ganadora se lleva su parte (pays suma 1) y la divide entre los que le apostaron,
  // según cuánto puso cada uno. La parte de una ganadora sin apuestas va a las otras ganadoras; si ninguna ganadora
  // tiene apuestas, se devuelve todo.
  function resolve(mk, pays) {
    const outs = outcomesOf(mk.id);
    if (pays.reduce((a, x) => a + x, 0) <= 0) fail(400, 'Elegí qué resultado ganó.');
    outs.forEach((o, i) => db.prepare('UPDATE mk_outcomes SET payout = ? WHERE id = ?').run(pays[i], o.id));
    const total = outs.reduce((a, o) => a + o.pool, 0);
    const live = outs.map((o, i) => (pays[i] > 0 && o.pool > 1e-9 ? pays[i] : 0)), lw = live.reduce((a, x) => a + x, 0);
    db.prepare('SELECT * FROM mk_positions WHERE market_id = ? AND stake > 1e-9').all(mk.id).forEach(x => {
      const i = outs.findIndex(o => o.id === x.outcome_id);
      const paid = lw <= 0 ? x.stake : live[i] > 0 ? total * (live[i] / lw) * (x.stake / outs[i].pool) : 0;
      db.prepare('UPDATE mk_positions SET paid = ? WHERE trader_id = ? AND outcome_id = ?').run(paid, x.trader_id, x.outcome_id);
      db.prepare('UPDATE mk_traders SET cash = cash + ? WHERE id = ?').run(paid, x.trader_id);
    });
    db.prepare("UPDATE mk_markets SET status = 'resolved', resolved_at = ? WHERE id = ?").run(now(), mk.id);
  }
  function unresolve(mk) {
    if (mk.status !== 'resolved') return;
    db.prepare('SELECT * FROM mk_positions WHERE market_id = ? AND paid > 0').all(mk.id)
      .forEach(x => db.prepare('UPDATE mk_traders SET cash = cash - ? WHERE id = ?').run(x.paid, x.trader_id));
    db.prepare('UPDATE mk_positions SET paid = 0 WHERE market_id = ?').run(mk.id);
    db.prepare('UPDATE mk_outcomes SET payout = NULL WHERE market_id = ?').run(mk.id);
    db.prepare("UPDATE mk_markets SET status = 'closed', resolved_at = NULL WHERE id = ?").run(mk.id);
  }
  // "Más premios", "menos premios" y "mayor o menor" dependen de todas las categorías: se resuelven solos cuando todas
  // tienen ganador, y se recalculan si después cambia algún ganador o se agrega o borra una categoría.
  function syncDerived() {
    const derived = () => db.prepare("SELECT * FROM mk_markets WHERE kind IN ('most','least','over')").all();
    derived().filter(m => m.status === 'resolved').forEach(unresolve);
    const w = wins();
    if (w.total && w.decided === w.total) derived().forEach(m => resolve(m, payoutsAuto(m, outcomesOf(m.id))));
  }
  function removeMarket(mk) { // devuelve lo apostado y borra todo
    unresolve(mk);
    db.prepare('SELECT trader_id, SUM(stake) s FROM mk_positions WHERE market_id = ? GROUP BY trader_id').all(mk.id)
      .forEach(x => db.prepare('UPDATE mk_traders SET cash = cash + ? WHERE id = ?').run(x.s, x.trader_id));
    ['mk_positions', 'mk_trades', 'mk_outcomes'].forEach(tb => db.prepare('DELETE FROM ' + tb + ' WHERE market_id = ?').run(mk.id));
    db.prepare('DELETE FROM mk_markets WHERE id = ?').run(mk.id);
  }

  /* ---------- Admin ---------- */
  const personOf = id => { const p = db.prepare('SELECT * FROM mk_people WHERE id = ?').get(id); if (!p) fail(404, 'Ese participante no existe.'); return p; };
  const fmtLine = l => String(l).replace('.', ',');
  function newMarket(kind, title, extra, outcomes) {
    const r = db.prepare('INSERT INTO mk_markets (kind, title, category_id, person_id, line, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(kind, title, extra.category_id ?? null, extra.person_id ?? null, extra.line ?? null, 'open', now());
    const id = Number(r.lastInsertRowid);
    outcomes.forEach(o => db.prepare('INSERT INTO mk_outcomes (market_id, label, person_id) VALUES (?, ?, ?)').run(id, o.label, o.person_id ?? null));
    return id;
  }
  function addOutcome(mk, label, personId) {
    db.prepare('INSERT INTO mk_outcomes (market_id, label, person_id) VALUES (?, ?, ?)').run(mk.id, label, personId ?? null);
  }
  function dropOutcome(o) {
    const used = db.prepare('SELECT 1 FROM mk_trades WHERE outcome_id = ? LIMIT 1').get(o.id);
    if (used) fail(409, '«' + o.label + '» ya tiene apuestas: no se puede sacar (podés borrar el mercado entero, que devuelve los puntos).');
    db.prepare('DELETE FROM mk_outcomes WHERE id = ?').run(o.id);
  }
  const nomineeIds = list => {
    const all = db.prepare('SELECT id FROM mk_people ORDER BY name COLLATE NOCASE').all().map(p => p.id);
    const want = Array.isArray(list) && list.length ? all.filter(id => list.map(Number).includes(id)) : all;
    if (want.length < 2) fail(400, 'Una categoría necesita al menos 2 nominados. Cargá participantes primero.');
    return want;
  };

  const ACTIONS = {
    settings(b) {
      if (b.start_points != null) {
        const n = Math.floor(Number(b.start_points)), old = Number(setting('start_points')) || 0;
        if (!(n >= 0 && n <= 1e7)) fail(400, 'Puntos iniciales inválidos.');
        setSetting('start_points', n);
        // A los que ya entraron se les suma o resta la diferencia, así todos tienen el mismo tope
        if (n !== old) db.prepare('UPDATE mk_traders SET cash = MAX(0, cash + ?)').run(n - old);
      }
      if (b.trading_open != null) setSetting('trading_open', b.trading_open ? '1' : '0');
    },
    person_add(b) {
      const names = String(b.name ?? '').split(/\n|,/).map(x => str(x, MAX_NAME)).filter(Boolean);
      if (!names.length) fail(400, 'Poné un nombre.');
      names.forEach(name => {
        if (db.prepare('SELECT 1 FROM mk_people WHERE name_key = ?').get(keyOf(name))) return;
        const id = Number(db.prepare('INSERT INTO mk_people (name, name_key, created_at) VALUES (?, ?, ?)').run(name, keyOf(name), now()).lastInsertRowid);
        // Entra a los mercados de "más / menos premios" que siguen abiertos
        db.prepare("SELECT * FROM mk_markets WHERE kind IN ('most','least') AND status != 'resolved'").all().forEach(m => addOutcome(m, name, id));
      });
    },
    person_rename(b) {
      const p = personOf(int(b.id)), name = str(b.name, MAX_NAME);
      if (!name) fail(400, 'Poné un nombre.');
      const other = db.prepare('SELECT id FROM mk_people WHERE name_key = ?').get(keyOf(name));
      if (other && other.id !== p.id) fail(409, 'Ya hay un participante con ese nombre.');
      db.prepare('UPDATE mk_people SET name = ?, name_key = ? WHERE id = ?').run(name, keyOf(name), p.id);
      db.prepare('UPDATE mk_outcomes SET label = ? WHERE person_id = ? AND market_id IN (SELECT id FROM mk_markets WHERE kind != \'over\')').run(name, p.id);
      db.prepare("SELECT * FROM mk_markets WHERE kind = 'over' AND person_id = ?").all(p.id)
        .forEach(m => db.prepare('UPDATE mk_markets SET title = ? WHERE id = ?').run('¿Cuántos premios gana ' + name + '?', m.id));
    },
    person_delete(b) {
      const p = personOf(int(b.id));
      if (db.prepare("SELECT 1 FROM mk_markets WHERE kind = 'over' AND person_id = ?").get(p.id)) fail(409, p.name + ' tiene un mercado de mayor o menor: borralo primero.');
      if (db.prepare('SELECT 1 FROM mk_categories WHERE winner_id = ?').get(p.id)) fail(409, p.name + ' ganó una categoría: sacale el premio primero.');
      db.prepare('SELECT * FROM mk_outcomes WHERE person_id = ?').all().filter(o => o.person_id === p.id).forEach(o => {
        const m = marketOf(o.market_id);
        if (outcomesOf(m.id).length <= 2 && m.kind === 'category') fail(409, '«' + m.title + '» se quedaría con un solo nominado.');
        dropOutcome(o);
      });
      db.prepare('DELETE FROM mk_people WHERE id = ?').run(p.id);
    },
    category_add(b) {
      const name = str(b.name, MAX_TITLE);
      if (!name) fail(400, 'Poné el nombre del premio.');
      const ids = nomineeIds(b.nominees);
      const cid = Number(db.prepare('INSERT INTO mk_categories (name, description, created_at) VALUES (?, ?, ?)').run(name, text(b.description, 500), now()).lastInsertRowid);
      const names = new Map(db.prepare('SELECT id, name FROM mk_people').all().map(p => [p.id, p.name]));
      newMarket('category', '¿Quién gana «' + name + '»?', { category_id: cid }, ids.map(id => ({ label: names.get(id), person_id: id })));
      syncDerived();
    },
    category_edit(b) {
      const c = db.prepare('SELECT * FROM mk_categories WHERE id = ?').get(int(b.id));
      if (!c) fail(404, 'Esa categoría no existe.');
      const name = str(b.name, MAX_TITLE) || c.name;
      db.prepare('UPDATE mk_categories SET name = ?, description = ? WHERE id = ?').run(name, b.description != null ? text(b.description, 500) : c.description, c.id);
      const mk = db.prepare("SELECT * FROM mk_markets WHERE kind = 'category' AND category_id = ?").get(c.id);
      if (!mk) return;
      db.prepare('UPDATE mk_markets SET title = ? WHERE id = ?').run('¿Quién gana «' + name + '»?', mk.id);
      if (Array.isArray(b.nominees)) {
        if (mk.status === 'resolved') fail(409, 'La categoría ya está resuelta: sacale el ganador para cambiar los nominados.');
        const want = nomineeIds(b.nominees), outs = outcomesOf(mk.id), have = outs.map(o => o.person_id);
        const names = new Map(db.prepare('SELECT id, name FROM mk_people').all().map(p => [p.id, p.name]));
        outs.filter(o => !want.includes(o.person_id)).forEach(dropOutcome);
        want.filter(id => !have.includes(id)).forEach(id => addOutcome(mk, names.get(id), id));
      }
    },
    category_winner(b) {
      const c = db.prepare('SELECT * FROM mk_categories WHERE id = ?').get(int(b.id));
      if (!c) fail(404, 'Esa categoría no existe.');
      const mk = db.prepare("SELECT * FROM mk_markets WHERE kind = 'category' AND category_id = ?").get(c.id);
      const winner = b.winner_id == null || b.winner_id === '' ? null : int(b.winner_id);
      if (winner != null) {
        personOf(winner);
        if (mk && !outcomesOf(mk.id).some(o => o.person_id === winner)) fail(400, 'Esa persona no está nominada en esta categoría.');
      }
      if (mk) unresolve(mk);
      db.prepare('UPDATE mk_categories SET winner_id = ? WHERE id = ?').run(winner, c.id);
      if (mk && winner != null) { const m2 = marketOf(mk.id); resolve(m2, payoutsAuto(m2, outcomesOf(m2.id))); }
      syncDerived();
    },
    category_delete(b) {
      const c = db.prepare('SELECT * FROM mk_categories WHERE id = ?').get(int(b.id));
      if (!c) fail(404, 'Esa categoría no existe.');
      db.prepare("SELECT * FROM mk_markets WHERE kind = 'category' AND category_id = ?").all(c.id).forEach(removeMarket);
      db.prepare('DELETE FROM mk_categories WHERE id = ?').run(c.id);
      syncDerived();
    },
    market_add(b) {
      const people = db.prepare('SELECT id, name FROM mk_people ORDER BY name COLLATE NOCASE').all();
      if (b.kind === 'most' || b.kind === 'least') {
        if (people.length < 2) fail(400, 'Cargá al menos 2 participantes primero.');
        if (db.prepare('SELECT 1 FROM mk_markets WHERE kind = ?').get(b.kind)) fail(409, 'Ese mercado ya existe.');
        newMarket(b.kind, b.kind === 'most' ? '¿Quién se lleva más premios?' : '¿Quién se lleva menos premios?', {}, people.map(p => ({ label: p.name, person_id: p.id })));
        syncDerived();
      } else if (b.kind === 'over') {
        const p = personOf(int(b.person_id)), line = Number(b.line);
        if (!(line >= 0 && line <= 100) || Math.abs(line % 1 - 0.5) > 1e-9) fail(400, 'La línea tiene que terminar en ,5 (por ejemplo 1,5) para que no haya empate.');
        if (db.prepare("SELECT 1 FROM mk_markets WHERE kind = 'over' AND person_id = ? AND line = ?").get(p.id, line)) fail(409, 'Ese mercado ya existe.');
        newMarket('over', '¿Cuántos premios gana ' + p.name + '?', { person_id: p.id, line },
          [{ label: 'Más de ' + fmtLine(line) }, { label: 'Menos de ' + fmtLine(line) }]);
        syncDerived();
      } else if (b.kind === 'custom') {
        const title = str(b.title, MAX_TITLE);
        if (!title) fail(400, 'Escribí la pregunta.');
        let opts = (Array.isArray(b.options) ? b.options : String(b.options ?? '').split('\n')).map(x => str(x, 60)).filter(Boolean);
        opts = [...new Map(opts.map(o => [keyOf(o), o])).values()];
        if (!opts.length) opts = ['Sí', 'No'];
        if (opts.length < 2) fail(400, 'Hacen falta al menos 2 opciones.');
        if (opts.length > MAX_OPTIONS) fail(400, 'Máximo ' + MAX_OPTIONS + ' opciones.');
        newMarket('custom', title, {}, opts.map(label => ({ label })));
      } else fail(400, 'Tipo de mercado inválido.');
    },
    market_status(b) {
      const mk = marketOf(int(b.id));
      if (mk.status === 'resolved') fail(409, 'Ya está resuelto.');
      db.prepare('UPDATE mk_markets SET status = ? WHERE id = ?').run(b.status === 'open' ? 'open' : 'closed', mk.id);
    },
    market_resolve(b) {
      const mk = marketOf(int(b.id));
      if (mk.status === 'resolved') fail(409, 'Ya está resuelto.');
      if (mk.kind !== 'custom') fail(400, 'Este mercado se resuelve solo cuando todas las categorías tienen ganador.');
      const outs = outcomesOf(mk.id);
      let pays;
      if (mk.kind === 'custom') {
        const ids = (Array.isArray(b.outcome_ids) ? b.outcome_ids : [b.outcome_ids]).map(Number);
        const k = outs.filter(o => ids.includes(o.id)).length;
        if (!k) fail(400, 'Elegí qué opción ganó.');
        pays = outs.map(o => (ids.includes(o.id) ? 1 / k : 0));
      } else pays = payoutsAuto(mk, outs);
      resolve(mk, pays);
    },
    market_unresolve(b) {
      const mk = marketOf(int(b.id));
      if (mk.kind !== 'custom') fail(400, 'Se resuelve solo con los ganadores de las categorías.');
      unresolve(mk);
    },
    market_delete(b) {
      const mk = marketOf(int(b.id));
      if (mk.kind === 'category') fail(400, 'Este mercado es de una categoría: borrá la categoría.');
      removeMarket(mk);
    },
    trader_reset_pin(b) {
      const t = db.prepare('SELECT * FROM mk_traders WHERE id = ?').get(int(b.id));
      if (!t) fail(404, 'Ese apostador no existe.');
      db.prepare('UPDATE mk_traders SET pin_hash = NULL WHERE id = ?').run(t.id);
    },
    trader_delete(b) {
      const t = db.prepare('SELECT * FROM mk_traders WHERE id = ?').get(int(b.id));
      if (!t) fail(404, 'Ese apostador no existe.');
      if (db.prepare('SELECT 1 FROM mk_trades WHERE trader_id = ? LIMIT 1').get(t.id)) fail(409, t.name + ' ya apostó: no se puede borrar (podés resetearle el PIN).');
      db.prepare('DELETE FROM mk_traders WHERE id = ?').run(t.id);
    },
  };

  route('POST', '/awards/mercado/admin', async (req) => {
    requireAdmin(req);
    const b = await readBody(req, 16384);
    const fn = ACTIONS[b.action];
    if (!fn) fail(400, 'Acción desconocida.');
    tx(() => fn(b));
    return { ok: true };
  });
};
