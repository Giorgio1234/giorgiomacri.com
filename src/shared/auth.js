/* Cuenta única de giorgiomacri.com: botón "Entrar" / menú de la cuenta arriba a la derecha (en #gmAuth).
 * Una sesión para todo: el token se copia a las claves que usan Sudoku, Calorías, Agenda y Asistente.
 * window.GMAuth: { me(), token(), open(), logout(), ready }  ·  window.gmAccount: compatibilidad con Sudoku. */
(function () {
  'use strict';
  if (window.GMAuth) return;
  var API = '/api/sudoku/auth';
  var K = { token: 'gm-token', me: 'gm-me', torneo: 'gm-torneo-token', torneoMe: 'gm-torneo-me', cal: 'gm-cal-token', agenda: 'gm-agenda-token' };
  var EXTRA = ['gm-cal-cache', 'gm-agenda-cache', 'gm-chat-v1'];
  var CSS = '' +
    '.gma{--a-bg:#1b1b23;--a-card:#23232d;--a-line:#30303c;--a-fg:#f1efe9;--a-fg2:#a3a1ad;--a-acc:#fd9b65;--a-on:#1a0f08;--a-bad:#ff7a6b;' +
    'font-family:"Inter Tight",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.35;position:relative;display:inline-flex;align-items:center;-webkit-font-smoothing:antialiased}' +
    '@media (prefers-color-scheme:light){:root:not([data-theme="dark"]) .gma{--a-bg:#fff;--a-card:#f3f1ec;--a-line:#e2dfd7;--a-fg:#15141a;--a-fg2:#5d5b66;--a-acc:#c4501a;--a-on:#fff;--a-bad:#c8321f}}' +
    ':root[data-theme="light"] .gma{--a-bg:#fff;--a-card:#f3f1ec;--a-line:#e2dfd7;--a-fg:#15141a;--a-fg2:#5d5b66;--a-acc:#c4501a;--a-on:#fff;--a-bad:#c8321f}' +
    ':root[data-theme="dark"] .gma{--a-bg:#1b1b23;--a-card:#23232d;--a-line:#30303c;--a-fg:#f1efe9;--a-fg2:#a3a1ad;--a-acc:#fd9b65;--a-on:#1a0f08;--a-bad:#ff7a6b}' +
    '.gma *{box-sizing:border-box}.gma button,.gma input{font:inherit}' +
    '.gma-in{height:36px;border:0;border-radius:999px;padding:0 14px;background:var(--a-acc);color:var(--a-on);font-weight:600;cursor:pointer;white-space:nowrap}' +
    '.gma-me{height:36px;border:1px solid var(--a-line);border-radius:999px;padding:0 10px 0 4px;background:var(--a-card);color:var(--a-fg);display:flex;align-items:center;gap:7px;cursor:pointer;max-width:12rem}' +
    '.gma-me i{flex:none;width:28px;height:28px;border-radius:50%;background:var(--a-acc);color:var(--a-on);display:grid;place-items:center;font-style:normal;font-weight:700;font-size:13px;text-transform:uppercase}' +
    '.gma-me span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}' +
    '@media (max-width:520px){.gma-me{padding:0 4px}.gma-me span{display:none}}' +
    '.gma-menu{position:absolute;right:0;top:calc(100% + 8px);z-index:80;min-width:220px;background:var(--a-bg);color:var(--a-fg);border:1px solid var(--a-line);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.35);padding:6px}' +
    '.gma-menu .hd{padding:8px 10px 10px;border-bottom:1px solid var(--a-line);margin-bottom:4px}.gma-menu .hd b{display:block;font-size:15px}.gma-menu .hd small{color:var(--a-fg2)}' +
    '.gma-menu a,.gma-menu button{display:block;width:100%;text-align:left;border:0;background:none;color:var(--a-fg);padding:9px 10px;border-radius:9px;text-decoration:none;cursor:pointer;font-size:14px}' +
    '.gma-menu a:hover,.gma-menu button:hover{background:var(--a-card)}.gma-menu .out{color:var(--a-bad)}.gma-menu hr{border:0;border-top:1px solid var(--a-line);margin:4px 0}' +
    '.gma-dlg{border:0;border-radius:16px;padding:0;width:min(380px,calc(100vw - 32px));background:var(--a-bg);color:var(--a-fg);box-shadow:0 30px 80px rgba(0,0,0,.45)}' +
    '.gma-dlg::backdrop{background:rgba(8,8,12,.55)}' +
    '.gma-dlg form{padding:22px;display:flex;flex-direction:column;gap:12px}.gma-dlg h3{margin:0;font-size:21px;letter-spacing:-.01em}.gma-dlg p{margin:0;color:var(--a-fg2);font-size:13px}' +
    '.gma-dlg label{display:flex;flex-direction:column;gap:5px;font-size:13px;color:var(--a-fg2)}' +
    '.gma-dlg input{height:44px;border:1px solid var(--a-line);border-radius:10px;background:var(--a-card);color:var(--a-fg);padding:0 12px;font-size:16px;outline:none}.gma-dlg input:focus{border-color:var(--a-acc)}' +
    '.gma-dlg .err{color:var(--a-bad);min-height:1.2em;font-size:13px}' +
    '.gma-dlg .row{display:flex;gap:8px;justify-content:flex-end}.gma-dlg .row button{height:42px;border:0;border-radius:10px;padding:0 16px;font-weight:600;cursor:pointer}' +
    '.gma-dlg .ok{background:var(--a-acc);color:var(--a-on)}.gma-dlg .no{background:var(--a-card);color:var(--a-fg)}.gma-dlg .ok:disabled{opacity:.5}';

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var token = get(K.token), me = null;
  try { me = JSON.parse(get(K.me) || 'null'); } catch (e) {}
  if (!token) { token = get(K.cal) || get(K.torneo) || get(K.agenda) || null; me = null; }

  // Copia la sesión a las claves de cada programa (así todos ven la misma cuenta)
  function sync() {
    set(K.token, token); set(K.me, me ? JSON.stringify(me) : null);
    var acct = me && me.kind === 'account';
    set(K.cal, acct ? token : null);
    set(K.agenda, me && me.admin ? token : null);
    set(K.torneo, me && me.player ? token : null);
    set(K.torneoMe, me && me.player ? JSON.stringify(me.player) : null);
  }
  function clearAll() { token = null; me = null; sync(); EXTRA.forEach(function (k) { set(k, null); }); try { sessionStorage.removeItem('gm-torneo-admin'); } catch (e) {} }

  function call(method, path, body, tok) {
    var h = { 'Content-Type': 'application/json' }; if (tok) h.Authorization = 'Bearer ' + tok;
    return fetch(API + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' })
      .catch(function () { var e = new Error('Sin conexión con el servidor.'); e.net = true; throw e; })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || 'Algo falló.'); e.status = r.status; throw e; } return j; }); });
  }

  if (!document.getElementById('gma-css')) { var st = document.createElement('style'); st.id = 'gma-css'; st.textContent = CSS; document.head.appendChild(st); }
  var slot = null, menuOpen = false;

  function links() {
    var l = [];
    if (me && me.kind === 'account') l.push(['/calorias/', 'Calorías']);
    if (me && me.admin) { l.push(['/agenda/', 'Agenda']); l.push(['/asistente/', 'Asistente']); }
    if (me && me.player) l.push(['/sudoku/torneo/', 'Torneo de sudoku']);
    if (me && me.admin) l.push(['/admin/', 'Panel de admin']);
    return l;
  }
  function render() {
    slot = slot || document.getElementById('gmAuth');
    if (!slot) return;
    slot.className = 'gma';
    if (!token || !me) { slot.innerHTML = '<button class="gma-in" type="button">Entrar</button>'; slot.firstChild.onclick = open; return; }
    var sub = me.admin ? 'Admin' : me.kind === 'player' ? 'Jugador del torneo' : 'Cuenta';
    if (me.player && me.kind === 'account' && me.player.name.toLowerCase() !== me.name.toLowerCase()) sub += ' · en el torneo: ' + me.player.name;
    slot.innerHTML = '<button class="gma-me" type="button" aria-haspopup="menu" aria-expanded="false"><i>' + esc(me.name.charAt(0)) + '</i><span>' + esc(me.name) + '</span></button>' +
      '<div class="gma-menu" role="menu" hidden><div class="hd"><b>' + esc(me.name) + '</b><small>' + esc(sub) + '</small></div>' +
      links().map(function (x) { return '<a role="menuitem" href="' + x[0] + '">' + esc(x[1]) + '</a>'; }).join('') +
      '<hr>' + (me.kind === 'account' ? '<button type="button" role="menuitem" data-pw>Cambiar contraseña</button>' : '') +
      '<button type="button" role="menuitem" class="out" data-out>Salir</button></div>';
    var btn = slot.querySelector('.gma-me'), menu = slot.querySelector('.gma-menu');
    btn.onclick = function (e) { e.stopPropagation(); menuOpen = menu.hidden; menu.hidden = !menuOpen; btn.setAttribute('aria-expanded', String(menuOpen)); };
    menu.querySelector('[data-out]').onclick = function () { logout(); };
    var pw = menu.querySelector('[data-pw]'); if (pw) pw.onclick = function () { menu.hidden = true; password(); };
  }
  document.addEventListener('click', function (e) { if (!slot) return; var m = slot.querySelector('.gma-menu'); if (m && !m.hidden && !slot.contains(e.target)) m.hidden = true; });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && slot) { var m = slot.querySelector('.gma-menu'); if (m) m.hidden = true; } });

  function dialog(html, onSubmit) {
    var d = document.createElement('dialog'); d.className = 'gma-dlg';
    var wrap = document.createElement('div'); wrap.className = 'gma'; wrap.style.display = 'block';
    d.innerHTML = '<form novalidate>' + html + '<p class="err" role="alert"></p><div class="row"><button class="no" type="button">Cancelar</button><button class="ok" type="submit">Entrar</button></div></form>';
    wrap.appendChild(d); document.body.appendChild(wrap);
    var f = d.querySelector('form'), err = d.querySelector('.err'), ok = d.querySelector('.ok');
    d.querySelector('.no').onclick = function () { d.close(); };
    d.addEventListener('close', function () { wrap.remove(); });
    f.onsubmit = function (e) {
      e.preventDefault(); err.textContent = ''; ok.disabled = true;
      Promise.resolve(onSubmit(f)).then(function (close) { if (close !== false) d.close(); }, function (x) { err.textContent = x.message; }).then(function () { ok.disabled = false; });
    };
    d.showModal(); var first = d.querySelector('input'); if (first) first.focus();
    return d;
  }
  function login(user, password) {
    return call('POST', '/login', { user: user, password: password }).then(function (r) {
      token = r.token; me = { kind: r.kind, name: r.name, admin: r.admin, player: r.player };
      sync(); location.reload(); return me;
    });
  }
  function open() {
    var d = dialog('<h3>Entrar</h3><p>Una cuenta para todo el sitio. Si solo jugás al torneo, usá tu apodo y PIN.</p>' +
      '<label>Usuario o apodo<input name="u" autocomplete="username" autocapitalize="none" spellcheck="false"></label>' +
      '<label>Contraseña o PIN<input name="p" type="password" autocomplete="current-password"></label>', function (f) {
      return login(f.u.value, f.p.value);
    });
    return d;
  }
  function password() {
    var d = dialog('<h3>Cambiar contraseña</h3>' +
      '<label>Contraseña actual<input name="c" type="password" autocomplete="current-password"></label>' +
      '<label>Nueva (mínimo 8 caracteres)<input name="n" type="password" autocomplete="new-password"></label>' +
      '<label>Repetila<input name="n2" type="password" autocomplete="new-password"></label>', function (f) {
      if (f.n.value.length < 8) throw new Error('La nueva contraseña tiene que tener al menos 8 caracteres.');
      if (f.n.value !== f.n2.value) throw new Error('Las contraseñas nuevas no coinciden.');
      return call('POST', '/password', { current: f.c.value, next: f.n.value }, token).then(function () { toast('Contraseña cambiada'); });
    });
    d.querySelector('.ok').textContent = 'Guardar';
  }
  function toast(t) {
    var el = document.createElement('div'); el.className = 'gma';
    el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(24px + env(safe-area-inset-bottom,0px));z-index:90;display:block';
    el.innerHTML = '<div style="background:var(--a-fg);color:var(--a-bg);padding:10px 16px;border-radius:10px;font-size:14px">' + esc(t) + '</div>';
    document.body.appendChild(el); setTimeout(function () { el.remove(); }, 2600);
  }
  function logout() {
    var t = token; clearAll();
    var go = function () { location.reload(); };
    if (t) fetch(API + '/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }).then(go, go); else go();
  }

  // Validar la sesión con el servidor
  var ready = !token ? Promise.resolve(null) : call('GET', '/me', null, token).then(function (r) {
    var was = JSON.stringify(me); me = r; sync(); render();
    if (was !== JSON.stringify(me) && was !== 'null') document.dispatchEvent(new CustomEvent('gm-auth', { detail: me }));
    return me;
  }, function (e) {
    if (e.status === 401 || e.status === 403) { var had = !!me; clearAll(); render(); if (had) location.reload(); }
    return me;
  });
  if (token && me) sync();

  window.GMAuth = { me: function () { return token ? me : null; }, token: function () { return token; }, open: open, login: login, logout: logout, ready: ready };
  window.gmAccount = { get: function () { return token && me && me.player ? { token: token, me: { id: me.player.id, name: me.player.name } } : null; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
})();
