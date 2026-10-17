# Vigía

Un informe por DM de Slack a Ignacio (`VIGIA_DIARIO_A`, default `U0869LQ3G4C`) a las 9:00 y a las 18:00 de Argentina (cron `0 12,21 * * *` UTC, todos los días). Un solo mensaje por corrida:

- 🔴 **Errores de usuarios**: errores del panel y pagos/firmas trabados (apagado hasta tener la clave de Benja) + lo que los clientes reportan como error por WhatsApp.
- 🟡 **Quejas y dudas repetidas**: WhatsApp del 786 agrupado con Gemini (solo lo que plantean 2 o más) + cuántos esperan respuesta hace más de 2 h.
- 🟢 **Mejoras sugeridas**: hasta 5, cada una con dónde y por qué.
- 🧱 **CRM trabado**: lo nuevo desde el último cierre de Control CRM y lo estancado hace 3 cierres.

Si no hay nada: `Sin novedades.`

## Semanal de mejoras (lunes, por DM)

Cron `0 12,13 * * 1` UTC: a las 9:00 ART a **Pablo Gijón** (`U0BTT434078`) y a las 10:00 a **Ignacio Campo** (`U08LT8252Q3`). Una sola función decide a quién por la hora (`lib/vigia/dm.js`).

Contenido: lo que más se repitió en 7 días (quejas, dudas, errores; cuántas veces y en cuántos días), las trabas del CRM de la semana (suma de nuevos de cada cierre de Control CRM) y el top 5 de mejoras con dónde, por qué y quién.

**Cero llamadas a Zoho**: cada corrida diaria guarda su foto en el store `vigia` (`corrida/<ISO>`, 21 días) y el semanal se arma con eso + la bitácora de Control CRM. Gemini solo junta temas parecidos y propone mejoras; las cuentas se suman en el código. El texto se arma una vez por lunes (`semanal/<fecha>`) y el segundo envío lo reusa. Los responsables posibles para "quién" están en `semanal.js` (se pisan con `VIGIA_RESPONSABLES`).

Envío (diario y semanal): los webhooks no mandan DMs, así que usa el bot token (`SLACK_BOT_TOKEN_VIGIA` o, si no está, el `SLACK_BOT_TOKEN` que ya existe). Con `chat:write` alcanza: `chat.postMessage` con `channel=<ID de usuario>` cae en el DM de la app, sin `conversations.open` ni `im:write`. Sin token, modo sombra (arma y guarda, no manda).

## Archivos

| Archivo | Qué hace |
|---|---|
| `netlify/functions/vigia.mjs` | el reloj, dispara la background |
| `netlify/functions/vigia-background.mjs` | junta, arma y manda por DM; candado de 20 min contra el doble disparo; guarda la foto del día |
| `netlify/functions/vigia-semanal.mjs` + `vigia-semanal-background.mjs` | el semanal de los lunes |
| `lib/vigia/semanal.js` | arma el semanal (1 llamada a Gemini, cero a Zoho) |
| `lib/vigia/dm.js` | destinatarios y DM por Slack |
| `lib/vigia/informe.js` | junta los bloques y arma el texto |
| `lib/vigia/whatsapp.js` | 1 llamada a Zoho + 1 a Gemini |
| `lib/vigia/crm.js` | lee la bitácora de Control CRM (store `control-crm`), cero llamadas a Zoho |
| `lib/vigia/panel.js` | errores del panel, apagado sin `VIGIA_API_BASE` / `VIGIA_API_KEY` |
| `_probar_vigia.mjs` (raíz) | prueba local con datos reales, sin Slack y sin pedir token |

## Zoho: una llamada, token compartido

`messages__s` con `If-Modified-Since` (desde el informe anterior, tope 24 h), una página de 200. Usa `get` de `lib/conversaciones/zoho.js`: se presta el token del store `zoho-token` y respeta la pausa compartida. **Nunca** pide un token propio por corrida. Si Zoho está en pausa, el bloque sale como "no se pudo leer" y el resto del informe sale igual.

Límite conocido: si hubo más de 200 conversaciones con movimiento (Matías manda muchas plantillas), se miran las 200 más nuevas y el informe lo aclara al pie. Y `last_message__s` es solo el último mensaje: se analiza lo que quedó sin contestar, no la conversación entera.

## Variables de entorno (Netlify, sitio metricastart)

| Variable | Para qué | Si falta |
|---|---|---|
| `SLACK_BOT_TOKEN` (ya cargado) o `SLACK_BOT_TOKEN_VIGIA` | DM del diario y del semanal (`chat:write`) | modo sombra: arma y guarda en el store `vigia`, no manda |
| `VIGIA_DIARIO_A` | opcional: ID de Slack que recibe el diario | `U0869LQ3G4C` (Ignacio) |
| `SLACK_WEBHOOK_VIGIA` | opcional: además del DM, copia del diario a un canal | solo DM |
| `VIGIA_API_BASE` + `VIGIA_API_KEY` | errores del panel y pagos/firmas trabados (header `x-vigia-key`) | línea "Errores del panel: pendiente de acceso" |
| `VIGIA_RESPONSABLES` | opcional: lista de quién hace qué para el semanal | la de `semanal.js` |
| `VIGIA_WHATSAPP` | `0` apaga el bloque WhatsApp | prendido |
| `GEMINI_API_KEY`, `ZOHO_*` | ya están cargadas para los otros agentes | |

## Contrato pedido a Benja (API del panel)

```
GET {VIGIA_API_BASE}/errores?desde=ISO    header x-vigia-key
GET {VIGIA_API_BASE}/trabados?desde=ISO   header x-vigia-key
-> [{ mensaje, cantidad?, usuario|email?, cuando? }]   (o { items: [...] } o { data: [...] })
```

## Store `vigia` (Netlify Blobs)

`ultima-corrida` (hasta dónde se leyó + último cierre de CRM informado, para no repetirlo), `ultimo-informe`, `bitacora` (60 corridas), `corrida/<ISO>` (foto de cada diario, 21 días), `semanal/<fecha>`, `bitacora-semanal`, `lock`, `lock-semanal-<hora>`.

## Probar

```
# local, solo lectura, sin Slack (baja antes los blobs con la CLI, ver el encabezado del script)
node _probar_vigia.mjs <carpeta-con-blobs> <salida.md>

# en Netlify, sin mandar: POST /.netlify/functions/vigia-background?seco=1  -> queda en `ultimo-informe-seco`
#                         POST /.netlify/functions/vigia-semanal-background?seco=1&hora=12  -> queda en `semanal-seco`
```

Si falla, avisa con `lib/aviso-falla.js` (#control-crm).
