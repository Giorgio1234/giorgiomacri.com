/* Cartel especial por IP: el servidor decide si la IP de quien visita tiene un mensaje cargado desde el panel. */
(function () {
  'use strict';
  var dev = null;
  try {
    dev = localStorage.getItem('gm-device');
    if (!dev) {
      dev = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
      localStorage.setItem('gm-device', dev);
    }
  } catch (e) {}
  var page = /\/posiciones\//.test(location.pathname) ? 'posiciones' : /\/torneo\//.test(location.pathname) ? 'torneo' : 'libre';
  fetch('/api/sudoku/notice?p=' + page, { cache: 'no-store', headers: dev ? { 'X-Device': dev } : {} })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (j) {
      if (!j || !j.message) return;
      var SEEN = 'gm-notice-seen';
      if (!j.always) { try { if (localStorage.getItem(SEEN) === j.key) return; } catch (e) {} }
      var wrap = document.createElement('div');
      wrap.className = 'notice-veil';
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.setAttribute('aria-labelledby', 'noticeText');
      wrap.innerHTML = '<div class="notice-card"><p id="noticeText"></p><button class="btn" type="button">Cerrar</button></div>';
      wrap.querySelector('p').textContent = j.message;
      function close() {
        if (!j.always) { try { localStorage.setItem(SEEN, j.key); } catch (e) {} }
        wrap.remove();
        document.removeEventListener('keydown', onKey, true);
      }
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
      wrap.querySelector('button').addEventListener('click', close);
      wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(wrap);
      wrap.querySelector('button').focus();
    })
    .catch(function () {});
})();
