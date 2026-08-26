/*
 * Datos del agente de llamadas para el dashboard.
 *
 * Solo lee de Blobs: no llama a Fathom, Zoho ni Gemini, asi que responde rapido
 * y no gasta cuota de ninguna API. Quien produce estos datos es la funcion
 * programada agente-llamadas.
 *
 * Formato v2 (export default) porque el contexto de Blobs solo se inyecta en el
 * runtime moderno, y auth compartida con el resto del dashboard.
 */
import { getStore } from '@netlify/blobs';
import auth from '../lib/auth.js';

const { cabeceras, exigirAuth } = auth;

function objetoDeHeaders(req) {
  const out = {};
  req.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return out;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

/** Lo que hay que mirar, resuelto en el servidor: el dashboard solo pinta. */
function revisar(corridas) {
  const problemas = [];
  const ultima = corridas[0];
  if (!ultima) return { problemas: ['el agente todavia no corrio'], ultima: null };

  const horas = (Date.now() - new Date(ultima.fin).getTime()) / 3600000;
  if (ultima.estado === 'fallo') problemas.push('la ultima corrida fallo entera');
  else if (ultima.estado === 'parcial') problemas.push(`la ultima corrida tuvo ${ultima.errores.length} errores`);
  if (horas > 26) problemas.push(`hace ${Math.round(horas)} horas que no corre`);

  // Un error que se repite no es un tropiezo: es algo roto.
  const repetidos = {};
  for (const c of corridas.slice(0, 5)) {
    for (const e of c.errores || []) {
      const k = String(e.mensaje).slice(0, 60);
      repetidos[k] = (repetidos[k] || 0) + 1;
    }
  }
  for (const [m, n] of Object.entries(repetidos)) {
    if (n >= 3) problemas.push(`error repetido ${n} veces: ${m}`);
  }
  return { problemas, ultima };
}

export default async (req) => {
  const headers = objetoDeHeaders(req);
  const resp = cabeceras(headers);

  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: resp });

  const rechazo = exigirAuth(headers, resp);
  if (rechazo) return json(JSON.parse(rechazo.body), rechazo.statusCode, resp);

  try {
    const store = getStore({ name: 'agente-llamadas', consistency: 'strong' });
    const [pendientes, objeciones, bitacora] = await Promise.all([
      store.get('pendientes', { type: 'json' }),
      store.get('objeciones', { type: 'json' }),
      store.get('bitacora', { type: 'json' }),
    ]);

    const corridas = bitacora || [];
    const { problemas, ultima } = revisar(corridas);

    return json(
      {
        actualizado: ultima?.fin || null,
        estado: problemas.length ? 'atencion' : 'ok',
        problemas,
        pendientes: pendientes || [],
        objeciones: objeciones || null,
        corridas: corridas.slice(0, 20).map((c) => ({
          cuando: c.fin,
          disparador: c.disparador,
          estado: c.estado,
          procesadas: c.procesadas,
          escritas: c.escritas,
          segundos: c.segundos,
          errores: (c.errores || []).map((e) => ({ donde: e.donde, mensaje: e.mensaje, contexto: e.contexto })),
          avisos: (c.avisos || []).map((a) => a.texto),
        })),
      },
      200,
      resp
    );
  } catch (e) {
    return json({ error: 'no se pudieron leer los datos', detalle: String(e.message).slice(0, 200) }, 500, resp);
  }
};
