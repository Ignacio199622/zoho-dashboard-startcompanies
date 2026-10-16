// WhatsApp del 786: lo que escribieron clientes y leads y quedo sin contestar.
//
// UNA sola llamada a Zoho por corrida: `messages__s` con If-Modified-Since,
// una pagina de 200. Nada de barridos ni paginado: el token de Zoho es
// compartido y pedir de mas ya tumbo a todos los agentes dos veces (9-sep y
// 17-sep). El `get` llega de afuera: en Netlify es el de
// lib/conversaciones/zoho.js, que se presta el token del store `zoho-token` y
// respeta la pausa compartida; en una prueba local se pasa uno que reusa ese
// mismo token guardado y nunca pide uno nuevo.
//
// `conversation_status__s`:
//   Responded = el ultimo que hablo fue el cliente, nadie contesto todavia
//   Replied   = el ultimo que hablo fue el equipo
// `last_message__s` es solo el ultimo mensaje (no hay historial por API), asi
// que lo que se analiza es lo que quedo esperando.
import { limpiar } from '../conversaciones/texto.js';
import { esBaja } from '../conversaciones/bajas.js';
import { generar } from '../conversaciones/gemini.js';

const CAMPOS = ['mobile_number__s', 'last_message__s', 'conversation_status__s', 'message_time__s', 'sender__s', 'replied_by__s'].join(',');
const MODELO = process.env.MODELO_GEMINI || 'gemini-3.8-flash';
const MAX_A_GEMINI = 150;

// Texto que no dice nada: saludos, confirmaciones de agenda, emojis sueltos.
const VACIO = /^(hola|buenas|buen d[ií]a|buenas tardes|buenas noches|ok|okey|dale|gracias|muchas gracias|s[ií]|no|listo|perfecto|genial|s[uú]per|\.)[\s!.,]*$/i;
const SOLO_EMOJI = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s]+$/u;

/** Tiene algo que leer: no es saludo suelto, emoji solo ni pedido de baja. */
export const conContenido = (c) => {
  const t = String(c.last_message__s || '').trim();
  return Boolean(t) && !VACIO.test(t) && !SOLO_EMOJI.test(t) && !esBaja(t);
};

/** La unica llamada a Zoho del vigia. */
export async function leerWhatsapp({ get, desde }) {
  const cabecera = { 'If-Modified-Since': desde.toISOString().replace(/\.\d{3}Z$/, '+00:00') };
  const j = await get(`messages__s?fields=${CAMPOS}&per_page=200&page=1&sort_by=Modified_Time&sort_order=desc`, cabecera);
  const convs = (j.data || []).map((c) => ({ ...c, last_message__s: limpiar(c.last_message__s) }));
  return { convs, masRegistros: Boolean(j.info?.more_records) };
}

const nombre = (c) => c.sender__s?.name || c.mobile_number__s || 'sin nombre';
const tipoPersona = (c) => (c.sender__s?.module?.api_name === 'Contacts' ? 'cliente' : 'lead');

/** Lo que esta esperando respuesta, sin bajas ni saludos sueltos. */
export function esperando(convs, ahora = new Date()) {
  return convs
    .filter((c) => c.conversation_status__s === 'Responded' && c.message_time__s)
    .map((c) => ({ ...c, horas: Math.max(0, (ahora - new Date(c.message_time__s)) / 36e5) }))
    .sort((a, b) => b.horas - a.horas);
}

const ESQUEMA = {
  type: 'object',
  properties: {
    problemas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['error', 'queja', 'duda'] },
          tema: { type: 'string', description: 'el tema en pocas palabras, ej: "no pueden entrar al panel"' },
          cantidad: { type: 'integer', description: 'cuantas personas distintas lo plantean' },
          ejemplo: { type: 'string', description: 'una frase textual corta de uno de los mensajes' },
          refs: { type: 'array', items: { type: 'string' }, description: 'los ref de los mensajes del grupo' },
        },
        required: ['tipo', 'tema', 'cantidad', 'ejemplo', 'refs'],
      },
    },
    esperan: {
      type: 'array',
      items: { type: 'string' },
      description: 'los ref de los mensajes que necesitan respuesta del equipo (preguntas, pedidos, problemas). NO incluyas agradecimientos, despedidas, "no me interesa" ni emojis',
    },
    mejoras: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          que: { type: 'string', description: 'la mejora, accionable, en una frase' },
          donde: { type: 'string', description: 'el lugar exacto: panel (que pantalla), web/landing, plantilla de WhatsApp, Matías, proceso del equipo, mail' },
          porque: { type: 'string', description: 'el motivo, con el dato que lo respalda (cuantos lo preguntaron)' },
        },
        required: ['que', 'donde', 'porque'],
      },
    },
  },
  required: ['problemas', 'esperan', 'mejoras'],
};

