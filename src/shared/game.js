/* Tablero compartido entre el juego libre y el torneo.
 *
 * var game = SudokuGame(rootEl, {
 *   tools: ['undo', 'erase', 'pencil', 'hint'],   // 'hint' solo en juego libre
 *   hints: 3,
 *   hideCompleted: true,                           // oculta del teclado los números ya completos
 *   pausable: true,
 *   validate: function (cell, digit) { return Promise|{correct:bool} },
 *   hint: function (cell) { return digit },
 *   onChange: function () {},                      // para guardar
 *   onPause: function (paused) {},
 *   footer: [{ label, onClick, ghost }]
 * });
 */
(function (global) {
  'use strict';
  var BOX = []; for (var i0 = 0; i0 < 81; i0++) BOX[i0] = ((i0 / 27) | 0) * 3 + (((i0 % 9) / 3) | 0);
  function peers(i, j) { return i !== j && (((i / 9) | 0) === ((j / 9) | 0) || i % 9 === j % 9 || BOX[i] === BOX[j]); }

  var ICON = {
    undo: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5v5h5"/><path d="M4.6 14.5A8 8 0 1 0 6.3 6.3L4 10"/></svg>',
    erase: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 4.5l4 4a1.5 1.5 0 0 1 0 2.1L11 19.1H7l-2.6-2.6a1.5 1.5 0 0 1 0-2.1l9-9.9a1.5 1.5 0 0 1 2.1 0z"/><path d="M9 9.5l5.5 5.5"/><path d="M11 19h9"/></svg>',
    pencil: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15.2 4.8l4 4L9 19H5v-4z"/><path d="M13 7l4 4"/><path d="M4 21h16"/></svg>',
    hint: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/></svg>',
    pause: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="1" width="3" height="10" rx="1"/><rect x="7" y="1" width="3" height="10" rx="1"/></svg>',
    play: '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l10.5-6.5z"/></svg>'
  };
  var LABEL = { undo: 'Deshacer', erase: 'Borrar', pencil: 'Notas', hint: 'Pista' };

  function SudokuGame(root, opts) {
    opts = opts || {};
    var tools = opts.tools || ['undo', 'erase', 'pencil'];
    var st = { puzzle: [], values: [], wrong: {}, notes: [], hintsLeft: opts.hints || 0 };
    var sel = -1, pencil = false, history = [], locked = false, paused = false, busy = false;

    root.classList.add('sg');
    root.innerHTML =
      '<div class="sg-stats">' +
        '<div class="sg-stat"><small data-r="l0"></small><b data-r="v0"></b></div>' +
        '<div class="sg-stat"><small data-r="l1"></small><b data-r="v1"></b></div>' +
        '<div class="sg-stat"><small data-r="l2"></small><span class="sg-time"><b data-r="v2"></b>' +
          (opts.pausable ? '<button class="sg-pause" type="button" data-r="pause" aria-label="Pausar">' + ICON.pause + '</button>' : '') +
        '</span></div>' +
      '</div>' +
      '<div class="sg-board-wrap"><div class="sg-board" data-r="board" role="grid" aria-label="Tablero"></div>' +
        '<div class="sg-veil" data-r="veil" hidden><div class="sg-veil-in" data-r="veilIn"></div></div></div>' +
      '<div class="sg-tools" data-r="tools" style="--tools:' + tools.length + '"></div>' +
      '<div class="sg-keys" data-r="keys"></div>' +
      '<div class="sg-foot" data-r="foot"></div>';
    var R = {}; root.querySelectorAll('[data-r]').forEach(function (el) { R[el.dataset.r] = el; });

    var cells = [], keys = [], toolBtns = {};
    for (var i = 0; i < 81; i++) {
      var r = (i / 9) | 0, c = i % 9, el = document.createElement('div');
      el.className = 'sg-cell' + (c === 8 ? ' c8' : '') + (r === 8 ? ' r8' : '') + (c % 3 === 2 && c < 8 ? ' tr' : '') + (r % 3 === 2 && r < 8 ? ' tb' : '');
      el.dataset.i = i; el.setAttribute('role', 'gridcell');
      R.board.appendChild(el); cells.push(el);
    }
    tools.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'sg-tool ' + t;
      b.innerHTML = '<span class="ico">' + ICON[t] + (t === 'pencil' ? '<span class="sg-badge" data-b>OFF</span>' : t === 'hint' ? '<span class="sg-badge on" data-b></span>' : '') + '</span>' + LABEL[t];
      if (t === 'pencil') b.setAttribute('aria-pressed', 'false');
      R.tools.appendChild(b); toolBtns[t] = b;
    });
    for (var d = 1; d <= 9; d++) {
      var k = document.createElement('button');
      k.type = 'button'; k.className = 'sg-key'; k.dataset.d = d; k.textContent = d;
      R.keys.appendChild(k); keys.push(k);
    }

    function cellLabel(i) { return 'Fila ' + ((i / 9 | 0) + 1) + ', columna ' + (i % 9 + 1); }
    function fixed(i) { return !!st.values[i]; }

    function render() {
      var v = st.values, selV = sel >= 0 ? (v[sel] || st.wrong[sel] || 0) : 0, counts = [0,0,0,0,0,0,0,0,0,0];
      for (var i = 0; i < 81; i++) if (v[i]) counts[v[i]]++;
      for (var i = 0; i < 81; i++) {
        var el = cells[i], val = v[i] || st.wrong[i] || 0;
        var cls = el.className.replace(/ (user|wrong|peer|same|sel)\b/g, '');
        if (v[i] && !st.puzzle[i]) cls += ' user';
        if (st.wrong[i] && !v[i]) cls += ' wrong';
        if (i === sel) cls += ' sel';
        else if (selV && val === selV) cls += ' same';
        else if (sel >= 0 && peers(i, sel)) cls += ' peer';
        el.className = cls;
        if (val) {
          if (el.textContent !== String(val) || el.firstElementChild) el.textContent = val;
          el.setAttribute('aria-label', cellLabel(i) + ': ' + val + (st.wrong[i] && !v[i] ? ' (incorrecto)' : ''));
        } else if (st.notes[i]) {
          var h = '<div class="sg-notes">';
          for (var d = 1; d <= 9; d++) { var on = st.notes[i] & (1 << (d - 1)); h += '<span' + (on && selV === d ? ' class="hl"' : '') + '>' + (on ? d : '') + '</span>'; }
          el.innerHTML = h + '</div>';
          el.setAttribute('aria-label', cellLabel(i) + ': notas');
        } else { el.textContent = ''; el.setAttribute('aria-label', cellLabel(i) + ': vacía'); }
      }
      keys.forEach(function (k, idx) {
        k.classList.toggle('gone', !!opts.hideCompleted && counts[idx + 1] >= 9);
        k.disabled = locked;
      });
      root.classList.toggle('pencil-on', pencil);
      if (toolBtns.pencil) {
        toolBtns.pencil.setAttribute('aria-pressed', String(pencil));
        var bd = toolBtns.pencil.querySelector('[data-b]'); bd.textContent = pencil ? 'ON' : 'OFF'; bd.classList.toggle('on', pencil);
      }
      if (toolBtns.hint) { toolBtns.hint.querySelector('[data-b]').textContent = st.hintsLeft; toolBtns.hint.disabled = locked || st.hintsLeft <= 0; }
      if (toolBtns.undo) toolBtns.undo.disabled = locked || !history.length;
      if (toolBtns.erase) toolBtns.erase.disabled = locked;
      if (toolBtns.pencil) toolBtns.pencil.disabled = locked;
    }

    function snap(idxs) { return idxs.map(function (i) { return { i: i, n: st.notes[i] || 0, w: st.wrong[i] || 0 }; }); }
    function changed() { render(); if (opts.onChange) opts.onChange(); }

    function input(d) {
      if (locked || busy || sel < 0 || fixed(sel)) return;
      var i = sel;
      if (pencil) {
        if (st.wrong[i]) return;
        history.push(snap([i]));
        st.notes[i] = (st.notes[i] || 0) ^ (1 << (d - 1));
        return changed();
      }
      if (st.wrong[i] === d) return;
      busy = true;
      Promise.resolve(opts.validate(i, d)).then(function (res) {
        busy = false;
        if (!res) return;
        if (res.correct) {
          st.values[i] = d; delete st.wrong[i]; st.notes[i] = 0;
          var bit = 1 << (d - 1);
          for (var j = 0; j < 81; j++) if (peers(i, j) && st.notes[j]) st.notes[j] &= ~bit;
          history = history.filter(function (h) { return h.every(function (x) { return !st.values[x.i]; }); });
        } else {
          history.push(snap([i]));
          st.wrong[i] = d; st.notes[i] = 0;
          cells[i].classList.remove('flash'); void cells[i].offsetWidth; cells[i].classList.add('flash');
        }
        changed();
        if (res.after) res.after();
      }, function () { busy = false; });
    }
    function erase() {
      if (locked || sel < 0 || fixed(sel)) return;
      if (!st.wrong[sel] && !st.notes[sel]) return;
      history.push(snap([sel]));
      delete st.wrong[sel]; st.notes[sel] = 0;
      changed();
    }
    function undo() {
      if (locked || !history.length) return;
      var h = history.pop();
      h.forEach(function (x) { if (st.values[x.i]) return; st.notes[x.i] = x.n; if (x.w) st.wrong[x.i] = x.w; else delete st.wrong[x.i]; });
      sel = h[0].i;
      changed();
    }
    function hint() {
      if (locked || sel < 0 || fixed(sel) || st.hintsLeft <= 0 || !opts.hint) return;
      var d = opts.hint(sel); if (!d) return;
      st.hintsLeft--;
      st.values[sel] = d; delete st.wrong[sel]; st.notes[sel] = 0;
      var bit = 1 << (d - 1);
      for (var j = 0; j < 81; j++) if (peers(sel, j) && st.notes[j]) st.notes[j] &= ~bit;
      changed();
      if (opts.afterHint) opts.afterHint();
    }

    R.board.addEventListener('pointerdown', function (e) {
      var el = e.target.closest('.sg-cell'); if (!el || locked) return;
      sel = +el.dataset.i; render();
    });
    R.keys.addEventListener('click', function (e) { var k = e.target.closest('.sg-key'); if (k) input(+k.dataset.d); });
    if (toolBtns.undo) toolBtns.undo.addEventListener('click', undo);
    if (toolBtns.erase) toolBtns.erase.addEventListener('click', erase);
    if (toolBtns.pencil) toolBtns.pencil.addEventListener('click', function () { pencil = !pencil; render(); });
    if (toolBtns.hint) toolBtns.hint.addEventListener('click', hint);
    if (R.pause) R.pause.addEventListener('click', function () { if (!locked) api.setPaused(true); });

    function onKey(e) {
      if (!root.isConnected || root.offsetParent === null) return;
      if (e.target.closest && e.target.closest('input, select, textarea, dialog')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey || locked) return;
      var digit = 0;
      if (/^Digit[1-9]$/.test(e.code)) digit = +e.code.slice(5);
      else if (/^Numpad[1-9]$/.test(e.code)) digit = +e.code.slice(6);
      else if (/^[1-9]$/.test(e.key)) digit = +e.key;
      if (digit) {
        e.preventDefault();
        if (sel < 0) sel = 0;
        if (e.shiftKey) { var p = pencil; pencil = !p; input(digit); pencil = p; render(); } else input(digit);
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); erase(); return; }
      if (e.key === 'n' || e.key === 'N') { pencil = !pencil; render(); return; }
      var mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
      if (mv) {
        e.preventDefault();
        if (sel < 0) sel = 40;
        else sel = ((((sel / 9) | 0) + mv[0] + 9) % 9) * 9 + ((sel % 9) + mv[1] + 9) % 9;
        render();
      }
    }
    document.addEventListener('keydown', onKey);

    var api = {
      load: function (s) {
        st.puzzle = s.puzzle.slice();
        st.values = s.values.slice();
        st.wrong = Object.assign({}, s.wrong || {});
        st.notes = (s.notes || []).slice(); for (var i = 0; i < 81; i++) st.notes[i] = st.notes[i] || 0;
        st.hintsLeft = s.hintsLeft != null ? s.hintsLeft : (opts.hints || 0);
        history = []; sel = -1; pencil = false; locked = false;
        render();
      },
      state: function () { return { puzzle: st.puzzle, values: st.values, wrong: st.wrong, notes: st.notes, hintsLeft: st.hintsLeft }; },
      setValue: function (i, d) { st.values[i] = d; render(); },
      stats: function (a, b, c) {
        [a, b, c].forEach(function (s, k) {
          if (!s) return;
          R['l' + k].textContent = s.label; R['v' + k].textContent = s.value;
          R['v' + k].classList.toggle('bad', !!s.bad);
        });
      },
      setLocked: function (v) { locked = v; if (v) sel = -1; render(); },
      // contenido: nodo o null para ocultar
      veil: function (node) { R.veil.hidden = !node; R.veilIn.innerHTML = ''; if (node) R.veilIn.appendChild(node); },
      setPaused: function (v) {
        if (!opts.pausable) return;
        paused = v; locked = v; render();
        if (v) {
          var wrap = document.createElement('div');
          wrap.innerHTML = '<button class="sg-play" type="button" aria-label="Seguir">' + ICON.play + '</button><p>Juego en pausa</p>';
          wrap.style.display = 'contents';
          wrap.querySelector('button').addEventListener('click', function () { api.setPaused(false); });
          api.veil(wrap);
        } else api.veil(null);
        if (opts.onPause) opts.onPause(v);
      },
      isPaused: function () { return paused; },
      footer: function (items) {
        R.foot.innerHTML = '';
        (items || []).forEach(function (it) {
          if (it.text) { var p = document.createElement('p'); p.className = 'sg-hint-text'; p.textContent = it.text; R.foot.appendChild(p); return; }
          var b = document.createElement('button');
          b.type = 'button'; b.className = 'btn' + (it.ghost ? ' ghost' : ''); b.textContent = it.label;
          b.addEventListener('click', it.onClick);
          R.foot.appendChild(b);
        });
      },
      destroy: function () { document.removeEventListener('keydown', onKey); }
    };
    if (opts.footer) api.footer(opts.footer);
    return api;
  }

  global.SudokuGame = SudokuGame;
})(window);
