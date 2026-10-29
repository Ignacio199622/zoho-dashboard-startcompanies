/*
 * El reloj del goteo de recuperacion. No hace el trabajo: lo dispara.
 */

const NOMBRE = 'recuperar-background';

export default async (req) => {
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;
  try {
    const r = await fetch(destino, { method: 'POST' });
    const ok = r.status === 202;
    if (!ok) console.error(`el worker contesto ${r.status}, se esperaba 202`);
    return new Response(JSON.stringify({ disparado: ok, estado: r.status }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('no se pudo disparar recuperar', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};

// Una vez por dia, 13:25 UTC = 10:25 en Argentina, de lunes a viernes.
//
// A la mañana y no a la tarde: el primer mensaje de la cadencia sale a los dos
// minutos, asi que conviene que caiga cuando queda toda la jornada por delante
// para que alguien conteste la respuesta. El codigo ademas chequea feriados,
// que el cron no puede expresar.
//
// A y 25 porque es un minuto que no usa ningun otro bot del sitio.
export const config = { schedule: '25 13 * * 1-5' };
