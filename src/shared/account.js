/* Sesión del torneo compartida entre Libre, Torneo y Posiciones.
 * Muestra el nombre y "Salir" en la barra (o "Entrar"), y valida la sesión con el servidor.
 * window.gmAccount.get() devuelve { token, me } o null. */
(function () {
  'use strict';
  var TOKEN_KEY = 'gm-torneo-token', ME_KEY = 'gm-torneo-me';
  var tok = null, me = null;
  try { tok = localStorage.getItem(TOKEN_KEY); me = JSON.parse(localStorage.getItem(ME_KEY) || 'null'); } catch (e) {}
  if (!tok || !me) { tok = null; me = null; }
  var el = document.getElementById('acct');

  function render() {
    if (!el) return;
    if (tok && me) {
      el.innerHTML = '<span class="acct-name"></span><button class="link" type="button">Salir</button>';
      el.querySelector('.acct-name').textContent = me.name;
      el.querySelector('button').addEventListener('click', logout);
    } else {
      el.innerHTML = '<a class="acct-in" href="/sudoku/torneo/">Entrar</a>';
    }
  }
  function changed() { document.dispatchEvent(new CustomEvent('gm-account', { detail: api.get() })); }
  function clear() {
    tok = null; me = null;
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(ME_KEY); } catch (e) {}
    render(); changed();
  }
  function logout() {
    var t = tok;
    fetch('/api/sudoku/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }).catch(function () {});
    clear();
  }

  var api = { get: function () { return tok && me ? { token: tok, me: me } : null; } };
  window.gmAccount = api;
  render();

  if (tok) {
    fetch('/api/sudoku/me', { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) return clear();
        if (!r.ok) return;
        return r.json().then(function (j) {
          me = { id: j.id, name: j.name };
          try { localStorage.setItem(ME_KEY, JSON.stringify(me)); } catch (e) {}
          render(); changed();
        });
      })
      .catch(function () {});
  }
})();
