/*
 * LLAMADAS DE WHATSAPP DE DANIEL (la persona), desde el +52.
 *
 * Pedido de Ignacio (29-oct): el SDR es híbrido. El bot escribe por el 863 y,
 * al que no agenda, lo llama Daniel en persona por WhatsApp. El 863 es +1 y
 * Meta no deja que un número de Estados Unidos o Canadá llame; el +52 (México)
 * sí, y tiene la Calling API prendida desde el 14-sep.
 *
 * Cómo anda una llamada (Calling API de Meta, WebRTC):
 *   1. El navegador de Daniel arma la oferta SDP (micrófono) y la manda acá.
 *   2. `iniciar` la pasa a Meta: POST /{+52}/calls action=connect.
 *   3. Meta contesta por el webhook (campo `calls`, evento `connect`) con la
 *      respuesta SDP. El webhook la guarda con `guardarEventos`.
 *   4. El navegador la lee con `estado` y el audio queda conectado.
 *   5. Los estados (RINGING, ACCEPTED, REJECTED) y el `terminate` con la
 *      duración también quedan en el blob de la llamada.
 *
 * Sin permiso del lead Meta devuelve 138006: hay que pedírselo antes.
 */
import { getStore } from '@netlify/blobs';

const env = process.env;
export const LINEA_LLAMADAS = env.LLAMADAS_LINEA || '884134968121128'; // el +52
const GRAPH = 'https://graph.facebook.com/v23.0';

const almacen = () => getStore('llamadas');
const claveDe = (id) => `llamada-${String(id).replace(/[^\w.-]/g, '_')}`;

async function graph(ruta, cuerpo) {
  const r = await fetch(`${GRAPH}/${ruta}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.META_WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...cuerpo }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    const err = new Error(e.error_user_msg || e.message || `Meta ${r.status}`);
    err.codigo = e.code;
    throw err;
  }
  return j;
}

/** Empieza la llamada. Devuelve el id de Meta (wacid…). */
export async function iniciar({ numero, sdp, quien = '', lead = '' }) {
  const to = String(numero || '').replace(/\D/g, '');
  if (!to || !sdp) throw new Error('falta número u oferta');
  const j = await graph(`${LINEA_LLAMADAS}/calls`, {
    to, action: 'connect',
    session: { sdp_type: 'offer', sdp },
    biz_opaque_callback_data: JSON.stringify({ quien, lead }).slice(0, 500),
  });
  const id = j.calls?.[0]?.id;
  if (!id) throw new Error('Meta no devolvió id de llamada');
  await almacen().setJSON(claveDe(id), { id, numero: to, quien, lead, iniciada: new Date().toISOString(), estados: [] });
  return id;
}

/** Corta la llamada (Meta pide hacerlo aunque el audio ya se haya cortado). */
export async function cortar(id) {
  return graph(`${LINEA_LLAMADAS}/calls`, { call_id: id, action: 'terminate' });
}

/** Lo que se sabe de la llamada: respuesta SDP, estados y cierre. */
export async function estado(id) {
  return (await almacen().get(claveDe(id), { type: 'json' }).catch(() => null)) || null;
}

/** Saca del webhook todo lo que es de llamadas (campo `calls`). */
export function eventosDeLlamadas(cuerpo) {
  const out = [];
  for (const entrada of cuerpo?.entry || []) {
    for (const cambio of entrada.changes || []) {
      if (cambio.field !== 'calls') continue;
      const v = cambio.value || {};
      for (const c of v.calls || []) out.push({ tipo: 'call', ...c });
      for (const s of v.statuses || []) if (s.type === 'call') out.push({ tipo: 'status', ...s });
    }
  }
  return out;
}

/** Guarda cada evento en el blob de su llamada. */
export async function guardarEventos(eventos) {
  const store = almacen();
  for (const ev of eventos) {
    const k = claveDe(ev.id);
    const actual = (await store.get(k, { type: 'json' }).catch(() => null)) || { id: ev.id, estados: [] };
    const cuando = ev.timestamp ? new Date(Number(ev.timestamp) * 1000).toISOString() : new Date().toISOString();
    if (ev.tipo === 'status') {
      actual.estados.push({ estado: ev.status, cuando });
    } else if (ev.event === 'connect') {
      if (ev.session?.sdp_type === 'answer') actual.respuesta = ev.session.sdp;
      actual.estados.push({ estado: 'CONNECT', cuando });
    } else if (ev.event === 'terminate') {
      actual.fin = {
        estado: Array.isArray(ev.status) ? ev.status.join('/') : ev.status,
        duracion: ev.duration || 0,
        inicio: ev.start_time || null,
        error: ev.errors?.[0] ? `${ev.errors[0].code} ${ev.errors[0].message || ''}`.trim() : null,
        cuando,
      };
    }
    await store.setJSON(k, actual);
  }
}
