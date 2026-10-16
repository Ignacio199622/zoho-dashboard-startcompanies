// DM de Slack para el semanal. Un webhook entrante solo escribe en SU canal:
// para mandarle un mensaje privado a una persona hace falta un bot token
// (xoxb, con chat:write e im:write): conversations.open abre el DM y
// chat.postMessage escribe.
//
// Sin SLACK_BOT_TOKEN_VIGIA no se manda nada (modo sombra).

// Lunes. La hora es UTC: Argentina es UTC-3 fijo.
export const DESTINOS = {
  12: { nombre: 'Pablo Gijón', slack: 'U0BTT434078' }, // 9:00 ART
  13: { nombre: 'Ignacio Campo', slack: 'U08LT8252Q3' }, // 10:00 ART
};

export const hayToken = () => Boolean(process.env.SLACK_BOT_TOKEN_VIGIA);

async function slack(metodo, cuerpo) {
  const r = await fetch(`https://slack.com/api/${metodo}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN_VIGIA}` },
    body: JSON.stringify(cuerpo),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Slack ${metodo}: ${j.error}`);
  return j;
}

/** Abre el DM con `usuario` (ID de Slack) y le manda `texto`. */
export async function mandarDm(usuario, texto) {
  const { channel } = await slack('conversations.open', { users: usuario });
  return slack('chat.postMessage', { channel: channel.id, text: texto, unfurl_links: false, unfurl_media: false });
}
