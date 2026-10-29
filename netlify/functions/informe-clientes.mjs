/*
 * El reloj del informe semanal de llamadas de clientes. Lunes 09:00 ART
 * (12:00 UTC), sobre la semana que termino el domingo. No hace el trabajo:
 * dispara a `informe-clientes-background`, como todos los agentes de este sitio.
 */

const NOMBRE = 'informe-clientes-background';

export default async (req) => {
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;
  try {
    const r = await fetch(destino, { method: 'POST' });
    const ok = r.status === 202;
    if (!ok) console.error(`el worker contesto ${r.status}, se esperaba 202`);
    return new Response(JSON.stringify({ disparado: ok, estado: r.status }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('no se pudo disparar informe-clientes', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config = { schedule: '0 12 * * 1' };
