/*
 * Precios de renovación, cargados a mano desde el panel.
 *
 * Por qué existe: el campo `Amount` del trato está cargado en el 83% de las
 * aperturas y en CERO de las 218 renovaciones. Con 194 renovaciones cobradas,
 * eso quiere decir que todo lo que el panel llamaba "facturación" era en
 * realidad el primer pago del cliente, y que el retorno de cada canal estaba
 * subestimado.
 *
 * El precio depende del estado de registro y de si la LLC es de un solo
 * miembro o de varios. Los dos datos SÍ están en el CRM y con buena cobertura:
 *   - `Estado_de_Registro` en la cuenta: 216 de 218 renovaciones
 *   - `Estructura_Societaria` en la cuenta o el trato: 193 de 194 cobradas
 * Así que no hace falta adivinar nada: alcanza con la tabla de precios.
 *
 * Se carga a mano y NO se escribe en Zoho a propósito. Escribir 194 importes
 * calculados dejaría en el CRM un número que parece cargado por una persona y
 * nadie se acordaría de que salió de una tabla. El día que alguien cargue el
 * `Amount` de verdad, ese gana: el panel usa el importe real cuando existe y
 * sólo estima cuando no.
 *
 * Forma: { "New Mexico": { "SM": 500, "MM": 600 }, "Delaware": { "SM": 900, "MM": 900 } }
 */
import { getStore } from '@netlify/blobs';
import auth from '../lib/auth.js';

const { cabeceras, exigirAuth } = auth;
const CLAVE = 'precios-renovacion';

function objetoDeHeaders(req) {
  const out = {};
  req.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return out;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

// Igual que en inversión: un campo vacío borra el precio en vez de guardar un 0,
// que después se leería como "esta renovación no se cobró".
function limpiar(entrada) {
  const out = {};
  for (const [estado, planes] of Object.entries(entrada || {})) {
    const e = String(estado).trim().slice(0, 60);
    if (!e || !planes || typeof planes !== 'object') continue;
    const limpio = {};
    for (const plan of ['SM', 'MM']) {
      const n = Number(planes[plan]);
      if (Number.isFinite(n) && n > 0) limpio[plan] = Math.round(n * 100) / 100;
    }
    if (Object.keys(limpio).length) out[e] = limpio;
  }
  return out;
}

export default async (req) => {
  const headers = objetoDeHeaders(req);
  const resp = cabeceras(headers);

  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: resp });

  const rechazo = exigirAuth(headers, resp);
  if (rechazo) return json(JSON.parse(rechazo.body), rechazo.statusCode, resp);

  const store = getStore({ name: 'precios', consistency: 'strong' });

  try {
    if (req.method === 'GET') {
      const data = await store.get(CLAVE, { type: 'json' });
      return json(data || {}, 200, resp);
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const limpio = limpiar(body && body.precios);
      await store.setJSON(CLAVE, limpio);
      return json(limpio, 200, resp);
    }

    return json({ error: 'Method not allowed' }, 405, resp);
  } catch (err) {
    return json({ error: err.message }, 500, resp);
  }
};
