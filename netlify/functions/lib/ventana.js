// La ventana de 24h de WhatsApp, por cliente.
//
// Importa porque el mensaje post-llamada solo se puede mandar como texto libre
// mientras el cliente haya escrito en las ultimas 24h. Cerrada la ventana, Meta
// solo deja mandar plantillas aprobadas, asi que el vendedor tiene que saberlo
// ANTES de ponerse a escribir.
//
// COMO SE AVERIGUA (y por que asi):
// El modulo `messages__s` no admite /search, y COQL devuelve OAUTH_SCOPE_MISMATCH
// sobre el (probado el 2026-09-03). Barrer las 10.313 conversaciones son ~52
// llamadas. Pero no hace falta: si el cliente escribio en las ultimas 24h, su
// conversacion se modifico en las ultimas 24h, asi que entra en una lectura con
// `If-Modified-Since` de 48h. Y si no aparece ahi, la ventana esta cerrada,
// que es justo lo que queriamos saber. Son 1 o 2 llamadas por corrida.
import { limpiarNumero } from './telefono.js';

const API = 'https://www.zohoapis.com/crm/v6';

const CAMPOS = ['mobile_number__s', 'last_message__s', 'conversation_status__s', 'message_time__s', 'sender__s'].join(',');

export const HORAS_VENTANA = 24;

/**
 * Mapa telefono normalizado -> estado de la conversacion, mirando hacia atras
 * `horas` (48 por defecto: cubre las 24 de la ventana con margen).
 */
export async function mapaDeConversaciones(token, horas = 48) {
  const desde = new Date(Date.now() - horas * 3600e3).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const mapa = new Map();

  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`${API}/messages__s?fields=${CAMPOS}&per_page=200&page=${page}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}`, 'If-Modified-Since': desde },
    });
    // 204 = sin resultados, 304 = nada cambio en la ventana.
    if (r.status === 204 || r.status === 304) break;
    const j = await r.json().catch(() => ({}));
    if (j.status === 'error') throw new Error(`messages__s: ${j.code} ${j.message}`);

    for (const c of j.data || []) {
      const k = limpiarNumero(c.mobile_number__s);
      if (!k) continue;
      const previo = mapa.get(k);
      const t = new Date(c.message_time__s || 0).getTime();
      if (!previo || t > previo.t) mapa.set(k, { t, estado: c.conversation_status__s, sender: c.sender__s });
    }
    if (!j.info?.more_records) break;
  }
  return mapa;
}

/**
 * Estado de la ventana para un telefono. `mapa` es lo que devuelve la funcion
 * de arriba.
 *
 * Ojo con una sutileza: `conversation_status__s` vale "Responded" cuando el
 * ultimo que hablo fue el cliente y "Replied" cuando contesto el equipo. La
 * ventana la abre el CLIENTE, no el equipo, asi que "Replied" no prueba que
 * este abierta: prueba que hubo movimiento. Por eso se usa el tiempo del
 * ultimo mensaje, no el estado.
 */
export function estadoVentana(mapa, telefono) {
  const k = limpiarNumero(telefono);
  if (!k) return { abierta: null, motivo: 'el lead no tiene telefono cargado' };

  const c = mapa.get(k);
  if (!c) return { abierta: false, horasRestantes: 0, motivo: 'sin mensajes de WhatsApp en las ultimas 48h' };

  const horas = (Date.now() - c.t) / 3600e3;
  if (horas >= HORAS_VENTANA) {
    return { abierta: false, horasRestantes: 0, motivo: `el ultimo mensaje fue hace ${Math.round(horas)}h` };
  }
  return {
    abierta: true,
    horasRestantes: Math.round(HORAS_VENTANA - horas),
    ultimoMensajeHace: Math.round(horas),
    esperandoRespuesta: c.estado === 'Responded',
  };
}

/** Como se muestra en Slack. */
export function etiquetaVentana(v) {
  if (!v || v.abierta === null) return '📵 sin teléfono en el CRM';
  if (!v.abierta) return `⛔ ventana cerrada (${v.motivo}) · solo mail o plantilla`;
  return `⏳ ventana abierta, quedan ${v.horasRestantes}h · se puede escribir libre`;
}
