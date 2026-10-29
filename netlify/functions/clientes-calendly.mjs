/*
 * El reloj de las reuniones de clientes (Calendly -> Zoho). No hace el trabajo:
 * lo dispara. Cada 5 minutos, a y 4/9/14/..., corrido un minuto de las
 * confirmaciones (3,8,13...) para no pedirle el token a Zoho a la vez.
 */

const NOMBRE = 'clientes-calendly-background';

export default async (req) => {
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;
  try {
    const r = await fetch(destino, { method: 'POST' });
    const ok = r.status === 202;
    if (!ok) console.error(`el worker contesto ${r.status}, se esperaba 202`);
    return new Response(JSON.stringify({ disparado: ok, estado: r.status }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('no se pudo disparar clientes-calendly', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config = { schedule: '4,9,14,19,24,29,34,39,44,49,54,59 * * * *' };
