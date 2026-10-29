// El reloj de la apertura de Matias: cada 15 minutos dispara la background.
// A y 7/22/37/52 para no pisar a los otros agentes (en punto, y 5, y 15, y 30).
const NOMBRE = 'matias-apertura-background';
export default async (req) => {
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;
  try {
    const r = await fetch(destino, { method: 'POST' });
    return new Response(JSON.stringify({ disparado: r.status === 202, estado: r.status }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('no se pudo disparar matias-apertura', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), { status: 500 });
  }
};
export const config = { schedule: '7,22,37,52 * * * *' };
