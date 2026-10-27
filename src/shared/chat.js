/* Asistente: chat con herramientas. GMChat.mount({ mode: 'float' | 'page', el, token(), page, date(), onChange(kinds), onAuth() }) */
(function () {
  'use strict';
  if (window.GMChat) return;
  var API = '/api/sudoku/asistente';
  var HKEY = 'gm-chat-v1';
  var CSS = '' +
    '.gmc{--c-bg:#15151c;--c-card:#1f1f28;--c-card2:#272732;--c-line:#30303c;--c-fg:#f1efe9;--c-fg2:#a3a1ad;--c-fg3:#72707d;--c-acc:#fd9b65;--c-on:#1a0f08;--c-me:#2c2c38;--c-ok:#6fd59a;--c-bad:#ff7a6b;--c-add:#123524;--c-del:#3b1717;' +
    'font-family:"Inter Tight",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.45;color:var(--c-fg);-webkit-font-smoothing:antialiased;font-variant-numeric:normal}' +
    '@media (prefers-color-scheme:light){:root:not([data-theme="dark"]) .gmc{--c-bg:#ffffff;--c-card:#f6f5f1;--c-card2:#eeece6;--c-line:#e2dfd7;--c-fg:#15141a;--c-fg2:#5d5b66;--c-fg3:#8d8a95;--c-acc:#c4501a;--c-on:#fff;--c-me:#f0eee8;--c-ok:#1f8a52;--c-bad:#c8321f;--c-add:#e3f5e9;--c-del:#fbe4e1}}' +
    ':root[data-theme="light"] .gmc{--c-bg:#ffffff;--c-card:#f6f5f1;--c-card2:#eeece6;--c-line:#e2dfd7;--c-fg:#15141a;--c-fg2:#5d5b66;--c-fg3:#8d8a95;--c-acc:#c4501a;--c-on:#fff;--c-me:#f0eee8;--c-ok:#1f8a52;--c-bad:#c8321f;--c-add:#e3f5e9;--c-del:#fbe4e1}' +
    '.gmc *{box-sizing:border-box}.gmc button,.gmc textarea{font:inherit;color:inherit}.gmc button{cursor:pointer}' +
    '.gmc-fab{position:fixed;right:calc(18px + env(safe-area-inset-right,0px));bottom:calc(18px + env(safe-area-inset-bottom,0px));z-index:60;width:56px;height:56px;border-radius:50%;border:0;background:var(--c-acc);color:var(--c-on);display:grid;place-items:center;box-shadow:0 10px 30px rgba(0,0,0,.3)}' +
    '.gmc-fab:hover{transform:translateY(-1px)}' +
    '.gmc-panel{display:flex;flex-direction:column;background:var(--c-bg);min-height:0}' +
    '.gmc.float .gmc-panel{position:fixed;z-index:61;right:calc(18px + env(safe-area-inset-right,0px));bottom:calc(18px + env(safe-area-inset-bottom,0px));width:min(420px,calc(100vw - 36px));height:min(680px,calc(100dvh - 36px));border:1px solid var(--c-line);border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.4);overflow:hidden}' +
    '@media (max-width:560px){.gmc.float .gmc-panel{inset:0;width:auto;height:auto;border-radius:0;border:0;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}' +
    '.gmc.page .gmc-panel{height:100%}' +
    '.gmc-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--c-line)}' +
    '.gmc-head b{font-size:16px;flex:1}.gmc-head small{color:var(--c-fg3);font-size:12px}' +
    '.gmc-ib{border:0;background:var(--c-card);border-radius:10px;height:34px;min-width:34px;padding:0 10px;display:grid;place-items:center;font-size:13px;color:var(--c-fg2)}.gmc-ib:hover{color:var(--c-fg)}' +
    '.gmc-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain}' +
    '.gmc-m{max-width:88%;padding:9px 12px;border-radius:14px;white-space:normal;overflow-wrap:anywhere}' +
    '.gmc-m.user{align-self:flex-end;background:var(--c-me);border-bottom-right-radius:4px}' +
    '.gmc-m.assistant{align-self:flex-start;background:var(--c-card);border-bottom-left-radius:4px}' +
    '.gmc-m.err{align-self:flex-start;background:transparent;border:1px solid var(--c-bad);color:var(--c-bad)}' +
    '.gmc-m p{margin:0}.gmc-m p+p,.gmc-m ul+p,.gmc-m p+ul{margin-top:6px}.gmc-m ul{margin:4px 0 0;padding-left:18px}.gmc-m code{font-family:ui-monospace,Menlo,monospace;font-size:13px;background:var(--c-card2);padding:1px 4px;border-radius:4px}' +
    '.gmc-acts{display:flex;flex-direction:column;gap:3px;margin-top:6px}.gmc-acts span{font-size:12.5px;color:var(--c-fg2)}.gmc-acts span::before{content:"✓ ";color:var(--c-ok);font-weight:700}' +
    '.gmc-step{align-self:flex-start;color:var(--c-fg3);font-size:13px;display:flex;align-items:center;gap:8px}' +
    '.gmc-step i{width:14px;height:14px;border-radius:50%;border:2px solid var(--c-line);border-top-color:var(--c-acc);animation:gmcspin .8s linear infinite}' +
    '@keyframes gmcspin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.gmc-step i{animation:none}}' +
    '.gmc-empty{color:var(--c-fg3);font-size:14px;margin:auto 0;text-align:center;padding:20px}' +
    '.gmc-empty b{display:block;color:var(--c-fg);font-size:17px;margin-bottom:6px}' +
    '.gmc-sugs{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:12px}.gmc-sugs button{border:1px solid var(--c-line);background:var(--c-card);border-radius:999px;padding:7px 12px;font-size:13px;color:var(--c-fg2)}.gmc-sugs button:hover{color:var(--c-fg)}' +
    '.gmc-site{border:1px solid var(--c-acc);border-radius:14px;padding:10px 12px;background:var(--c-card)}' +
    '.gmc-site b{display:block;margin-bottom:4px}.gmc-site pre{margin:6px 0 0;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.35;white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto;background:var(--c-bg);border-radius:8px;padding:8px}' +
    '.gmc-site pre .a{background:var(--c-add);display:block}.gmc-site pre .d{background:var(--c-del);display:block}.gmc-site pre .h{color:var(--c-fg3);display:block}' +
    '.gmc-site .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}' +
    '.gmc-btn{border:0;border-radius:10px;height:36px;padding:0 14px;background:var(--c-acc);color:var(--c-on);font-weight:600;font-size:14px}.gmc-btn.ghost{background:var(--c-card2);color:var(--c-fg)}.gmc-btn:disabled{opacity:.5;cursor:default}' +
    '.gmc-in{display:flex;gap:8px;align-items:flex-end;padding:10px 12px;border-top:1px solid var(--c-line)}' +
    '.gmc-in textarea{flex:1;min-width:0;resize:none;max-height:160px;min-height:42px;border:1px solid var(--c-line);border-radius:12px;background:var(--c-card);padding:10px 12px;font-size:16px;line-height:1.35;outline:none}' +
    '.gmc-in textarea:focus{border-color:var(--c-acc)}' +
    '.gmc-send{flex:none;width:42px;height:42px;border:0;border-radius:12px;background:var(--c-acc);color:var(--c-on);display:grid;place-items:center}.gmc-send:disabled{opacity:.45;cursor:default}' +
    '.gmc-note{font-size:12px;color:var(--c-fg3);padding:0 14px 8px}';
  var ICON_CHAT = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 10.5h7M8.5 14h4.5"/></svg>';
  var ICON_SEND = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>';
  var ICON_X = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var SUGS = {
    'calorías': ['Comí 2 empanadas de carne y una coca zero', '¿Cómo vengo hoy con las proteínas?', 'Pesé 96,1 kg hoy'],
    'agenda': ['Agregá estudiar análisis mañana de 10 a 12', 'Pasá las tareas pendientes a mañana', '¿Qué tengo hoy?'],
    'asistente': ['Almorcé milanesa con puré', 'Mañana a las 18 gimnasio, todos los días hábiles', 'Agregá a la portada un link a mi Instagram']
  };

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function md(s) {
    var lines = esc(s).split('\n'), out = [], list = null;
    lines.forEach(function (l) {
      l = l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
      var m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l);
      if (m) { if (!list) { list = []; } list.push('<li>' + m[1] + '</li>'); return; }
      if (list) { out.push('<ul>' + list.join('') + '</ul>'); list = null; }
      if (l.trim()) out.push('<p>' + l.replace(/^#+\s*/, '') + '</p>');
    });
    if (list) out.push('<ul>' + list.join('') + '</ul>');
    return out.join('');
  }
  function load() { try { var h = JSON.parse(localStorage.getItem(HKEY) || '[]'); return Array.isArray(h) ? h : []; } catch (e) { return []; } }
  function save(h) { try { localStorage.setItem(HKEY, JSON.stringify(h.slice(-60))); } catch (e) {} }

  function mount(o) {
    if (!document.getElementById('gmc-css')) { var st = document.createElement('style'); st.id = 'gmc-css'; st.textContent = CSS; document.head.appendChild(st); }
    var root = document.createElement('div');
    root.className = 'gmc ' + (o.mode === 'page' ? 'page' : 'float');
    var history = load(), busy = false, site = null, info = null, siteMsg = '';
    root.innerHTML = (o.mode === 'page' ? '' : '<button class="gmc-fab" type="button" aria-label="Abrir el asistente">' + ICON_CHAT + '</button>') +
      '<section class="gmc-panel" role="dialog" aria-label="Asistente"' + (o.mode === 'page' ? '' : ' hidden') + '>' +
      '<div class="gmc-head"><b>Asistente</b><small class="gmc-use"></small><button class="gmc-ib gmc-new" type="button">Nueva</button>' +
      (o.mode === 'page' ? '' : '<button class="gmc-ib gmc-close" type="button" aria-label="Cerrar">' + ICON_X + '</button>') + '</div>' +
      '<div class="gmc-log" aria-live="polite"></div>' +
      '<form class="gmc-in"><textarea rows="1" placeholder="Pedime algo…" aria-label="Mensaje"></textarea><button class="gmc-send" type="submit" aria-label="Enviar">' + ICON_SEND + '</button></form>' +
      '</section>';
    (o.el || document.body).appendChild(root);
    var q = function (s) { return root.querySelector(s); };
    var panel = q('.gmc-panel'), log = q('.gmc-log'), ta = q('textarea'), send = q('.gmc-send');

    function call(method, p, body) {
      var h = { 'Content-Type': 'application/json' }, t = o.token && o.token();
      if (t) h.Authorization = 'Bearer ' + t;
      return fetch(API + p, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined })
        .catch(function () { throw new Error('Sin conexión con el servidor.'); })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || 'Algo falló (' + r.status + ').'); e.status = r.status; throw e; } return j; }); });
    }
    function scroll() { log.scrollTop = log.scrollHeight; }
    function render(step) {
      var h = '';
      if (!history.length && !step) {
        var sg = SUGS[o.page] || SUGS.asistente;
        h = '<div class="gmc-empty"><b>¿Qué hacemos?</b>Cargo comidas, armo tu agenda o cambio cosas del sitio.<div class="gmc-sugs">' +
          sg.map(function (s) { return '<button type="button" data-sug="' + esc(s) + '">' + esc(s) + '</button>'; }).join('') + '</div></div>';
      }
      history.forEach(function (m) {
        h += '<div class="gmc-m ' + (m.err ? 'err' : m.role) + '">' + (m.role === 'user' ? '<p>' + esc(m.content).replace(/\n/g, '<br>') + '</p>' : md(m.content)) +
          (m.actions && m.actions.length ? '<div class="gmc-acts">' + m.actions.map(function (a) { return '<span>' + esc(a.text) + '</span>'; }).join('') + '</div>' : '') + '</div>';
      });
      if (step) h += '<div class="gmc-step"><i></i>' + esc(step) + '</div>';
      if (site && site.pending) {
        var diff = String(site.diff || '').split('\n').map(function (l) {
          var c = /^\+(?!\+\+)/.test(l) ? 'a' : /^-(?!--)/.test(l) ? 'd' : /^(@@|diff |index |\+\+\+|---)/.test(l) ? 'h' : '';
          return '<span' + (c ? ' class="' + c + '"' : '') + '>' + (esc(l) || ' ') + '</span>';
        }).join('');
        h += '<div class="gmc-site"><b>Cambios en el sitio, sin publicar</b><span style="font-size:13px;color:var(--c-fg2)">' + esc(site.stat.split('\n').pop().trim()) + '</span>' +
          '<details><summary style="cursor:pointer;font-size:13px;margin-top:6px">Ver cambios</summary><pre>' + diff + (site.truncated ? '\n…' : '') + '</pre></details>' +
          '<div class="row"><button class="gmc-btn" type="button" data-pub>Publicar</button><button class="gmc-btn ghost" type="button" data-disc>Descartar</button></div></div>';
      } else if (site && site.published) {
        h += '<div class="gmc-site"><b>Publicado</b><span style="font-size:13px;color:var(--c-fg2)">Se ve en el sitio en un minuto, más o menos.</span><div class="row"><button class="gmc-btn ghost" type="button" data-undo>Deshacer</button></div></div>';
      }
      log.innerHTML = h; scroll();
    }
    function usage() { q('.gmc-use').textContent = info ? info.used + '/' + info.limit + ' hoy' : ''; }
    function refreshStatus() {
      return call('GET', '/status').then(function (r) {
        info = r; usage();
        if (r.site && r.site.pending) site = r.site; else if (site && site.pending) site = null;
        if (!r.enabled) { history.length || (log.innerHTML = '<div class="gmc-empty"><b>Falta la clave</b>Hay que cargar OPENROUTER_API_KEY en el servidor.</div>'); }
        else if (!busy) render();
      }).catch(function (e) {
        if (e.status === 401) { log.innerHTML = '<div class="gmc-empty"><b>Entrá primero</b>' + esc(e.message) + '</div>'; if (o.onAuth) o.onAuth(); }
      });
    }
    function poll(id) {
      return new Promise(function (resolve, reject) {
        var fails = 0;
        (function tick() {
          call('GET', '/job/' + id).then(function (j) {
            if (j.done) return resolve(j);
            render(j.step || 'Pensando…'); setTimeout(tick, 900);
          }).catch(function (e) { if (++fails > 4 || e.status === 404 || e.status === 401) reject(e); else setTimeout(tick, 1500); });
        })();
      });
    }
    function submit(text) {
      text = String(text || '').trim(); if (!text || busy) return;
      busy = true; send.disabled = true; ta.value = ''; grow();
      if (site && site.published) site = null;
      history.push({ role: 'user', content: text }); save(history); render('Pensando…');
      siteMsg = text.slice(0, 100);
      var msgs = history.filter(function (m) { return !m.err; }).map(function (m) {
        var c = m.content; if (m.actions && m.actions.length) c += '\n\n[Hecho: ' + m.actions.map(function (a) { return a.text; }).join('; ') + ']';
        return { role: m.role, content: c };
      });
      call('POST', '/chat', { messages: msgs, page: o.page, date: o.date ? o.date() : '' })
        .then(function (r) { return poll(r.job); })
        .then(function (j) {
          if (j.error) history.push({ role: 'assistant', content: j.error, err: true });
          else history.push({ role: 'assistant', content: j.reply, actions: j.actions });
          if (j.site) site = j.site.pending ? j.site : null;
          var kinds = {}; (j.actions || []).forEach(function (a) { kinds[a.kind] = true; });
          if (o.onChange && Object.keys(kinds).length) { try { o.onChange(kinds); } catch (e) {} }
        })
        .catch(function (e) { history.push({ role: 'assistant', content: e.message, err: true }); })
        .then(function () { save(history); busy = false; send.disabled = false; render(); if (info) { info.used++; usage(); } if (o.mode === 'page' || !panel.hidden) ta.focus(); });
    }
    function grow() { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; }
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !('ontouchstart' in window && matchMedia('(pointer:coarse)').matches)) { e.preventDefault(); submit(ta.value); } });
    q('form').addEventListener('submit', function (e) { e.preventDefault(); submit(ta.value); });
    log.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.sug) return submit(b.dataset.sug);
      if (b.hasAttribute('data-pub') || b.hasAttribute('data-disc') || b.hasAttribute('data-undo')) {
        b.disabled = true;
        var p = b.hasAttribute('data-pub') ? call('POST', '/site/publish', { message: siteMsg || 'cambio pedido por chat' }).then(function () { site = { published: true }; })
          : b.hasAttribute('data-disc') ? call('POST', '/site/discard').then(function () { site = null; history.push({ role: 'assistant', content: 'Descarté los cambios.' }); save(history); })
          : call('POST', '/site/undo').then(function (r) { site = null; history.push({ role: 'assistant', content: 'Deshice "' + r.undone + '". Se ve en un minuto.' }); save(history); });
        p.catch(function (err) { history.push({ role: 'assistant', content: err.message, err: true }); save(history); }).then(render);
      }
    });
    q('.gmc-new').addEventListener('click', function () { if (busy) return; history = []; save(history); render(); ta.focus(); });
    function open() { panel.hidden = false; if (fab) fab.hidden = true; render(); refreshStatus(); setTimeout(function () { ta.focus(); }, 30); }
    function close() { panel.hidden = true; if (fab) fab.hidden = false; }
    var fab = q('.gmc-fab');
    if (fab) {
      fab.addEventListener('click', open);
      q('.gmc-close').addEventListener('click', close);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) close(); });
    } else { render(); refreshStatus(); }
    return { open: open, close: close, refresh: refreshStatus, el: root };
  }
  window.GMChat = { mount: mount };
})();
