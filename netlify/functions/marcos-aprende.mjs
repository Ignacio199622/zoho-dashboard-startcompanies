// El reloj de "Marcos aprende": lunes 10:00 de Argentina (13:00 UTC).
// Ignacio (18-sep): "1 vez a la semana y los lunes".
// Dispara la background porque la pasada resuelve numeros contra Zoho en
// serie y le pide al modelo un JSON largo: no entra en los 10 s de una
// funcion normal. Ver lib/marcos-aprende.js.
const NOMBRE = 'marcos-aprende-background';
export default async (req) => {
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;
  try {
    const r = await fetch(destino, { method: 'POST' });
    return new Response(JSON.stringify({ disparado: r.status === 202, estado: r.status }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), { status: 500 });
  }
};
export const config = { schedule: '0 13 * * 1' };
