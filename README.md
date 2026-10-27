# giorgiomacri.com

Sitio personal: un catálogo de herramientas y juegos que corren en el navegador.

| Ruta | Qué es |
|---|---|
| `/` | Portada (catálogo) |
| `/sudoku/` | Sudoku libre |
| `/sudoku/torneo/` | Torneo semanal (necesita el servidor) |
| `/sudoku/posiciones/` | Tabla pública del torneo |
| `/sudoku/admin/` | Panel del torneo |
| `/pomodoro/` | Temporizador pomodoro |
| `/poker/` | Deudas de poker |
| `/agenda/` | Agenda diaria privada (necesita el servidor y login) |
| `/calorias/` | Contador de calorías con cuentas (las crea el admin en `/sudoku/admin/`) |

## Estructura

- `src/` — páginas fuente. `src/shared/` tiene CSS y JS compartidos que se insertan con marcadores `/*@shared/archivo*/`.
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
- Cambios en `server/` se copian a `/opt/sudoku-torneo`, con backup previo de la base en `/var/lib/giorgiomacri-deploy/backups/` (últimos 30). El servicio se reinicia cuando no hay tableros en juego, o a los 45 minutos como máximo.
- Cambios en `deploy/` no se aplican solos (servicio de systemd y Nginx se tocan a mano).

La agenda usa `AGENDA_USER` y `AGENDA_PASSWORD` de `/etc/sudoku-torneo.env`; si no están, el usuario es `giorgio` y la contraseña es `ADMIN_PASSWORD`. Después de cambiarlas: `systemctl restart sudoku-torneo`.

El contador de calorías usa cuentas propias que se crean desde el panel de admin (sección "Calorías: cuentas"). Para "Describir" y "Leer etiqueta" hace falta `ANTHROPIC_API_KEY` en `/etc/sudoku-torneo.env`; el modelo es `claude-haiku-5-5` (cambiable con `CAL_AI_MODEL`) y el límite es de 30 consultas por persona por día (`CAL_AI_DAILY`). Después: `systemctl restart sudoku-torneo`.

Instalación única: `bash deploy/install.sh` como root en el VPS.

Ver lo que pasó: `journalctl -u giorgiomacri-sync -n 30 --no-pager`

Volver a una versión anterior: `git revert <commit>` y subir; el VPS la publica sola.