const INSTRUCCIONES = `Sos el vigía de Start Companies. La empresa arma LLCs en Estados Unidos para latinos, les abre la cuenta bancaria, les hace las renovaciones y las declaraciones, y tiene un panel web para clientes. Te paso los últimos mensajes de WhatsApp que mandaron clientes y leads y que todavía nadie contestó.

Devolvé:
1. "problemas": agrupá los mensajes por tema.
   - tipo "error": algo no funciona (no pueden entrar al panel, un pago que falla, una firma que no anda, un link roto, un documento que no llega).
   - tipo "queja": alguien está molesto (demora, nadie le contesta, cobro que no entiende).
   - tipo "duda": una pregunta.
   Los errores van aunque los diga una sola persona. Las quejas y dudas SOLO si las plantean 2 o más personas distintas.
2. "esperan": los ref de los mensajes que de verdad necesitan una respuesta del equipo.
3. "mejoras": hasta 5 mejoras concretas que eviten que esos mensajes lleguen. Cada una accionable (qué cambiar exactamente), con "donde" (el lugar exacto) y "porque" (el dato de los mensajes que la respalda). Si no hay base en los mensajes, no la inventes: menos es mejor.

Ignorá saludos sueltos, "gracias", confirmaciones de reunión (sí/no), pedidos de baja y mensajes sin contenido. No inventes nada que no esté en los mensajes.
Escribí en español rioplatense, frases cortas y simples, sin guiones largos.`;

async function generarConReintento(args) {
  try {
    return await generar(args);
  } catch (e) {
    // La cuota de Gemini la comparten varios agentes que corren en punto.
    if (!/HTTP 429|HTTP 503/.test(e.message)) throw e;
    await new Promise((r) => setTimeout(r, 25000));
    return generar(args);
  }
}

/**
 * Agrupa con Gemini. Devuelve { problemas, mejoras, analizados, costoTokens }.
 * Los `refs` vuelven convertidos a nombres para poder mostrarlos.
 */
export async function analizar(pendientes) {
  const utiles = pendientes.filter(conContenido).slice(0, MAX_A_GEMINI);
  if (!utiles.length) return { problemas: [], mejoras: [], esperanRespuesta: [], analizados: 0 };

  const porRef = new Map(utiles.map((c, i) => [`m${i + 1}`, c]));
  const contenido = [...porRef.entries()]
    .map(([ref, c]) => `[${ref}] (${tipoPersona(c)}, hace ${Math.round(c.horas)} h) ${c.last_message__s.replace(/\s+/g, ' ').slice(0, 400)}`)
    .join('\n');

  const { datos, uso } = await generarConReintento({ modelo: MODELO, instrucciones: INSTRUCCIONES, contenido, esquema: ESQUEMA, maxTokens: 6000 });
  const problemas = (datos.problemas || [])
    .map((p) => {
      const quienes = [...new Set((p.refs || []).map((r) => porRef.get(r)).filter(Boolean).map(nombre))];
      return { ...p, cantidad: Math.max(p.cantidad || 0, quienes.length), quienes };
    })
    .filter((p) => p.tipo === 'error' || p.cantidad >= 2)
    .sort((a, b) => b.cantidad - a.cantidad);
  const esperanRespuesta = (datos.esperan || []).map((r) => porRef.get(r)).filter(Boolean);
  return { problemas, esperanRespuesta, mejoras: (datos.mejoras || []).slice(0, 5), analizados: utiles.length, uso };
}

export { nombre, tipoPersona };
