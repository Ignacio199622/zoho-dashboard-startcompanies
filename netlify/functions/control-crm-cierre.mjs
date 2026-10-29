/*
 * El reloj del cierre de Control CRM. No hace el trabajo: lo dispara.
 *
 * Cierra el dia: solo lo que se desvio hoy, con hora y media para arreglarlo.
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
const MODO = 'cierre';

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

/*
 * 16:30 de Argentina, LUNES A VIERNES. Argentina no cambia de hora, asi que
 * UTC-3 es fijo y el cron no se corre solo en marzo ni en octubre.
 *
 * Salia todos los dias hasta el 5-sep-2026. Ese sabado a las 16:30 el canal
 * recibio "se desviaron 89 cosas hoy, se pueden arreglar antes de irse" sin que
 * hubiera nadie trabajando: un mensaje urgente dirigido a una oficina vacia es
 * exactamente lo que hace que el equipo silencie el canal.
 *
 * No se pierde nada del fin de semana: la foto anterior (`ultima-foto`) la fija
 * SOLO el cierre, asi que el lunes compara contra la del viernes y reporta todo
 * lo que se acumulo. Por eso el mensaje dice "desde el viernes" y no "hoy".
 */
export const config = { schedule: '30 19 * * 1-5' };
