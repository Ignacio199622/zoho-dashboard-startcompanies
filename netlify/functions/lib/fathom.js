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

/** El mail del invitado externo, que es la clave para encontrarlo en Zoho. */
export function mailDelCliente(reunion) {
  const internos = /@startcompanies\.(io|us)$/i;
  const externos = (reunion.calendar_invitees || []).filter(
    (i) => i.email && !internos.test(i.email)
  );
  return externos[0]?.email || null;
}

export function duracionMin(reunion) {
  if (!reunion.recording_start_time || !reunion.recording_end_time) return null;
  return Math.round(
    (new Date(reunion.recording_end_time) - new Date(reunion.recording_start_time)) / 60000
  );
}
