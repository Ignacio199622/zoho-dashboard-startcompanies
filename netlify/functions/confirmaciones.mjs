/*
 * El reloj de las confirmaciones de reunion. No hace el trabajo: lo dispara.
 *
 * Cada 5 minutos, todo el dia, todos los dias. Tiene que ser seguido porque el
 * CRM guarda solo el ultimo mensaje de cada conversacion: si el equipo o un
 * bot le contesta al cliente antes de que esto lea su "Si", el "Si" se pierde.
 *
 * A y 3/8/13/... para no pisar a la guardia (2,12,22...), a bajas (5,20,35,50)
 * ni a los que corren en punto y a y cuarto.
 */

const NOMBRE = 'confirmaciones-background';

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
    console.error('no se pudo disparar confirmaciones', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { schedule: '3,8,13,18,23,28,33,38,43,48,53,58 * * * *' };
