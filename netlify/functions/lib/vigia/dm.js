// DM de Slack para el vigia (diario y semanal). Un webhook entrante solo
// escribe en SU canal; para escribirle en privado a una persona hace falta el
// bot token. Con `chat:write` alcanza: chat.postMessage con channel=<ID de
// usuario> le manda el mensaje en el DM de la app, sin conversations.open ni
// im:write.
//
// Usa SLACK_BOT_TOKEN_VIGIA si existe y si no el SLACK_BOT_TOKEN que ya tienen
// los otros agentes. Sin ninguno de los dos no se manda nada (modo sombra).

// El diario: a Ignacio, salvo que VIGIA_DIARIO_A diga otro ID.
export const diarioA = () => process.env.VIGIA_DIARIO_A || 'U0869LQ3G4C';

// El semanal, los lunes. La hora es UTC: Argentina es UTC-3 fijo.
export const DESTINOS = {
  12: { nombre: 'Pablo Gijón', slack: 'U0BTT434078' }, // 9:00 ART
  13: { nombre: 'Ignacio Campo', slack: 'U08LT8252Q3' }, // 10:00 ART
};

const botToken = () => process.env.SLACK_BOT_TOKEN_VIGIA || process.env.SLACK_BOT_TOKEN;
export const hayToken = () => Boolean(botToken());

/** Le manda `texto` por DM a `usuario` (ID de Slack). */
export async function mandarDm(usuario, texto) {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${botToken()}` },
    body: JSON.stringify({ channel: usuario, text: texto, unfurl_links: false, unfurl_media: false }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Slack chat.postMessage: ${j.error}`);
  return j;
}
