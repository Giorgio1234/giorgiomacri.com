'use strict';
// Vida de las sesiones de cuenta: vencen tras 30 días sin usarse o 180 días desde que se abrieron.
const IDLE_MS = 30 * 86400000, MAX_MS = 180 * 86400000;
function alive(db, hash, createdAt, lastUsed) {
  const t = Date.now();
  if (t - createdAt > MAX_MS || t - (lastUsed || createdAt) > IDLE_MS) {
    try { db.prepare('DELETE FROM cal_sessions WHERE token_hash = ?').run(hash); } catch (e) {}
    return false;
  }
  if (!lastUsed || t - lastUsed > 3600000) { try { db.prepare('UPDATE cal_sessions SET last_used = ? WHERE token_hash = ?').run(t, hash); } catch (e) {} }
  return true;
}
module.exports = { alive, IDLE_MS, MAX_MS };
