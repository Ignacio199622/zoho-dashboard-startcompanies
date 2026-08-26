// El cerebro: lee la transcripcion de una llamada y devuelve los campos que
// hoy nadie carga en el CRM.
//
// Usa structured outputs, asi que la respuesta siempre valida contra el
// esquema y no hay que parsear texto libre ni manejar JSON roto.
import Anthropic from '@anthropic-ai/sdk';
import { env } from './fathom.js';
import { generar as generarGemini } from './gemini.js';
import { PROVEEDOR, MODELO_ANTHROPIC, MODELO_GEMINI, MAX_CARACTERES_TRANSCRIPCION } from './config.js';

export const modeloActual = () => (PROVEEDOR === 'gemini' ? MODELO_GEMINI : MODELO_ANTHROPIC);

// Todo opcional a proposito: es preferible un null honesto a un dato inventado.
const ESQUEMA = {
  type: 'object',
  properties: {
    cliente_se_presento: {
      type: 'boolean',
      description: 'Si el cliente efectivamente participo de la llamada. false cuando el vendedor entro y el cliente nunca se unio.',
    },
    resultado: {
      type: 'string',
      enum: ['cerro_en_la_llamada', 'no_cerro_quedo_pendiente', 'no_calificado', 'solo_informativa', 'soporte_cliente_actual'],
    },
    vendedor: { type: ['string', 'null'], description: 'Nombre de la persona de Start Companies que atendio, si se menciona' },
    cliente: { type: ['string', 'null'] },
    pais: { type: ['string', 'null'] },
    a_que_se_dedica: { type: ['string', 'null'] },
    motivo_llc: { type: ['string', 'null'], description: 'Por que necesita la LLC' },
    estructura: { type: ['string', 'null'], enum: ['single_member', 'multi_member', null] },
    estado_registro: { type: ['string', 'null'], description: 'Estado de EEUU donde quiere registrar' },
    medio_de_pago: { type: ['string', 'null'] },
    precio_discutido: { type: ['string', 'null'] },
    objecion: { type: ['string', 'null'], description: 'Que frena la compra. null si no hubo objecion' },
    proximo_paso: { type: ['string', 'null'] },
    responsable_proximo_paso: { type: ['string', 'null'], enum: ['cliente', 'start_companies', null] },
    nivel_de_interes: { type: 'string', enum: ['alto', 'medio', 'bajo'] },
    senales_de_compra: { type: 'array', items: { type: 'string' } },
    riesgos: { type: 'array', items: { type: 'string' }, description: 'Cosas que pueden hacer caer la venta' },
    resumen: { type: 'string', description: 'Una sola linea' },
  },
  required: ['cliente_se_presento', 'resultado', 'nivel_de_interes', 'resumen', 'senales_de_compra', 'riesgos'],
  additionalProperties: false,
};

const INSTRUCCIONES = `Sos analista de ventas de Start Companies, una empresa que abre LLCs en Estados Unidos para clientes de LATAM y España.

Te paso la transcripcion de una llamada real. Extrae solo lo que se puede afirmar de lo que se dijo. Si un dato no aparece, pone null. No inventes ni completes por probabilidad.

DOS COSAS IMPORTANTES SOBRE ESTAS TRANSCRIPCIONES:

1. La asignacion de quien habla esta MAL en muchas lineas: el sistema mezcla los hablantes, y hay frases del vendedor atribuidas al cliente y viceversa. No te fies de las etiquetas de hablante, deduci quien dice que por el contenido.

2. El campo "vendedor" casi nunca aparece como etiqueta: todas las llamadas se graban con una cuenta generica. Si alguien menciona un nombre propio del lado de Start Companies (por ejemplo "gracias Ignacio"), usalo. Si no, pone null. No adivines.

IMPORTANTE - "cliente_se_presento": que exista grabacion NO significa que el cliente haya venido.
El sistema graba en cuanto el vendedor entra a la reunion, asi que hay grabaciones donde el
vendedor esta solo esperando y el cliente nunca aparece. Marca false en ese caso, aunque la
grabacion dure varios minutos.

Sobre el resultado de la llamada:
- "cerro_en_la_llamada": pago o confirmo la contratacion durante la llamada
- "no_cerro_quedo_pendiente": hay interes y un proximo paso, pero no cerro
- "no_calificado": no es cliente posible (no tiene el presupuesto, no aplica, no le sirve)
- "solo_informativa": pidio informacion sin intencion clara de avanzar
- "soporte_cliente_actual": es un cliente que ya compro, la llamada es de soporte o seguimiento

En "riesgos" pone lo concreto que puede hacer caer la venta (una decision que quedo sin fecha, un viaje, una duda no resuelta), no riesgos genericos.`;

/**
 * @returns {Promise<{datos: object, uso: object}>}
 */
export async function analizarLlamada({ titulo, fecha, duracionMin, transcripcion, resumenFathom }) {
  const texto = transcripcion.slice(0, MAX_CARACTERES_TRANSCRIPCION);

  const contexto = [
    `TITULO: ${titulo || '(sin titulo)'}`,
    `FECHA: ${fecha || '?'}`,
    duracionMin ? `DURACION: ${duracionMin} minutos` : null,
    resumenFathom ? `\nRESUMEN AUTOMATICO DE FATHOM:\n${resumenFathom}` : null,
    `\nTRANSCRIPCION:\n${texto}`,
  ]
    .filter(Boolean)
    .join('\n');

  if (PROVEEDOR === 'gemini') {
    return generarGemini({
      modelo: MODELO_GEMINI,
      instrucciones: INSTRUCCIONES,
      contenido: contexto,
      esquema: ESQUEMA,
    });
  }

  const cliente = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const respuesta = await cliente.messages.create({
    model: MODELO_ANTHROPIC,
    max_tokens: 4000,
    system: INSTRUCCIONES,
    output_config: { format: { type: 'json_schema', schema: ESQUEMA } },
    messages: [{ role: 'user', content: contexto }],
  });

  if (respuesta.stop_reason === 'refusal') {
    throw new Error('El modelo declino analizar esta llamada');
  }

  const bloque = respuesta.content.find((b) => b.type === 'text');
  if (!bloque) throw new Error('Respuesta sin contenido de texto');

  return {
    datos: JSON.parse(bloque.text),
    uso: {
      entrada: respuesta.usage.input_tokens,
      salida: respuesta.usage.output_tokens,
      cacheLectura: respuesta.usage.cache_read_input_tokens || 0,
    },
  };
}
