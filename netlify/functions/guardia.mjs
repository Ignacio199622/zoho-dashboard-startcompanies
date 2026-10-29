/*
 * El reloj de la guardia. No hace el trabajo: lo dispara.
 *
 * El trabajo esta en guardia-background.mjs. No hay que esperar el resultado:
 * una background contesta 202 al toque y sigue sola.
 */

const NOMBRE = 'guardia-background';

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
    console.error('no se pudo disparar la guardia', e);
    return new Response(JSON.stringify({ disparado: false, error: String(e.message) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// Cada media hora, TODO el tiempo, y el codigo decide si corresponde hacer algo.
//
// Al reves que el agente de conversaciones, que tiene el cron acotado al
// horario de oficina: aca la ventana no se puede escribir en un cron porque
// incluye los feriados de Estados Unidos, que cambian de fecha todos los años.
// La corrida que cae en horario sale en una llamada y no cuesta nada.
//
// Cada 10 minutos, en los minutos que no usa ningun otro bot del sitio
// (0, 5, 15, 20, 30, 35, 45 y 50 estan tomados).
//
// Antes eran solo :10 y :40, y con los 15 minutos de gracia de los clientes eso
// dejaba un pozo: el que escribia a las 20:02 no llegaba a la corrida de las
// 20:10 (8 minutos de espera, menos que la gracia) y tenia que esperar hasta las
// 20:40. 38 minutos. Con seis corridas por hora la espera peor es 25 minutos.
//
// Correr mas seguido no cuesta: si estamos en horario, `correrGuardia` sale por
// `estaAbierto()` antes de pedirle un solo dato a Zoho.
export const config = { schedule: '2,12,22,32,42,52 * * * *' };
