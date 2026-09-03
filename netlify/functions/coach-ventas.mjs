/*
 * El reloj del Coach de Ventas SC. No hace el trabajo: lo dispara.
 *
 * El trabajo esta en coach-ventas-background.mjs, y estan separados por una
 * razon concreta: analizar UNA llamada son dos consultas al modelo, unos 80
 * segundos, y una funcion sincronica de Netlify se corta muchisimo antes.
 *
 * Como se descubrio (3-sep-2026): la corrida de las 18:30 publico su tarjeta en
 * Slack y la mataron antes de llegar a guardar `coach-publicadas`, la lista que
 * evita repetir. El sintoma no era un error, era que a la hora siguiente el
 * canal recibia otra vez la MISMA llamada. Una funcion -background puede tardar
 * lo que necesite.
 *
 * Ojo: no hay que esperar el resultado del trabajo. Una background contesta 202
 * al toque y sigue sola; quedarse esperando seria volver al mismo problema.
 */

const NOMBRE = 'coach-ventas-background';

export default async (req) => {
  // La URL propia, para no cablear el dominio y que ande igual en previews.
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;

  try {
    const r = await fetch(destino, { method: 'POST' });
    const ok = r.status === 202; // 202 = background aceptada
    if (!ok) console.error(`el worker contesto ${r.status}, se esperaba 202`);
    return new Response(
      JSON.stringify({ disparado: ok, estado: r.status, cuando: new Date().toISOString() }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('no se pudo disparar el coach', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// A y media: agente-llamadas.mjs corre en punto y le pide a Fathom lo mismo.
// La primera corrida automatica murio con un 429 justamente por pisarse.
export const config = { schedule: '30 * * * *' };
