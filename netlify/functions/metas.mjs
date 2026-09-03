/*
 * Metas mensuales, cargadas a mano desde el panel.
 *
 * Por qué existe: hasta ahora los KPIs eran números sueltos. 12 SQL puede ser
 * excelente o pésimo y el tablero no tenía forma de decirlo. Con una meta al
 * lado, cada número se pinta contra un objetivo en vez de flotar.
 *
 * Se guarda a mano por la misma razón que la inversión: el objetivo lo fija una
 * persona, no se deduce de los datos. Deducirlo de la propia serie (por ejemplo
 * "la meta es el promedio de los últimos 3 meses") sería inventar un número y
 * después medirse contra él, que es exactamente lo que este panel no hace.
 *
 * Forma:
 *   {
 *     "default": { "llcs": 12, "presentadas": 60, "costoCierre": 700, "cierre": 25, "noShow": 30 },
 *     "2026-08": { "llcs": 15 }
 *   }
 *
 * `default` aplica a todos los meses; una clave YYYY-MM pisa sólo los campos que
 * traiga. Así se fija el objetivo una vez y se ajusta el mes puntual que lo
 * merezca, sin tener que recargar los cinco valores cada mes.
 */
import { getStore } from '@netlify/blobs';
import auth from '../lib/auth.js';

const { cabeceras, exigirAuth } = auth;
const CLAVE = 'metas';

// Cada meta con su dirección: `mas` = cumplir es llegar o pasar (SQL, cierres);
// `menos` = cumplir es quedar por debajo (costo por SQL, no-show). Sin esto el
// semáforo pintaría de verde un costo por SQL altísimo.
const CAMPOS = {
  llcs: 'mas',
  presentadas: 'mas',
  cierre: 'mas',
  costoCierre: 'menos',
  noShow: 'menos'
};

function objetoDeHeaders(req) {
  const out = {};
  req.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return out;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

// Igual que en inversión: un campo vacío borra la meta en vez de guardar un 0,
// que después se leería como "la meta es cero" y daría verde siempre.
function limpiar(entrada) {
  const out = {};
  for (const [clave, metas] of Object.entries(entrada || {})) {
    if (clave !== 'default' && !/^\d{4}-\d{2}$/.test(clave)) continue;
    if (!metas || typeof metas !== 'object') continue;
    const limpio = {};
    for (const [campo, valor] of Object.entries(metas)) {
      if (!CAMPOS[campo]) continue;
      const n = Number(valor);
      if (Number.isFinite(n) && n > 0) limpio[campo] = Math.round(n * 100) / 100;
    }
    if (Object.keys(limpio).length) out[clave] = limpio;
  }
  return out;
}

export default async (req) => {
  const headers = objetoDeHeaders(req);
  const resp = cabeceras(headers);

  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: resp });

  const rechazo = exigirAuth(headers, resp, 'direccion');
  if (rechazo) return json(JSON.parse(rechazo.body), rechazo.statusCode, resp);

  // Consistencia fuerte: quien acaba de cargar la meta y recarga el panel tiene
  // que verla, no el estado anterior.
  const store = getStore({ name: 'metas', consistency: 'strong' });

  try {
    if (req.method === 'GET') {
      const data = await store.get(CLAVE, { type: 'json' });
      return json(data || {}, 200, resp);
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const limpio = limpiar(body && body.metas);
      await store.setJSON(CLAVE, limpio);
      return json(limpio, 200, resp);
    }

    return json({ error: 'Method not allowed' }, 405, resp);
  } catch (err) {
    return json({ error: err.message }, 500, resp);
  }
};
