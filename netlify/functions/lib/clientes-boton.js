// EL BOTON "¿PROBLEMA ESTUVO RESUELTO?" DE LA TARJETA DE CLIENTE.
//
// Lo atiende slack-interactividad.mjs (prefijo `cli_`). Slack corta a los 3
// segundos: un solo PUT a Zoho y un chat.update, sin releer.
// `value` del boton = "<eventoId>|<valor del picklist>".
import { escribirEvento } from './escribir.js';
import { api as slack } from './slack.js';

const VALORES = new Set(['Sí', 'No', 'Imposibilidad de reunión']);

const ok = (cuerpo = '') => new Response(cuerpo, { status: 200, headers: { 'Content-Type': 'application/json' } });
const efimero = (texto) => ok(JSON.stringify({ response_type: 'ephemeral', replace_original: false, text: texto }));

export async function manejarCliente(payload, accion) {
  const [eventoId, valor] = String(accion.value || '').split('|');
  if (!eventoId || !VALORES.has(valor)) return efimero('Ese botón no trae un valor válido.');

  const quien = payload.user?.id;
  const canal = payload.channel?.id;
  const ts = payload.message?.ts;

  await escribirEvento(eventoId, { Problema_estuvo_resuelto: valor });

  // La tarjeta: se deja el primer bloque (resumen) y se reemplazan los botones.
  const blocks = (payload.message?.blocks || []).filter((b) => b.type === 'section' && !/Problema estuvo resuelto/.test(b.text?.text || ''));
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `✅ *¿Problema estuvo resuelto?* ${valor}${quien ? ` · marcó <@${quien}>` : ''}` }] });
  if (canal && ts) await slack('chat.update', { channel: canal, ts, text: payload.message?.text || 'Reunión de cliente', blocks });
  return ok();
}
