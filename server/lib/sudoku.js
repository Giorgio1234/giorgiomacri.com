'use strict';
// Mismo generador que el juego libre: tablero completo al azar y se quitan pistas mientras la solución siga siendo única.
var BOX = []; for (var i0 = 0; i0 < 81; i0++) BOX[i0] = ((i0 / 27) | 0) * 3 + (((i0 % 9) / 3) | 0);
function pop(m) { var n = 0; while (m) { m &= m - 1; n++; } return n; }
function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = (Math.random() * (i + 1)) | 0; var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

// Cuenta soluciones hasta `limit`. Devuelve {count, sol}.
function solve(g, limit, rand) {
  var rows = [0,0,0,0,0,0,0,0,0], cols = rows.slice(), boxes = rows.slice();
  var a = g.slice(), count = 0, sol = null;
  for (var i = 0; i < 81; i++) {
    var v = a[i]; if (!v) continue;
    var bit = 1 << (v - 1), r = (i / 9) | 0, c = i % 9, b = BOX[i];
    if ((rows[r] | cols[c] | boxes[b]) & bit) return { count: 0, sol: null };
    rows[r] |= bit; cols[c] |= bit; boxes[b] |= bit;
  }
  function rec() {
    var best = -1, bestMask = 0, bestN = 10;
    for (var i = 0; i < 81; i++) {
      if (a[i]) continue;
      var m = ~(rows[(i / 9) | 0] | cols[i % 9] | boxes[BOX[i]]) & 511, n = pop(m);
      if (n < bestN) { bestN = n; best = i; bestMask = m; if (n === 0) return false; if (n === 1) break; }
    }
    if (best < 0) { count++; if (!sol) sol = a.slice(); return count >= limit; }
    var ds = []; for (var d = 1; d <= 9; d++) if (bestMask & (1 << (d - 1))) ds.push(d);
    if (rand) shuffle(ds);
    var r = (best / 9) | 0, c = best % 9, b = BOX[best];
    for (var k = 0; k < ds.length; k++) {
      var bit = 1 << (ds[k] - 1);
      rows[r] |= bit; cols[c] |= bit; boxes[b] |= bit; a[best] = ds[k];
      if (rec()) return true;
      rows[r] &= ~bit; cols[c] &= ~bit; boxes[b] &= ~bit; a[best] = 0;
    }
    return false;
  }
  rec();
  return { count: count, sol: sol };
}

function generate(target) {
  var full = solve(new Array(81).fill(0), 1, true).sol;
  var p = full.slice(), clues = 81;
  var order = shuffle(Array.from({ length: 81 }, function (_, i) { return i; }));
  for (var k = 0; k < order.length && clues > target; k++) {
    var i = order[k], keep = p[i];
    p[i] = 0;
    if (solve(p, 2, false).count !== 1) p[i] = keep; else clues--;
  }
  return { puzzle: p, solution: full };
}

module.exports = { solve, generate };
