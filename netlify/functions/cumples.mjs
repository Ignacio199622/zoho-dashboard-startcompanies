/*
 * Cumpleaños y feriados de Estados Unidos, avisados a la Cupula el dia antes.
 *
 * Pedido de Ignacio (16-sep-2026): un aviso en Slack un dia antes de cada
 * cumpleaños del equipo, y si cae lunes, el viernes. Lo mismo con los feriados
 * de Estados Unidos. Es lo unico que hace.
 *
 * Toda la regla (que dias cubre, la lista, los feriados) esta en
 * lib/cumples.js, sin red, para poder probarla con cualquier fecha. Aca solo
 * esta el reloj y el envio.
 *
 * Va con bot token (`chat.postMessage`), como el resto: la app "Avisos SC -
 * ALERTAS" no tiene `channels:join`, asi que hay que invitarla al canal a
 * mano (/invite @Avisos SC - ALERTAS). Si no esta, Slack contesta
 * `not_in_channel`, se avisa en #control-crm y se ve en los logs.
 *
 * A mano: `?sombra=1&fecha=2026-11-13` devuelve lo que mandaria ese dia sin
 * mandarlo. OJO: en produccion la URL contesta 403 (Netlify solo deja que el
 * reloj invoque una funcion con `schedule`), asi que la prueba es local:
 * `netlify dev` y GET a localhost, o directamente lib/cumples.js con node.
 */
import { env } from './lib/entorno.js';
import { avisosDeHoy, armarMensaje, hoyArgentina } from './lib/cumples.js';
import { avisarFalla } from './lib/aviso-falla.js';

// #start-companies-cupula es privado: se usa el id (verificado el 16-sep-2026
// con chat.scheduleMessage + delete, sin postear nada) porque el nombre de un
// canal privado no siempre resuelve para un bot.
const CANAL = env.SLACK_CANAL_CUMPLES || 'C0AJYS77KL5';
const FIRMA = { username: 'Cumples y feriados · Start Companies', icon_emoji: ':birthday:' };

async function postear(cuerpo) {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(cuerpo),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j;
}

// Sin `chat:write.customize` la firma se rechaza; se reintenta sin ella.
async function mandar(cuerpo) {
  try {
    return await postear({ channel: CANAL, ...FIRMA, ...cuerpo });
  } catch (e) {
    if (!/not_allowed_token_type|invalid_arguments/.test(e.message)) throw e;
    return await postear({ channel: CANAL, ...cuerpo });
  }
}

const responder = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

export default async (req) => {
  const url = new URL(req.url);
  const sombra = url.searchParams.get('sombra') === '1';
  const fechaParam = url.searchParams.get('fecha'); // YYYY-MM-DD, solo para probar
  const hoy = fechaParam ? new Date(`${fechaParam}T00:00:00Z`) : hoyArgentina();
  if (Number.isNaN(hoy.getTime())) return responder({ error: 'fecha invalida, va YYYY-MM-DD' }, 400);

  const avisos = avisosDeHoy(hoy);
  const mensaje = armarMensaje(avisos);
  const base = { hoy: hoy.toISOString().slice(0, 10), canal: CANAL, avisos };

  if (!mensaje) return responder({ ...base, mandado: false, motivo: 'nada que avisar' });
  if (sombra) return responder({ ...base, mandado: false, sombra: true, mensaje: mensaje.text });
  if (!env.SLACK_BOT_TOKEN) return responder({ ...base, mandado: false, motivo: 'sin SLACK_BOT_TOKEN' }, 500);

  try {
    const j = await mandar(mensaje);
    console.log(`cumples: avisado en ${CANAL}`, mensaje.text);
    return responder({ ...base, mandado: true, ts: j.ts });
  } catch (e) {
    await avisarFalla('Cumples y feriados', e, `no pudo postear en ${CANAL}; si dice not_in_channel hay que invitar a la app al canal`);
    return responder({ ...base, mandado: false, error: e.message }, 500);
  }
};

/*
 * 9:10 de Argentina, lunes a viernes (UTC-3 fijo, Argentina no cambia de
 * hora). Los 10 minutos son para no salir en el mismo segundo que el arranque
 * de Control CRM (9:00).
 *
 * No corre sabados ni domingos porque el viernes ya cubre hasta el lunes.
 */
export const config = { schedule: '10 12 * * 1-5' };
