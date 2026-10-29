/*
 * El reloj del agente post-reunión. No hace el trabajo: lo dispara.
 *
 * Mismo patrón que bajas.mjs: las funciones programadas no pueden ser
 * -background, y el worker sí lo es para no pelear con los 60 segundos (por
 * cada lead candidato se leen hasta tres cosas de Zoho).
 */

const NOMBRE = 'post-reunion-background';

export default async (req) => {
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;
  try {
    const r = await fetch(destino, { method: 'POST' });
    const ok = r.status === 202; // 202 = background aceptada
    if (!ok) console.error(`el worker contesto ${r.status}, se esperaba 202`);
    return new Response(JSON.stringify({ disparado: ok, estado: r.status }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('no se pudo disparar post-reunion', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// Una vez por dia, 13:00 UTC = 10:00 de Argentina. A esa hora el equipo ya esta
// y la cadencia que arranca no le escribe a nadie de madrugada.
export const config = { schedule: '0 13 * * *' };
