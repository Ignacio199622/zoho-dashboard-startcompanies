/*
 * El reloj del vigia SEMANAL: los lunes a las 12:00 y 13:00 UTC (9:00 y 10:00
 * Argentina). Una sola funcion para los dos envios: la background decide a
 * quien le toca segun la hora (ver lib/vigia/dm.js). La hora viaja en el
 * cuerpo para que un disparo que arranca a las 12:59 no se confunda.
 */
const NOMBRE = 'vigia-semanal-background';

export default async (req) => {
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;
  try {
    const r = await fetch(destino, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hora: new Date().getUTCHours() }),
    });
    const ok = r.status === 202;
    if (!ok) console.error(`el worker contesto ${r.status}, se esperaba 202`);
    return new Response(JSON.stringify({ disparado: ok, estado: r.status }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('no se pudo disparar el vigia semanal', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), { status: 500 });
  }
};

export const config = { schedule: '0 12,13 * * 1' };
