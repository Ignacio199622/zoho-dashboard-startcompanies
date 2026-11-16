// El reloj del candado de partners: todas las noches a las 03:17 AR (06:17 UTC). Dispara la background.
const NOMBRE = 'bloqueo-envio-background';
export default async (req) => {
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;
  try {
    const r = await fetch(destino, { method: 'POST' });
    return new Response(JSON.stringify({ disparado: r.status === 202, estado: r.status }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('no se pudo disparar bloqueo-envio', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), { status: 500 });
  }
};
export const config = { schedule: '17 6 * * *' };
