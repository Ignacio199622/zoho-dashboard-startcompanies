/*
 * Control del idioma de los tratos nuevos (10-nov-2026).
 *
 * El blueprint de Zoho se elige UNA vez, al crear el trato: "Apertura LLC_PT"
 * si Idioma = Portugues, "Apertura LLC" (espanol) en cualquier otro caso,
 * incluido el vacio. Si el Idioma llega tarde, el trato queda en espanol para
 * siempre y Zoho no deja moverlo (RECORD_IN_BLUEPRINT). Asi les paso a Jorge
 * Moro (BBX) y Fernando (Brascast): recibieron los mensajes en espanol.
 *
 * Caminos por los que un trato nace sin el idioma bueno:
 *   - createDeals (Deluge) antes del arreglo de Tobias del 9-nov.
 *   - el PANEL: mapRequestToDeal crea el trato sin Idioma (api freezada, sin arreglar).
 *   - alguien del equipo que lo carga a mano.
 *   - ingles: no hay blueprint en ingles, todo English cae en el de espanol.
 *
 * Cada hora mira los tratos creados en las ultimas 26 h y avisa en #control-crm
 * si alguno quedo mal, ANTES de que avancen de etapa y le llegue el mensaje.
 * Arreglo: reiniciar el trato con crm/auditoria/_reiniciar_trato_pt.ps1.
 */
import { env } from './lib/entorno.js';
import { get } from './lib/control-crm/zoho.js';
import { CANALES, avisarFalla } from './lib/aviso-falla.js';

const ZOHO_UI = 'https://crm.zoho.com/crm/org881745849/tab/Potentials';
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
const PT = 'Português';

async function postear(text) {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel: CANALES[0], text, unfurl_links: false }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
}

/** Pura: dado el trato, el idioma del contacto y el blueprint, dice que esta mal (o null). */
export function problema(trato, idiomaContacto, blueprint) {
  const idioma = trato.Idioma || '';
  if (!idioma && idiomaContacto && idiomaContacto !== 'Español') {
    return `nació sin Idioma y el contacto es *${idiomaContacto}*`;
  }
  if (idioma === PT && blueprint && blueprint !== 'Apertura LLC_PT' && /^Apertura/.test(blueprint)) {
    return `es *Português* pero está en el blueprint "${blueprint}" (español)`;
  }
  if (idioma === 'English' && blueprint) {
    return `es *English* y no hay blueprint en inglés: le llega en español`;
  }
  return null;
}

export default async () => {
  try {
    const desde = new Date(Date.now() - 26 * 3600e3);
    const criterio = encodeURIComponent(`(Created_Time:greater_than:${iso(desde)})`);
    const j = await get(`Deals/search?criteria=${criterio}&fields=id,Deal_Name,Type,Stage,Idioma,Contact_Name,Created_Time&per_page=200`);
    if (j._error && j._error !== 'NO_CONTENT') throw new Error(`Zoho: ${j._error} ${j._mensaje || ''}`);
    // Los que siguen en la primera etapa hace menos de 20 min los reinicia solo
    // idioma-tratos-arreglar.mjs (cada 5 min): no se avisa de algo que se arregla solo.
    const reciente = (t) => t.Stage === 'Apertura Confirmada' && Date.now() - new Date(t.Created_Time) < 20 * 60e3;
    const tratos = (j.data || []).filter((t) => !/PRUEBA/i.test(t.Deal_Name || '') && !reciente(t));

    const mal = [];
    for (const t of tratos) {
      let idiomaContacto = '';
      if (!t.Idioma && t.Contact_Name?.id) {
        const c = await get(`Contacts/${t.Contact_Name.id}?fields=Idioma`);
        idiomaContacto = c.data?.[0]?.Idioma || '';
      }
      let bp = '';
      if (t.Idioma || idiomaContacto) {
        const b = await get(`Deals/${t.id}/actions/blueprint`);
        bp = b.blueprint?.process_info?.name || '';
      }
      const p = problema(t, idiomaContacto, bp);
      if (p) mal.push({ t, p });
    }
    if (!mal.length) return new Response(`ok: ${tratos.length} tratos nuevos, idioma bien`);

    await postear([
      `:rotating_light: *${mal.length} trato(s) nuevo(s) con el idioma mal: van a recibir los WhatsApp en español*`,
      ...mal.map(({ t, p }) => `• <${ZOHO_UI}/${t.id}|${t.Deal_Name}> (${t.Stage}): ${p}`),
      '_Si siguen en Apertura Confirmada, el agente los reinicia solo en 5 min. Si ya avanzaron: NO moverlos más y reiniciar a mano (crm/auditoria/_reiniciar_trato_pt.ps1)._',
    ].join('\n'));
    return new Response(`avisado: ${mal.length}`);
  } catch (e) {
    await avisarFalla('Control de idioma de tratos', e, 'Mirar netlify/functions/control-idioma-tratos.mjs');
    return new Response('fallo', { status: 500 });
  }
};

export const config = { schedule: '40 * * * *' };
