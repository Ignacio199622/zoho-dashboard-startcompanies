/*
 * El reloj del agente de tareas. No hace el trabajo: lo dispara.
 *
 * El trabajo esta en `agente-tareas-background.mjs`. Van separados porque una
 * funcion sincronica de Netlify se muere a los 60 segundos y analizar tres
 * reuniones con el modelo tarda mas que eso, sobre todo cuando Gemini contesta
 * 503 y entran los reintentos.
 *
 * Lo que pasa si se vuelven a juntar: del 2 al 5 de septiembre de 2026 el
 * agente quedo tres dias en bucle. Se pasaba de los 60s, lo mataban antes de
 * guardar que reuniones habia procesado, y a la hora siguiente arrancaba por
 * las mismas. Ni una tarea escrita en Notion en tres dias, y la bitacora
 * tampoco se escribia, asi que desde afuera parecia apagado.
 */

const NOMBRE = 'agente-tareas-background';

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
    console.error('no se pudo disparar agente-tareas', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// A los 20 de cada hora, para no pisarse con el agente de llamadas (en punto),
// canal-leads (y 15) y el coach (y 30): los cuatro comparten la cuota de Gemini.
export const config = { schedule: '20 * * * *' };
