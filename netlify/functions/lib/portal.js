/*
 * EL ESPEJO EN EL PORTAL DE WHATSAPP (api-bot, bot-api.startcompanies.us).
 *
 * Matías sigue recibiendo el webhook del +52 y contestando desde acá. Lo que hace
 * este módulo es reflejar cada mensaje (del lead y de Matías) en el portal para
 * que el equipo lo vea en su bandeja y pueda tomar la conversación.
 *
 * Nunca tira: si el portal está caído (el 15-sep daba 502), Matías sigue igual.
 * Se activa con PORTAL_URL + MATIAS_INGEST_KEY en Netlify.
 */
import { env } from './entorno.js';

const URL_BASE = () => (env.PORTAL_URL || '').replace(/\/$/, '');
const CLAVE = () => env.MATIAS_INGEST_KEY || '';
const ESPERA_MS = 4000;

export function activo() {
  return Boolean(URL_BASE() && CLAVE());
}

async function llamar(ruta, opciones = {}) {
  const r = await fetch(`${URL_BASE()}${ruta}`, {
    ...opciones,
    headers: { 'Content-Type': 'application/json', 'x-matias-key': CLAVE(), ...(opciones.headers || {}) },
    signal: AbortSignal.timeout(ESPERA_MS),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`portal ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return j;
}

/**
 * Refleja un mensaje. `de` es 'lead' | 'matias' | 'humano'. Devuelve lo que contestó el
 * portal (o null si está apagado o falló), nunca rompe.
 */
export async function reflejar({ numero, de, texto, id, cuando = new Date(), nombre, lead }) {
  if (!activo()) return null;
  try {
    return await llamar('/api/matias/ingest', {
      method: 'POST',
      body: JSON.stringify({
        phone: String(numero).replace(/\D/g, ''),
        direction: de === 'lead' ? 'IN' : 'OUT',
        by: de === 'humano' ? 'human' : de,
        text: String(texto),
        externalMessageId: id || undefined,
        profileName: nombre || undefined,
        at: cuando.toISOString(),
        ...(lead?.id ? { zohoModule: 'Leads', zohoId: String(lead.id) } : {}),
      }),
    });
  } catch (e) {
    console.log(`portal no reflejó ${numero}: ${e.message}`);
    return null;
  }
}

/** ¿El hilo está en manos de una persona en el portal? Si el portal no contesta, no. */
export async function loTomoUnaPersona(numero) {
  if (!activo()) return false;
  try {
    const j = await llamar(`/api/matias/thread/${String(numero).replace(/\D/g, '')}`);
    return j.mode === 'human';
  } catch (e) {
    console.log(`portal no contestó el modo de ${numero}: ${e.message}`);
    return false;
  }
}
