// LA LLAMADA DE UN CLIENTE (agendaclientes / Calendly), DESPUES DE FATHOM.
//
// Lo que pidio Ignacio (14-sep-2026) para la reunion de cliente en Zoho:
//   - "el Fathom pone la descrip": el resumen de la llamada va a la reunion y
//     como nota en el Contacto;
//   - "¿Por quien fue abordado?": quien atendio, si la llamada lo dice;
//   - "¿Problema estuvo resuelto?" (Si / No / Imposibilidad de reunion): se le
//     PREGUNTA al responsable en Slack, con botones. Eso lo contesta una persona,
//     nunca el modelo. El boton lo atiende `slack-interactividad.mjs` (prefijo
//     `cli_`).
//   - Asistio: si el cliente participo, `Status del Meet = Asistio`.
//
// La reunion la creo el agente clientes-calendly, colgada del Contacto y con
// Tipo = Clientes, asi que aca se la busca por el Contacto (mail de la llamada)
// y la hora. Todo se escribe con trigger vacio: la reunion no esta en ningun
// blueprint (RECORD_NOT_IN_PROCESS, medido) y no queremos despertar reglas.
import { api as slack, ZOHO_UI } from './slack.js';
import { env } from './entorno.js';
import { USUARIOS } from './mapeos.js';

const VENTANA_H = 3; // la llamada y la reunion tienen que estar a menos de esto
const CAMPOS_EVENTO = 'id,Event_Title,Start_DateTime,Tipo_de_reuni_n,Status_del_Meet,Description,Motivo_de_la_consulta,Por_qui_n_fue_abordado,Problema_estuvo_resuelto,Who_Id,What_Id,Hora_local_del_cliente';
const CANAL = env.SLACK_CANAL_CLIENTES || env.SLACK_CANAL || '#calls-startcompanies';

// El picklist "¿Por quien fue abordado?" (Reuniones) tiene nombres, no ids.
const NOMBRE_PICKLIST = {
  'Adrián Darío Calabró': 'Adrián Calabró',
};

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Quien atendio, como opcion del picklist, o null si la llamada no lo dice. */
export function abordadoPor(nombreEnLlamada) {
  const n = norm(nombreEnLlamada);
  if (!n) return null;
  const gente = Object.values(USUARIOS).filter((x) => !x.generico);
  // Nombre completo primero. Si solo viene el nombre de pila, vale unicamente
  // cuando es de una sola persona (dos Ignacios: "Ignacio" a secas no alcanza).
  let u = gente.find((x) => norm(x.nombre) === n);
  if (!u) {
    const pila = n.split(' ')[0];
    const cand = gente.filter((x) => norm(x.nombre).split(' ')[0] === pila);
    if (cand.length === 1) u = cand[0];
  }
  if (!u) return null;
  return NOMBRE_PICKLIST[u.nombre] || u.nombre;
}

/**
 * La reunion de cliente que corresponde a una llamada: contacto por mail y
 * reunion de ese contacto con Tipo = Clientes a menos de 3 h de la llamada.
 * Devuelve { contacto, evento } o null. 2 llamadas.
 */
export async function reunionDeCliente(zoho, { mail, fecha }) {
  if (!mail) return null;
  const c = await zoho(`Contacts/search?email=${encodeURIComponent(mail)}&fields=id,Full_Name,Mobile,Account_Name`);
  const contacto = (c.data || [])[0];
  if (!contacto) return null;
  // `Contacts/<id>/Events` devuelve 204 vacio para las reuniones por Who_Id (medido 14-sep): se busca por criterio.
  const ev = await zoho(`Events/search?criteria=${encodeURIComponent(`((Who_Id:equals:${contacto.id})and(Tipo_de_reuni_n:equals:Clientes))`)}&fields=${CAMPOS_EVENTO}&per_page=50`);
  const t = new Date(fecha).getTime();
  const cerca = (ev.data || [])
    .filter((e) => e.Tipo_de_reuni_n === 'Clientes' && Math.abs(new Date(e.Start_DateTime).getTime() - t) <= VENTANA_H * 3600e3)
    .sort((a, b) => Math.abs(new Date(a.Start_DateTime) - t) - Math.abs(new Date(b.Start_DateTime) - t));
  return cerca[0] ? { contacto, evento: cerca[0] } : null;
}

/** Lo que se agrega a la Descripcion de la reunion. */
export function resumenParaDescripcion(datos, llamada) {
  const f = llamada?.fecha ? new Date(llamada.fecha).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '';
  const partes = [
    `Resumen de la llamada (Fathom${f ? `, ${f}` : ''}${llamada?.minutos ? `, ${llamada.minutos} min` : ''}): ${datos.resumen || ''}`.trim(),
    datos.proximo_paso ? `Próximo paso: ${datos.proximo_paso}${datos.responsable_proximo_paso ? ` (${datos.responsable_proximo_paso})` : ''}` : null,
    (datos.riesgos || []).length ? `Riesgos: ${datos.riesgos.join('; ')}` : null,
    llamada?.url ? `Grabación: ${llamada.url}` : null,
  ];
  return partes.filter(Boolean).join('\n');
}

