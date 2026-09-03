// Cliente de Fathom. Solo lectura.
import { env } from './entorno.js';

export { env };

const BASE = 'https://api.fathom.ai/external/v1';

async function get(path) {
  const r = await fetch(`${BASE}/${path}`, { headers: { 'X-Api-Key': env.FATHOM_API_KEY } });
  if (!r.ok) {
    const e = new Error(`Fathom ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    // Un 429 no se arregla reintentando a los 3 segundos: hay que esperar de
    // verdad. Pasa cuando dos agentes piden lo mismo en la misma hora, o
    // cuando alguien estuvo probando a mano.
    if (r.status === 429) {
      const cabecera = Number(r.headers.get('retry-after'));
      e.reintentarEn = Number.isFinite(cabecera) && cabecera > 0 ? cabecera : 60;
    }
    throw e;
  }
  return r.json();
}

/** Reuniones mas recientes, con transcripcion y resumen. */
export async function reunionesRecientes(limite = 25) {
  const out = [];
  let cursor = null;
  while (out.length < limite) {
    const q = new URLSearchParams({
      include_transcript: 'true',
      include_summary: 'true',
      include_action_items: 'true',
      limit: String(Math.min(50, limite - out.length)),
    });
    if (cursor) q.set('cursor', cursor);
    const j = await get(`meetings?${q}`);
    const lote = j.items || [];
    out.push(...lote);
    cursor = j.next_cursor;
    if (!cursor || !lote.length) break;
  }
  return out.slice(0, limite);
}

/** La transcripcion como texto plano, con marca de tiempo y hablante. */
export function transcripcionATexto(reunion) {
  if (!Array.isArray(reunion.transcript)) return '';
  return reunion.transcript
    .map((t) => `[${t.timestamp}] ${t.speaker?.display_name || '?'}: ${t.text}`)
    .join('\n');
}

/** El mail del invitado externo, que es una de las dos claves para cruzar con Zoho.
 *
 * BUG CORREGIDO (2026-09-03): antes filtraba los internos con la regex
 * /@startcompanies\.(io|us)$/, que NO incluye startcompanies.NET, que es el
 * dominio de la mayoria del equipo en Zoho (ignacio@, santiago@, bautista@).
 * Consecuencia: en las reuniones donde participaba alguien de .net, esta
 * funcion podia devolver el mail del VENDEDOR como si fuera el del cliente.
 * Ahora manda `is_external`, que lo decide Fathom con el calendario y no
 * depende de que la lista de dominios este al dia. La regex queda solo de
 * respaldo para invitados viejos sin ese campo.
 */
const DOMINIOS_INTERNOS = /@startcompanies\.(io|us|net)$/i;

export function mailDelCliente(reunion) {
  const inv = reunion.calendar_invitees || [];
  const externos = inv.filter((i) => {
    if (!i.email) return false;
    if (typeof i.is_external === 'boolean') return i.is_external;
    return !DOMINIOS_INTERNOS.test(i.email);
  });
  return externos[0]?.email || null;
}

export function duracionMin(reunion) {
  if (!reunion.recording_start_time || !reunion.recording_end_time) return null;
  return Math.round(
    (new Date(reunion.recording_end_time) - new Date(reunion.recording_start_time)) / 60000
  );
}
