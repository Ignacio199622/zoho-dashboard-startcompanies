/*
 * La pantalla de llamar (public/llamar.html) habla con esto.
 *
 *   POST /api/llamar  x-clave: <LLAMAR_CLAVE>
 *     { accion: 'iniciar', numero, sdp, quien, lead }  → { id }
 *     { accion: 'estado', id }                          → { respuesta, estados, fin }
 *     { accion: 'cortar', id }                          → { ok }
 *
 * La clave es aparte (LLAMAR_CLAVE) porque viaja en el navegador de Daniel.
 */
import * as llamadas from './lib/llamadas.js';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

export default async (req) => {
  const clave = process.env.LLAMAR_CLAVE;
  if (req.method !== 'POST' || !clave || req.headers.get('x-clave') !== clave) return json({ error: 'no' }, 401);
  let b = {};
  try { b = await req.json(); } catch { return json({ error: 'cuerpo ilegible' }, 400); }
  try {
    if (b.accion === 'iniciar') return json({ id: await llamadas.iniciar(b) });
    if (b.accion === 'estado') return json((await llamadas.estado(b.id)) || {});
    if (b.accion === 'cortar') { await llamadas.cortar(b.id); return json({ ok: true }); }
    return json({ error: 'acción desconocida' }, 400);
  } catch (e) {
    const sinPermiso = e.codigo === 138006;
    return json({ error: sinPermiso ? 'El lead todavía no dio permiso para que lo llamemos.' : e.message, codigo: e.codigo || null }, sinPermiso ? 403 : 500);
  }
};

export const config = { path: '/api/llamar' };
