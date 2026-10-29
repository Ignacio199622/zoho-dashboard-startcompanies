// El reloj del aviso diario a Santiago: 9:25 Argentina (12:25 UTC), de lunes a viernes.
// Va después del reporte de las 9:00 para no pisarlo, y dispara la background porque
// la pasada recorre las ~800 fichas y no entra en el tiempo de una función normal.
const NOMBRE = 'matias-intervenir-background';
export default async (req) => {
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;
  try {
    const r = await fetch(destino, { method: 'POST' });
    return new Response(JSON.stringify({ disparado: r.status === 202, estado: r.status }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('no se pudo disparar matias-intervenir', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), { status: 500 });
  }
};
export const config = { schedule: '25 12 * * 1-5' };
