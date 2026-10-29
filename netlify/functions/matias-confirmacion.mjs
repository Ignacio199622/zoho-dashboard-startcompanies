// El reloj de la confirmacion de Matias: cada 10 minutos (12-oct-2026, antes cada 30).
// A y 6/16/26... para no pisar a guardia ni a bajas.
const NOMBRE = 'matias-confirmacion-background';
export default async (req) => {
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;
  try {
    const r = await fetch(destino, { method: 'POST' });
    return new Response(JSON.stringify({ disparado: r.status === 202, estado: r.status }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), { status: 500 });
  }
};
export const config = { schedule: '6,16,26,36,46,56 * * * *' };
