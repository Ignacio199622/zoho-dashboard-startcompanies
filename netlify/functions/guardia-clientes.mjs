/*
 * El reloj del guardia de clientes en cadencia. No hace el trabajo: lo dispara.
 * El trabajo esta en `guardia-clientes-background` (ver `lib/conversaciones/guardia-clientes.js`).
 */

const NOMBRE = 'guardia-clientes-background';

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
    console.error('no se pudo disparar guardia-clientes', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// Cada hora, todo el dia: las cadencias de Zoho no tienen ventana horaria. A y 40
// para no pisar a los otros agentes (en punto, 5/20/35/50, a y 15 y a y 30).
export const config = { schedule: '40 * * * *' };
