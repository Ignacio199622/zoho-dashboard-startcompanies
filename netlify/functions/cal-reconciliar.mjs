// El reloj del reconciliador Cal → Zoho: cada 15 minutos, a y 4/19/34/49 para no
// pisar a los otros agentes. Dispara la background.
const NOMBRE = 'cal-reconciliar-background';
export default async (req) => {
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;
  try {
    const r = await fetch(destino, { method: 'POST' });
    return new Response(JSON.stringify({ disparado: r.status === 202, estado: r.status }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('no se pudo disparar cal-reconciliar', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), { status: 500 });
  }
};
export const config = { schedule: '4,19,34,49 * * * *' };
