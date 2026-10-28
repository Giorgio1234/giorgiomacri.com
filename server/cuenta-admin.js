'use strict';
// Recuperar o crear la cuenta admin desde la consola del servidor (si te olvidás la contraseña).
// Uso:  sudo -u sudoku node /opt/sudoku-torneo/cuenta-admin.js
// Pide la contraseña nueva sin mostrarla y cierra todas las sesiones de esa cuenta.
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const DB_PATH = process.env.DB_PATH || '/var/lib/sudoku-torneo/torneo.db';
const OWNER = (process.env.OWNER_USER || 'giorgio').trim().toLowerCase();

let buf = '', waiting = null; const lines = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', ch => {
  for (const c of ch) {
    if (c === '\u0003') process.exit(1);
    if (c === '\r' || c === '\n') { lines.push(buf); buf = ''; flush(); continue; }
    if (c === '\u007f') buf = buf.slice(0, -1); else buf += c;
  }
});
function flush() { if (waiting && lines.length) { const w = waiting; waiting = null; process.stdout.write('\n'); w(lines.shift()); } }
function ask(q) {
  process.stdout.write(q);
  if (process.stdin.isTTY) process.stdin.setRawMode(true); // no se ve lo que escribís
  return new Promise(resolve => { waiting = v => { if (process.stdin.isTTY) process.stdin.setRawMode(false); resolve(v); }; flush(); });
}
(async () => {
  const p1 = await ask(`Contraseña nueva para "${OWNER}" (mínimo 12 caracteres): `);
  if (p1.length < 12) { console.error('Muy corta.'); process.exit(1); }
  const p2 = await ask('Repetila: ');
  if (p1 !== p2) { console.error('No coinciden.'); process.exit(1); }
  const salt = crypto.randomBytes(16);
  const hash = 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(p1, salt, 32).toString('hex');
  const db = new DatabaseSync(DB_PATH);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cal_users'").get()) { console.error('La base todavía no tiene cuentas: arrancá el servidor una vez y volvé a correr esto.'); process.exit(1); }
  const u = db.prepare('SELECT id FROM cal_users WHERE username = ?').get(OWNER);
  if (u) { db.prepare('UPDATE cal_users SET pass_hash = ?, is_admin = 1, disabled = 0 WHERE id = ?').run(hash, u.id); db.prepare('DELETE FROM cal_sessions WHERE user_id = ?').run(u.id); }
  else db.prepare('INSERT INTO cal_users (username, pass_hash, created_at, is_admin) VALUES (?, ?, ?, 1)').run(OWNER, hash, Date.now());
  console.log(u ? 'Contraseña cambiada y sesiones cerradas.' : 'Cuenta admin creada.');
  process.exit(0);
})();
