/*
 * El reloj del arranque de Control CRM. No hace el trabajo: lo dispara.
 *
 * Abre el dia: reparte por persona lo que le toca a cada uno.
 *
 * El trabajo esta en control-crm-background.mjs, y estan separados porque la
 * corrida baja ~16.000 registros de Zoho y tarda minutos. Una funcion
 * sincronica de Netlify se corta muchisimo antes; una -background puede tardar
 * lo que necesite.
 *
 * Ojo: no hay que esperar el resultado. Una background contesta 202 al toque y
 * sigue sola; quedarse esperando seria volver al mismo problema.
 */

const NOMBRE = 'control-crm-background';
const MODO = 'arranque';

export default async (req) => {
  // La URL propia, para no cablear el dominio y que ande igual en previews.
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;

  try {
    const r = await fetch(destino, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modo: MODO }),
    });
    const ok = r.status === 202; // 202 = background aceptada
    if (!ok) console.error(`el worker contesto ${r.status}, se esperaba 202`);
    return new Response(JSON.stringify({ disparado: ok, modo: MODO, estado: r.status }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('no se pudo disparar control-crm', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// 09:00 de Argentina, lunes a viernes. Argentina no cambia de hora, asi que UTC-3 es fijo y el cron no se
// corre solo en marzo ni en octubre.
export const config = { schedule: '0 12 * * 1-5' };
