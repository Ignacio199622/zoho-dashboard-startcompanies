/*
 * El reloj de "lo que queda colgado despues de una reunion". No hace el
 * trabajo: lo dispara. Cada hora a y 27, de 11 a 21 hora Argentina (14-24
 * UTC): las reuniones son de 9 a 18 y el reclamo del estado sale 2 h despues.
 * A y 27 para no pisar a los demas (en punto, y 2/12/22, y 3/8/13, y 5/20/35/50, y 45).
 */

const NOMBRE = 'reuniones-pendientes-background';

export default async (req) => {
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;
  try {
    const r = await fetch(destino, { method: 'POST' });
    const ok = r.status === 202;
    if (!ok) console.error(`el worker contesto ${r.status}, se esperaba 202`);
    return new Response(JSON.stringify({ disparado: ok, estado: r.status }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('no se pudo disparar reuniones-pendientes', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { schedule: '27 14-23 * * *' };