/**
 * Escribe en Zoho: nota en el Contacto, resumen + abordado + asistio en la
 * reunion. Devuelve lo escrito. `zoho` es el cliente del worker (v6).
 */
export async function registrarLlamadaCliente(zoho, { contacto, evento, datos, llamada, nota }) {
  const hecho = { nota: null, campos: {} };

  const rn = await zoho('Notes', {
    method: 'POST',
    body: JSON.stringify({ data: [{ Note_Title: 'Llamada de cliente (Fathom)', Note_Content: String(nota || '').slice(0, 32000), Parent_Id: { module: { api_name: 'Contacts' }, id: contacto.id } }] }),
  });
  const r0 = (rn.data || [])[0];
  if (r0?.code !== 'SUCCESS') throw new Error(`nota contacto: ${r0?.code} ${r0?.message}`);
  hecho.nota = r0.details?.id || true;

  const campos = {};
  const resumen = resumenParaDescripcion(datos, llamada);
  if (!String(evento.Description || '').includes('Resumen de la llamada (Fathom')) {
    campos.Description = [evento.Description || '', resumen].filter(Boolean).join('\n\n').slice(0, 32000);
  }
  const quien = abordadoPor(datos.vendedor);
  if (quien && !evento.Por_qui_n_fue_abordado) campos.Por_qui_n_fue_abordado = quien;
  if (datos.cliente_se_presento !== false && !evento.Status_del_Meet) campos.Status_del_Meet = 'Asistió';

  if (Object.keys(campos).length) {
    const r = await zoho('Events', { method: 'PUT', body: JSON.stringify({ data: [{ id: evento.id, ...campos }], trigger: [] }) });
    const c0 = (r.data || [])[0];
    if (c0?.code !== 'SUCCESS') throw new Error(`reunion: ${c0?.code} ${c0?.message}`);
  }
  hecho.campos = campos;
  hecho.abordado = quien;
  return hecho;
}

/** La tarjeta de Slack con la pregunta. `value` de cada boton = "<eventoId>|<valor>". */
export function tarjetaCliente({ contacto, evento, datos, llamada, abordado, estado = null, quien = null }) {
  const titulo = `*Reunión de cliente:* <${ZOHO_UI}/Contacts/${contacto.id}|${contacto.Full_Name}>${evento.Motivo_de_la_consulta ? ` · ${evento.Motivo_de_la_consulta}` : ''}${evento.Hora_local_del_cliente ? ` · ${evento.Hora_local_del_cliente}` : ''}`;
  const cuerpo = [
    `*Resumen:* ${datos.resumen || '(sin resumen)'}`,
    datos.proximo_paso ? `*Próximo paso:* ${datos.proximo_paso}${datos.responsable_proximo_paso ? ` (${datos.responsable_proximo_paso})` : ''}` : null,
    `*Abordado por:* ${abordado || 'no se identificó en la llamada (marcalo en Zoho)'}`,
    llamada?.url ? `<${llamada.url}|grabación> · <${ZOHO_UI}/Events/${evento.id}|ver reunión>` : `<${ZOHO_UI}/Events/${evento.id}|ver reunión>`,
  ].filter(Boolean).join('\n');
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `${titulo}\n${cuerpo}` } },
  ];
  if (estado) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `✅ *¿Problema estuvo resuelto?* ${estado}${quien ? ` · marcó <@${quien}>` : ''}` }] });
  } else {
    const boton = (texto, valor, style) => ({ type: 'button', text: { type: 'plain_text', text: texto }, action_id: `cli_resuelto_${norm(valor).replace(/[^a-z]/g, '')}`, value: `${evento.id}|${valor}`, ...(style ? { style } : {}) });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*¿Problema estuvo resuelto?*' } });
    blocks.push({ type: 'actions', elements: [boton('Sí', 'Sí', 'primary'), boton('No', 'No', 'danger'), boton('Imposibilidad de reunión', 'Imposibilidad de reunión')] });
  }
  return { text: `Reunión de cliente: ${contacto.Full_Name}. ¿Problema estuvo resuelto?`, blocks };
}

/** Publica la tarjeta. Sin bot token, modo sombra. */
export async function publicarTarjetaCliente(args) {
  if (!env.SLACK_BOT_TOKEN) return { enviado: false, motivo: 'sin SLACK_BOT_TOKEN' };
  const cuerpo = tarjetaCliente(args);
  const j = await slack('chat.postMessage', { channel: CANAL, ...cuerpo, unfurl_links: false });
  return { enviado: true, ts: j.ts, canal: j.channel };
}
