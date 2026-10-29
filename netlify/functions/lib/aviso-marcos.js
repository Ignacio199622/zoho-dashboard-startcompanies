/*
 * EL AVISO AL EQUIPO. Marcos ya contesto: que nadie escriba encima.
 *
 * Sin esto, la unica forma de enterarse es abrir el hilo en Zoho y mirar el
 * detalle. Zoho marca la conversacion como "Responded" pero deja `replied_by`
 * vacio, asi que en la bandeja parece contestada sin que se vea por quien. Si
 * Santiago o Camila abren ese chat y contestan igual, el cliente recibe dos
 * respuestas a lo mismo.
 *
 * Va con bot token (`chat.postMessage`), como el Coach: en este workspace los
 * webhooks entrantes no estan configurados para este sitio.
 *
 * ─── NUNCA ROMPE LA RESPUESTA ──────────────────────────────────────────────
 *
 * Si Slack falla, el WhatsApp al cliente YA salio. Volver a intentar o tirar el
 * error solo lograria que la corrida se caiga despues de haber mandado. Por eso
 * todo esto devuelve el motivo y sigue.
 */
import { env } from './entorno.js';

const ZOHO_UI = 'https://crm.zoho.com/crm/org881745849/tab';

// Donde va el aviso, en orden de preferencia. El primero es donde corresponde:
// #control-crm es el canal que el equipo ya mira para las cosas del CRM. El
// segundo es el paracaidas.
//
// La app de Slack no tiene el scope `channels:join`, asi que no puede meterse
// sola en un canal: si nadie la invito a #control-crm, Slack contesta
// `not_in_channel`. Sin paracaidas, la funcion quedaria posteando al vacio y
// nadie se enteraria; el equipo creeria que Marcos no contesto nunca.
export const CANALES = [
  env.SLACK_CANAL_MARCOS || '#control-crm',
  env.SLACK_CANAL,
].filter(Boolean);
export const CANAL = CANALES[0];
export const HAY_SLACK = Boolean(env.SLACK_BOT_TOKEN);

const corta = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));
const cita = (t, n) => corta(t, n).split('\n').join('\n> ');

/** El mensaje, armado aparte para poder verlo en modo sombra sin mandarlo. */
export function armar({ quien, contacto, numero, pregunta, entrada, texto }) {
  const link = contacto ? `${ZOHO_UI}/Contacts/${contacto}` : null;
  const nombre = quien || numero || 'Sin nombre';

  const partes = [
    `🤖 *Marcos ya contestó a ${nombre}*${link ? ` · <${link}|abrir en Zoho>` : ''}`,
    `*Preguntó:*\n> ${cita(pregunta, 300)}`,
    `*Le respondió* _(${entrada})_:\n> ${cita(texto, 900)}`,
    '_No hace falta contestar de nuevo. Si la respuesta quedó corta o mal, escribile vos y avisá para corregir la entrada._',
  ];

  return {
    text: `🤖 Marcos contestó a ${nombre}`,
    blocks: partes.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: corta(t, 2900) } })),
    unfurl_links: false,
  };
}

// La app de Slack es compartida ("Avisos SC - ALERTAS"), asi que se firma para
// que en el canal se distinga del Coach. El scope `chat:write.customize` puede
// no estar: si Slack lo rechaza, se reintenta sin firma antes de darse por
// vencido, igual que en `lib/slack.js`.
const FIRMA = { username: 'Marcos · Start Companies', icon_emoji: ':robot_face:' };

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

async function aUnCanal(canal, cuerpo) {
  try {
    await postear({ channel: canal, ...FIRMA, ...cuerpo });
  } catch (e) {
    // Sin `chat:write.customize` la firma se rechaza. Peor nombre, pero sale.
    if (!/not_allowed_token_type|invalid_arguments/.test(e.message)) throw e;
    await postear({ channel: canal, ...cuerpo });
  }
}

/**
 * Avisa que salio una respuesta automatica.
 *
 * @returns {Promise<{avisado: boolean, motivo?: string}>} nunca tira
 */
export async function avisar(fila) {
  const cuerpo = armar(fila);
  if (!HAY_SLACK) return { avisado: false, motivo: 'sin SLACK_BOT_TOKEN' };

  let ultimo = 'sin canales configurados';
  for (const canal of CANALES) {
    try {
      await aUnCanal(canal, cuerpo);
      return { avisado: true, canal, deRebote: canal !== CANAL };
    } catch (e) {
      ultimo = `${canal}: ${e.message}`;
      // Solo se prueba el siguiente si el problema es de ESE canal. Un token
      // vencido va a fallar igual en todos y no tiene sentido insistir.
      if (!/not_in_channel|channel_not_found|is_archived/.test(e.message)) break;
    }
  }
  return { avisado: false, motivo: ultimo };
}
