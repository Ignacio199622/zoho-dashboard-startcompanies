/*
 * El aviso del chat de la web a #chat-web, con memoria.
 *
 * Antes el Zobot de SalesIQ ("Ignacio", controlador de contexto) le pegaba
 * directo al webhook de Slack. Sin memoria, la misma persona que volvía a
 * entrar al flujo salía 5 veces (Juan Corti, 20/21-oct), y a un CLIENTE que
 * preguntaba por su saldo se le mandaba el link para agendar como a un lead.
 *
 * Ahora el bot le manda acá el MISMO cuerpo que le mandaba a Slack
 * ({"text": "..."}) y esto:
 *   1. Saca el WhatsApp del texto.
 *   2. Si ese número ya avisó en las últimas 24 h, no repite: suma una línea
 *      en el hilo del primer aviso (si alguien lo está atendiendo, lo ve ahí).
 *   3. Si el número ya es Contacto en Zoho, lo marca: es cliente, va a soporte.
 *
 * Nunca rompe el chat: el bot llama con su propio try, y si Slack o Zoho
 * fallan acá, igual se intenta publicar el aviso tal cual llegó.
 */
import { getStore } from '@netlify/blobs';
import { env } from './lib/entorno.js';
import { contactosConTelefono } from './lib/conversaciones/escritura.js';

const CANAL = env.SLACK_CANAL_CHAT_WEB || 'C0C04SKFC0J';
const VENTANA_MS = 24 * 3600 * 1000;
const ZOHO = 'https://crm.zoho.com/crm/org881745849/tab';

async function postear(cuerpo) {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel: CANAL, unfurl_links: false, ...cuerpo }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j;
}

/** El WhatsApp que el bot pone en el texto ("WhatsApp: +5491..."). */
export function telefonoDe(texto) {
  const m = String(texto || '').match(/WhatsApp:\s*(\+?\d[\d\s-]{6,})/i);
  return m ? m[1].replace(/[^\d+]/g, '') : null;
}

const responder = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export default async (req) => {
  if (req.method !== 'POST') return responder({ ok: false, error: 'solo POST' }, 405);
  let texto = '';
  try {
    const cuerpo = await req.json();
    texto = String(cuerpo?.text || '').slice(0, 3000);
  } catch {
    return responder({ ok: false, error: 'json invalido' }, 400);
  }
  // Solo los dos avisos que arma el bot; cualquier otra cosa se ignora, asi una
  // URL publica no se puede usar para postear lo que sea en el canal.
  if (!/chat de la web/i.test(texto)) return responder({ ok: false, error: 'no es un aviso del chat' }, 400);

  const tel = telefonoDe(texto);
  const store = getStore({ name: 'chat-web', consistency: 'strong' });

  try {
    if (tel) {
      const previo = await store.get(`tel-${tel}`, { type: 'json' });
      if (previo && Date.now() - previo.cuando < VENTANA_MS) {
        await postear({ thread_ts: previo.ts, text: `↩️ Volvió a escribir en el chat: ${texto}` });
        return responder({ ok: true, repetido: true });
      }
    }

    let extra = '';
    if (tel) {
      const contactos = await contactosConTelefono(tel).catch(() => []);
      if (contactos.length) {
        const c = contactos[0];
        extra = `\n:warning: *Ya es cliente* (<${ZOHO}/Contacts/${c.id}|${c.Full_Name || 'ver contacto'}>): no es un lead, va a soporte.`;
      }
    }

    const j = await postear({ text: texto + extra });
    if (tel) await store.setJSON(`tel-${tel}`, { cuando: Date.now(), ts: j.ts });
    return responder({ ok: true });
  } catch (e) {
    // Lo que no puede pasar es que el aviso se pierda: va tal cual llegó.
    try {
      await postear({ text: texto });
    } catch {}
    return responder({ ok: false, error: e.message }, 500);
  }
};

export const config = { path: '/chat-web-aviso' };
