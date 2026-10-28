# giorgiomacri.com

Sitio personal: un catálogo de herramientas y juegos que corren en el navegador.

| Ruta | Qué es |
|---|---|
| `/` | Portada (catálogo) |
| `/sudoku/` | Sudoku libre |
| `/sudoku/torneo/` | Torneo semanal (necesita el servidor) |
| `/sudoku/posiciones/` | Tabla pública del torneo |
| `/admin/` | Panel de admin de todo el sitio: cuentas y sudoku (`/sudoku/admin/` redirige acá) |
| `/pomodoro/` | Temporizador pomodoro |
| `/poker/` | Deudas de poker |
| `/agenda/` | Agenda diaria privada (necesita el servidor y login) |
| `/calorias/` | Contador de calorías (necesita una cuenta del sitio) |
| `/asistente/` | Chat privado que carga calorías, maneja la agenda y propone cambios al sitio |

## Estructura

- `src/` — páginas fuente. `src/shared/` tiene CSS y JS compartidos que se insertan con marcadores `/*@shared/archivo*/`.
- `src/static/` — archivos que se copian tal cual a `site/` (íconos, imágenes), con la misma ruta.
- `site/` — páginas listas para publicar. **Se generan con `node build.js`; no se editan a mano.**
- `server/` — API del torneo (Node ≥ 22.13, sin dependencias, SQLite incorporado).
- `deploy/` — servicio de systemd, Nginx, script de instalación y de sincronización.

## Agregar algo nuevo

1. Crear `src/nombre.html`.
2. Sumarlo a `PAGES` en `build.js`.
3. Sumarlo a `ITEMS` en `src/home.html` (aparece solo en la portada, el buscador y las categorías).
4. `node build.js` y subir los cambios.

## Publicación

El VPS revisa este repo cada minuto (`giorgiomacri-sync.timer`):

- Cambios en `site/` se publican al instante en `/var/www/giorgiomacri.com`.
- Cambios en `server/` se copian a `/opt/sudoku-torneo`, con backup previo de la base en `/var/lib/giorgiomacri-deploy/backups/` (últimos 30). El servicio se reinicia apenas llega el cambio (tarda un segundo; las partidas en curso no se pierden). Para esperar a que no haya tableros en juego, poné `Environment=MAX_WAIT_MIN=45` en el servicio `giorgiomacri-sync`.
- Cambios en `deploy/` no se aplican solos (servicio de systemd y Nginx se tocan a mano).

## Cuentas

Hay una sola cuenta para todo el sitio (`server/lib/cuentas.js`): se entra con el botón de arriba a la derecha en cualquier página y la sesión vale para Sudoku, Calorías, Agenda, Asistente y el panel. Las cuentas las crea el admin en `/admin/`. Cada cuenta puede tener un jugador de sudoku unido (se elige en el panel, o se une sola si entra al torneo con la cuenta puesta). Los amigos que solo juegan siguen entrando con apodo y PIN.

El único admin es la cuenta `OWNER_USER` (por defecto `giorgio`); al arrancar, el servidor se lo saca a cualquier otra. No hay contraseñas de admin en el archivo de configuración. Si te olvidás la contraseña: `sudo -u sudoku node /opt/sudoku-torneo/cuenta-admin.js` (pide una nueva y cierra todas las sesiones). Las sesiones vencen a los 30 días sin uso o a los 180 días, y desde el menú de la cuenta se puede cerrar sesión en todos lados.

El emulador de Flash (Ruffle) no se carga de un CDN: `deploy/sync.sh` lo baja del registro de npm, verifica su hash y lo deja en `/vendor/ruffle-<versión>/`.

El contador de calorías usa cuentas propias que se crean desde el panel de admin (sección "Calorías: cuentas"). Para "Describir" y "Leer etiqueta" hace falta `OPENROUTER_API_KEY` (modelo `deepseek/deepseek-v4.1-flash-1017`) o `ANTHROPIC_API_KEY` (modelo `claude-haiku-5-5`) en `/etc/sudoku-torneo.env`; el modelo se cambia con `CAL_AI_MODEL` y el límite es de 30 consultas por persona por día (`CAL_AI_DAILY`). Después: `systemctl restart sudoku-torneo`.

El asistente (`server/lib/asistente.js`) usa OpenRouter con herramientas. Entra con el usuario de la agenda (o tu cuenta de calorías si se llama igual) y tiene un botón flotante en Calorías y Agenda. Para tocar código necesita `GITHUB_TOKEN`: trabaja en un clon aparte (`/var/lib/sudoku-torneo/site-work`), solo puede editar `src/` y registrar páginas en `build.js`, y no publica nada hasta que tocás "Publicar" (commit "Asistente: …" en `main`; "Deshacer" lo revierte). No puede tocar `server/` ni `deploy/`.

Instalación única: `bash deploy/install.sh` como root en el VPS.

Ver lo que pasó: `journalctl -u giorgiomacri-sync -n 30 --no-pager`

Volver a una versión anterior: `git revert <commit>` y subir; el VPS la publica sola.
