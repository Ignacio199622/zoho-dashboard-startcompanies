// El reloj del reporte de Matias: 9:00 y 18:00 Argentina (12:00 y 21:00 UTC).
// Dispara la background: con el barrido el store pasó las 800 fichas y hay una
// relectura de Zoho por lead, ya no entra en el tiempo de una función normal
// (el 16-sep el de las 9:00 no salió, y el 15-sep salió dos veces por el reintento).
const NOMBRE = 'matias-reporte-background';
export default async (req) => {
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;
  try {
    const r = await fetch(destino, { method: 'POST' });
    return new Response(JSON.stringify({ disparado: r.status === 202, estado: r.status }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), { status: 500 });
  }
};
export const config = { schedule: '0 12,21 * * *' };
