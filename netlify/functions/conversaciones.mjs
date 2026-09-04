/*
 * El reloj del agente de conversaciones. No hace el trabajo: lo dispara.
 *
 * El trabajo esta en conversaciones-background.mjs, y estan separados porque
 * cada pasada consulta a Gemini por cada conversacion nueva y puede tardar
 * minutos. Una funcion sincronica de Netlify se corta muchisimo antes.
 *
 * Ojo: no hay que esperar el resultado. Una background contesta 202 al toque y
 * sigue sola; quedarse esperando seria volver al mismo problema.
 */

const NOMBRE = 'conversaciones-background';

export default async (req) => {
  // La URL propia, para no cablear el dominio y que ande igual en previews.
  const destino = `${new URL(req.url).origin}/.netlify/functions/${NOMBRE}`;

  try {
    const r = await fetch(destino, { method: 'POST' });
    const ok = r.status === 202; // 202 = background aceptada
    if (!ok) console.error(`el worker contesto ${r.status}, se esperaba 202`);
    return new Response(JSON.stringify({ disparado: ok, estado: r.status }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('no se pudo disparar conversaciones', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// Cada hora a y 15, de 12 a 21 UTC = de 9 a 18 en Argentina, lunes a viernes.
// La ventana esta ademas en el codigo (estaAbierto), pero se acota tambien el
// cron para no gastar corridas de madrugada que lo unico que harian es salir.
// Argentina no cambia de hora, asi que UTC-3 es fijo todo el año.
//
// A y 15 para no pisar a nadie: agente-llamadas corre en punto y el Coach a y
// 30, y los tres comparten la cuota de Gemini. La primera corrida automatica
// del Coach murio con un 429 justamente por superponerse con otro agente.
export const config = { schedule: '15 12-21 * * 1-5' };
