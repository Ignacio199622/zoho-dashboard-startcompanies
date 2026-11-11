/*
 * VIGIA DE MENSAJES (11-nov-2026). Cada 15 minutos lee los WhatsApp que entraron
 * desde la corrida anterior (solo los que el ultimo en hablar fue el cliente) y:
 *
 *  1. Si escribe en PORTUGUES y su ficha tiene Idioma vacio -> Idioma = Português
 *     (trigger [] : no dispara reglas ni manda nada). Asi lo que le salga despues
 *     (cadencia, aviso de fuera de horario) va en portugues. Caso Will Oliveira.
 *  2. Si PIDE QUE NO LE ESCRIBAMOS (a mano: "sacame", "desativa", "stop"...) ->
 *     aviso en Slack con la ficha para que una persona lo frene. NO apaga solo:
 *     "quiero dar de baja mi LLC" no es una baja. El boton exacto lo apaga bajas.js.
 *
 * Una vez por mensaje (blob vigia-mensajes/vistos). Interruptor: VIGIA_MENSAJES=0.
 * Las decisiones (que es portugues, que es pedir salir) estan en
 * lib/conversaciones/vigia-mensajes.js y se prueban en scripts/test-vigia-mensajes.mjs.
 */
import { getStore } from '@netlify/blobs';
import { env } from './lib/entorno.js';
import { conversacionesDesde, fichas, token } from './lib/conversaciones/zoho.js';
import { escribeEnPortugues, pideSalir } from './lib/conversaciones/vigia-mensajes.js';
import { CANALES, avisarFalla } from './lib/aviso-falla.js';

const PT = 'Português';
const UI = 'https://crm.zoho.com/crm/org881745849/tab';
const MINUTOS = 40; // ventana de lectura: cubre una corrida caida sin repetir (los vistos se recuerdan)

async function postear(text) {
  if (!env.SLACK_BOT_TOKEN) return;
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel: CANALES[0], text, unfurl_links: false }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Slack: ${j.error}`);
}

async function ponerPortugues(modulo, id) {
  const r = await fetch(`https://www.zohoapis.com/crm/v6/${modulo}/${id}`, {
    method: 'PUT',
    headers: { Authorization: `Zoho-oauthtoken ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: [{ id, Idioma: PT }], trigger: [] }),
  });
  const j = await r.json().catch(() => ({}));
  return j.data?.[0]?.code || `http ${r.status}`;
}

export default async () => {
  if (env.VIGIA_MENSAJES === '0') return new Response('apagado');
  try {
    const store = getStore({ name: 'vigia-mensajes', consistency: 'strong' });
    const vistos = (await store.get('vistos', { type: 'json' })) || {};
    const ahora = Date.now();
    for (const [k, t] of Object.entries(vistos)) if (ahora - t > 3 * 86400e3) delete vistos[k];

    const conv = (await conversacionesDesde(new Date(ahora - MINUTOS * 60e3)))
      .filter((c) => c.conversation_status__s === 'Responded' && c.sender__s?.id)
      .filter((c) => !vistos[`${c.id}:${c.message_time__s}`]);

    const pt = conv.filter((c) => escribeEnPortugues(c.last_message__s));
    const salir = conv.filter((c) => pideSalir(c.last_message__s));
    const f = pt.length || salir.length ? await fichas([...pt, ...salir].map((c) => c.sender__s)) : {};
    const ficha = (c) => f[`${c.sender__s?.module?.api_name}:${c.sender__s?.id}`];
    const link = (c) => `<${UI}/${c.sender__s.module.api_name === 'Leads' ? 'Leads' : 'Contacts'}/${c.sender__s.id}|${ficha(c)?.Full_Name || c.sender__s.name || c.mobile_number__s}>`;

    const lineas = [];
    for (const c of pt) {
      const r = ficha(c);
      if (!r || r.Idioma) continue; // ya tiene idioma: no se pisa
      const code = await ponerPortugues(r.modulo, r.id);
      lineas.push(code === 'SUCCESS'
        ? `• :flag-br: ${link(c)} escribe en portugués y no tenía Idioma: le puse *Português*.`
        : `• :warning: ${link(c)} escribe en portugués pero NO pude ponerle Idioma (${code}): ponerlo a mano.`);
    }
    for (const c of salir) {
      const r = ficha(c);
      const dueno = r?.Owner?.name ? ` (de ${r.Owner.name})` : '';
      lineas.push(`• :no_entry: ${link(c)}${dueno} pide que no le escribamos: _"${String(c.last_message__s).trim().slice(0, 140)}"_ → frenarle la cadencia (Desactivar Retargeting) y contestarle.`);
    }

    for (const c of conv) vistos[`${c.id}:${c.message_time__s}`] = ahora;
    await store.setJSON('vistos', vistos);

    if (lineas.length) await postear([':eyes: *Vigía de mensajes*', ...lineas].join('\n'));
    return new Response(`ok: ${conv.length} mensajes, ${pt.length} portugues, ${salir.length} piden salir`);
  } catch (e) {
    await avisarFalla('Vigía de mensajes', e, 'Mirar netlify/functions/vigia-mensajes.mjs. Se apaga con VIGIA_MENSAJES=0.');
    return new Response('fallo', { status: 500 });
  }
};

export const config = { schedule: '7,22,37,52 * * * *' };
