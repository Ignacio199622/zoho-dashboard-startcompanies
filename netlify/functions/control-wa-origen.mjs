/*
 * Control de los leads que entran por WhatsApp.
 *
 * El 14-oct-2026 Zoho dejo de ponerle Fuente "WHATSAPP - Start Companies" al
 * lead nuevo y las dos reglas que colgaban de ese valor ("SC wa origen" y
 * "Tag primer mensaje - WA") dejaron de correr sin avisar. Durante 15 dias los
 * leads entraron sin anuncio ni landing, y los de Socios y Lili cayeron en
 * Captacion. Nadie se entero hasta que Ignacio miro la bandeja.
 *
 * Esto mira, cada hora, los leads creados entre hace 90 y hace 30 minutos que
 * tienen celular y no tienen mail ni calendario (o sea, nacieron de un chat).
 * Si alguno quedo con la Fuente vacia (no corrio SC wa origen) o con la
 * etiqueta "Captacion Temporal" (no corrio leadsWhatsapp y lo agarro el
 * comodin), avisa en el canal de fallas.
 */
import { env } from './lib/entorno.js';
import { get } from './lib/control-crm/zoho.js';
import { CANALES, avisarFalla } from './lib/aviso-falla.js';

const ZOHO_UI = 'https://crm.zoho.com/crm/org881745849/tab/Leads';
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');

async function postear(text) {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel: CANALES[0], text, unfurl_links: false }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
}

export default async () => {
  try {
    const hasta = new Date(Date.now() - 30 * 60e3);
    const desde = new Date(Date.now() - 90 * 60e3);
    const criterio = encodeURIComponent(`(Created_Time:between:${iso(desde)},${iso(hasta)})`);
    const j = await get(`Leads/search?criteria=${criterio}&fields=id,Full_Name,Mobile,Email,Calendario,Lead_Source,Tag,Idioma&per_page=200`);
    if (j._error) throw new Error(`Zoho: ${j._error} ${j._mensaje || ''}`);

    const deChat = (j.data || []).filter((l) => l.Mobile && !l.Email && !l.Calendario);
    // Brasil queda en "Captación Temporal" a propósito: Agendamiento manda en español y a los PT los
    // toma "BR Primer contato y retargeting". Para ellos solo cuenta la Fuente.
    const temporal = (l) => l.Idioma !== 'Português' && (l.Tag || []).some((t) => /^Captaci.n Temporal$/.test(t.name));
    const mal = deChat.filter((l) => !l.Lead_Source || temporal(l));
    if (!mal.length) return new Response(`ok: ${deChat.length} de chat, 0 sin rutear`);

    const lineas = mal.slice(0, 15).map((l) => {
      const que = [!l.Lead_Source && 'sin Fuente', temporal(l) && 'en Captación Temporal']
        .filter(Boolean).join(' y ');
      return `• <${ZOHO_UI}/${l.id}|${l.Full_Name || l.id}> (${l.Mobile}): ${que}`;
    });
    await postear([
      `:rotating_light: *${mal.length} de ${deChat.length} leads de WhatsApp de la última hora no pasaron por las reglas de origen*`,
      ...lineas,
      '_Mirar "SC wa origen" y "Tag primer mensaje - WA" en Zoho: si la Fuente ya no viene vacía ni como WHATSAPP, la integración cambió otra vez._',
    ].join('\n'));
    return new Response(`avisado: ${mal.length}`);
  } catch (e) {
    await avisarFalla('Control de leads de WhatsApp', e, 'Mirar netlify/functions/control-wa-origen.mjs y el token de Zoho');
    return new Response('fallo', { status: 500 });
  }
};

export const config = { schedule: '30 * * * *' };
