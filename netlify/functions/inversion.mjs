/*
 * Inversión en pauta, cargada a mano.
 *
 * El número que hace falta para decidir es el costo por SQL, no la integración
 * con Meta. Traerlo de la API significa que el tablero le pegue a la cuenta todo
 * el día, y eso es justo lo que no queremos. Se carga a mano una vez por mes y
 * queda guardado; si más adelante se automatiza, el resto del panel no cambia.
 *
 * Forma: { "2026-07": { "Meta Ads": 8000, "Google Ads": 500 }, ... }
 */
import { getStore } from '@netlify/blobs';
import auth from '../lib/auth.js';

const { cabeceras, exigirAuth } = auth;
const CLAVE = 'inversion';

function objetoDeHeaders(req) {
  const out = {};
  req.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return out;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

// Se guarda sólo lo que sea un número positivo: un campo vacío borra la entrada
// en vez de dejar un 0 que después se lee como "gastamos cero".
function limpiar(entrada) {
  const out = {};
  for (const [mes, canales] of Object.entries(entrada || {})) {
    if (!/^\d{4}-\d{2}$/.test(mes) || !canales || typeof canales !== 'object') continue;
    const limpio = {};
    for (const [canal, valor] of Object.entries(canales)) {
      const n = Number(valor);
      if (Number.isFinite(n) && n > 0) limpio[String(canal).slice(0, 60)] = Math.round(n * 100) / 100;
    }
    if (Object.keys(limpio).length) out[mes] = limpio;
  }
  return out;
}

export default async (req) => {
  const headers = objetoDeHeaders(req);
  const resp = cabeceras(headers);

  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: resp });

  const rechazo = exigirAuth(headers, resp, 'direccion');
  if (rechazo) return json(JSON.parse(rechazo.body), rechazo.statusCode, resp);

  // Lectura consistente: por defecto Blobs tarda unos segundos en devolver lo
  // recién guardado, y el usuario que recarga después de cargar la inversión
  // vería el tablero sin costos y pensaría que se perdió.
  const store = getStore({ name: 'inversion', consistency: 'strong' });

  try {
    if (req.method === 'GET') {
      const data = await store.get(CLAVE, { type: 'json' });
      return json(data || {}, 200, resp);
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const limpio = limpiar(body && body.inversion);
      await store.setJSON(CLAVE, limpio);
      return json(limpio, 200, resp);
    }

    return json({ error: 'Method not allowed' }, 405, resp);
  } catch (err) {
    return json({ error: err.message }, 500, resp);
  }
};
