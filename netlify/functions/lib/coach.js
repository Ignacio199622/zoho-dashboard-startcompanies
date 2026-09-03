// El Coach de Ventas: lee la llamada y devuelve tres cosas distintas.
//
//   1. Si el vendedor siguio el script (con la cita textual que lo prueba)
//   2. Como seguir a este cliente: retargeting, seguimiento del vendedor, o nada
//   3. El mensaje post-llamada listo para mandar, si conviene mandarlo
//
// Reemplaza al Zap "Coach de Ventas SC" que posteaba en #calls-startcompanies
// hasta el 17-jul. Aquel ponia el tilde en los 6 pasos SIEMPRE, y ademas
// describia el paso en vez de lo que hizo el vendedor ("el vendedor cierra la
// llamada preguntando si desea avanzar" es la definicion del paso, no la
// evidencia de que ocurrio). Por eso este exige una cita textual para cada
// tilde: sin cita, no hay tilde.
import { pensar } from './cerebro.js';
import { PROVEEDOR_COACH } from './config.js';

// Los 6 pasos del script de venta, en orden. Las claves son las del esquema.
export const PASOS = [
  ['introduccion', 'Introducción como experto'],
  ['diagnostico', 'Diagnóstico del cliente'],
  ['impositiva', 'Explicación impositiva'],
  ['presentacion', 'Presentación del servicio'],
  ['objeciones', 'Manejo de objeciones'],
  ['cierre', 'Cierre'],
];

const paso = () => ({
  type: 'object',
  properties: {
    estado: { type: 'string', enum: ['si', 'parcial', 'no', 'no_aplica'] },
    cita: {
      type: ['string', 'null'],
      description: 'Frase TEXTUAL del vendedor que prueba el estado. Obligatoria si estado es "si". null si no la hay.',
    },
    comentario: { type: 'string', description: 'Una linea. Que hizo o que falto, concreto.' },
  },
  required: ['estado', 'comentario'],
  additionalProperties: false,
});

export const ESQUEMA_COACH = {
  type: 'object',
  properties: {
    script: {
      type: 'object',
      properties: Object.fromEntries(PASOS.map(([k]) => [k, paso()])),
      required: PASOS.map(([k]) => k),
      additionalProperties: false,
    },
    fuertes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Como maximo 3. Cosas que el vendedor hizo bien EN ESTA llamada, con el detalle que las hace especificas. Vacio si no hubo ninguna destacable.',
    },
    a_mejorar: {
      type: 'array',
      items: { type: 'string' },
      description: 'Como maximo 3. Errores concretos y que decir la proxima vez. Esto es lo que hace util al coach: no lo dejes vacio salvo que la llamada haya sido impecable.',
    },
    momento_clave: {
      type: ['string', 'null'],
      description: 'El instante donde se ganaba o se perdia la venta, con el timestamp si se puede.',
    },

    // --- Seguimiento -------------------------------------------------------
    seguimiento: {
      type: 'object',
      properties: {
        via: {
          type: 'string',
          enum: ['seguimiento_vendedor', 'retargeting_30d', 'nurturing', 'ninguno'],
          description: 'seguimiento_vendedor: hay proximo paso concreto y persona esperando, lo trabaja el vendedor a mano. retargeting_30d: hay interes pero sin fecha, entra a la cadencia. nurturing: no compra ahora pero puede en meses. ninguno: no calificado, ya cerro, o es soporte.',
        },
        motivo: { type: 'string', description: 'Una linea, por que esa via y no otra.' },
        cuando: { type: 'string', description: 'Cuando tocarlo de nuevo: "hoy", "en 48h", "el lunes", una fecha.' },
        dias: {
          type: 'integer',
          description: 'Lo mismo que "cuando" pero en dias desde hoy, para poner fecha a la tarea del CRM. 0 = hoy, 1 = manana.',
        },
        que_decir: { type: ['string', 'null'], description: 'El angulo del proximo contacto, no el texto.' },

        // El COMO. Sin esto el coach dice "seguile" y el vendedor sigue sin
        // saber que hacer el jueves.
        plan: {
          type: 'array',
          description: 'Los toques concretos, en orden, como maximo 3. El primero es el mensaje post-llamada.',
          items: {
            type: 'object',
            properties: {
              dias: { type: 'integer', description: 'A cuantos dias de hoy. 0 = hoy.' },
              canal: { type: 'string', enum: ['whatsapp', 'llamada', 'mail', 'audio'] },
              que_hacer: { type: 'string', description: 'Una linea concreta. Que dice o que manda, no "hacer seguimiento".' },
            },
            required: ['dias', 'canal', 'que_hacer'],
            additionalProperties: false,
          },
        },
        si_no_contesta: {
          type: 'string',
          description: 'Que hacer si despues de todo el plan sigue el silencio: a que dia se corta y a donde pasa (retargeting, nurturing, o cerrarlo como no interesado).',
        },
      },
      required: ['via', 'motivo', 'cuando', 'dias', 'plan', 'si_no_contesta'],
      additionalProperties: false,
    },

    // --- El mensaje post-llamada ------------------------------------------
    mensaje: {
      type: ['object', 'null'],
      description: 'El mensaje para mandarle al cliente ahora. Por defecto SIEMPRE va escrito. Solo null en los tres casos del prompt.',
      properties: {
        texto: {
          type: 'string',
          description: 'El mensaje completo, listo para pegar. En español rioplatense neutro, de vos. Sin emojis decorativos, sin "espero que estes muy bien". Arranca por lo que quedo pendiente EN ESTA llamada. Maximo 6 lineas.',
        },
        por_que: { type: 'string', description: 'Una linea: que hace este mensaje que otro no haria.' },
        urgencia: {
          type: 'string',
          enum: ['ahora', 'hoy', 'manana'],
          description: 'ahora si hay una ventana que se cierra o un competidor en juego.',
        },
      },
      required: ['texto', 'por_que', 'urgencia'],
      additionalProperties: false,
    },
  },
  required: ['script', 'fuertes', 'a_mejorar', 'seguimiento'],
  additionalProperties: false,
};

const INSTRUCCIONES = `Sos el coach de ventas de Start Companies, que abre LLCs en Estados Unidos para clientes de LATAM y España. Escuchas la llamada de un vendedor del equipo y le devolves algo que le sirva mañana.

ADVERTENCIA SOBRE LA TRANSCRIPCION: la asignacion de quien habla esta MAL en muchas lineas. Hay frases del vendedor atribuidas al cliente y viceversa. Deduci quien dice que por el contenido, no por la etiqueta.

## Parte 1: el script

Los 6 pasos son: introduccion como experto, diagnostico del cliente, explicacion impositiva, presentacion del servicio, manejo de objeciones, cierre.

REGLA DURA: para poner "si" necesitas una CITA TEXTUAL del vendedor que lo pruebe. Si no encontras la cita, el estado es "parcial" o "no". No describas en que consiste el paso: eso no es evidencia. "El vendedor cierra preguntando si quiere avanzar" es la definicion del cierre, no la prueba de que ocurrio.

- "si": ocurrio y tenes la cita
- "parcial": lo toco por arriba, o lo hizo tarde, o lo hizo mal
- "no": no ocurrio
- "no_aplica": el paso no tenia sentido en esta llamada (ej: manejo de objeciones si el cliente no objeto nada, cierre si el cliente no se presento)

Un informe donde los 6 pasos son "si" casi nunca es cierto. Si te pasa, revisa de nuevo.

## Parte 2: como seguir a este cliente

Elegi UNA via:
- "seguimiento_vendedor": hay un proximo paso concreto y alguien esperando algo. Lo trabaja el vendedor a mano. Es la via por defecto cuando el cliente mostro interes real: la cadencia automatica no sabe de que hablaron.
- "retargeting_30d": hubo interes pero no hay proximo paso con fecha, y nadie lo va a llamar. La cadencia lo mantiene tibio.
- "nurturing": no compra en los proximos 30 dias por una razon estructural (esta armando el negocio, no factura todavia, espera un tramite), pero puede comprar en meses.
- "ninguno": no calificado, ya cerro y pago, o era soporte de un cliente actual.

Ojo con dos cosas: un cliente que dijo "lo hablo con mi socio y te aviso" NO va a retargeting, va a seguimiento del vendedor con fecha. Y un cliente que ya cerro no va a ninguna cadencia de venta.

### El plan: el COMO, que es lo que de verdad falta

Decir "hacele seguimiento" no sirve. Dale los toques concretos, en orden, como maximo 3, y que cada uno diga que hace, no que "haga seguimiento":

- El PRIMER toque (dias = 0) es siempre mandar el mensaje post-llamada que escribis abajo.
- Los siguientes son distintos entre si. Si el toque 2 es "reenviar el mismo mensaje", esta mal: tiene que aportar algo nuevo (un audio corto, el dato que faltaba, una fecha concreta, hablar con la otra persona que decide).
- Espacialos segun el caso, no con una formula. Alguien que dijo "el martes te confirmo" se toca el miercoles, no a las 48h.
- HOY es {{HOY}}. No agendes toques en sabado ni domingo: son clientes y equipos que trabajan de lunes a viernes. Si la cuenta te cae en fin de semana, movelo al lunes.
- El canal importa: WhatsApp para lo corto, llamada cuando hay que convencer o hay dos personas decidiendo, mail cuando la ventana de WhatsApp esta cerrada.

En "si_no_contesta" pone el corte: a que dia se deja de insistir y a donde va. Escribilo en castellano normal, para que lo lea un vendedor: "pasarlo al retargeting de 30 dias", no "retargeting_30d". Sin eso el lead queda flotando para siempre. Hoy el equipo tiene 43 llamadas a mitad de camino porque nadie definio cuando parar.

## Parte 3: el mensaje post-llamada

Escribis el mensaje que el vendedor le manda al cliente ahora mismo. Reglas:

- Arranca por lo concreto que quedo de ESTA llamada: el estado que eligieron, la duda que quedo abierta, el documento que falta. Nunca por "fue un gusto hablar contigo".
- Nada de emojis decorativos ni de "espero que te encuentres muy bien".
- No uses rayas largas (guion largo) en el texto: escribi con comas, puntos o parentesis.
- Un solo pedido. Si el mensaje pide dos cosas, no contesta ninguna.
- Si quedo una duda que el vendedor no supo responder en la llamada, el mensaje la responde. Eso es lo que reabre la conversacion.
- Maximo 6 lineas. Se manda por WhatsApp: parrafos cortos.
- Tuteo rioplatense (vos), neutro, sin modismos fuertes.

CUANDO VA null: solo en estos tres casos, y en ningun otro.
  a) el cliente no se presento a la llamada
  b) no califica (no puede o no le sirve el servicio, y no va a cambiar)
  c) ya pago y la llamada era de soporte

Todo lo demas lleva mensaje, incluido "quedo pendiente", "lo consulta con un
tercero", "no tiene la plata este mes" y "se lo va a pensar". Esos son
justamente los casos donde el mensaje decide la venta: de 90 llamadas solo
cierran 7, y 43 quedan a mitad de camino esperando que alguien escriba.
Si dudas, escribi el mensaje: el vendedor puede descartarlo con un boton.`;

/**
 * @param {object} analisis  lo que ya devolvio extraer.js para esta llamada
 * @returns {Promise<{datos: object, uso: object}>}
 */
export async function coachearLlamada({ titulo, fecha, duracionMin, transcripcion, analisis, lead, ventana }) {
  const hoy = new Date();
  const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  const instrucciones = INSTRUCCIONES.replace(
    '{{HOY}}',
    `${DIAS[hoy.getDay()]} ${hoy.getDate()}/${hoy.getMonth() + 1}/${hoy.getFullYear()}`
  );

  const ctx = [
    `TITULO: ${titulo || '(sin titulo)'}`,
    `FECHA: ${fecha || '?'}`,
    duracionMin ? `DURACION: ${duracionMin} minutos` : null,
    lead?.Full_Name ? `CLIENTE EN EL CRM: ${lead.Full_Name}` : null,
    lead?.Lead_Status ? `ESTADO EN EL CRM: ${lead.Lead_Status}` : null,
    lead?.Retargeting ? 'YA ESTA EN UNA CADENCIA DE RETARGETING (no lo mandes de nuevo)' : null,
    ventana && ventana.abierta === false
      ? 'VENTANA DE WHATSAPP CERRADA: el cliente no escribe hace mas de 24h, asi que este mensaje solo se puede mandar por mail o con plantilla aprobada. Escribilo igual, pero que funcione leido en frio.'
      : null,
    '',
    'LO QUE YA SE EXTRAJO DE ESTA LLAMADA (no lo repitas, usalo):',
    JSON.stringify(analisis, null, 1),
    '',
    `TRANSCRIPCION:\n${transcripcion}`,
  ]
    .filter(Boolean)
    .join('\n');

  return pensar({ proveedor: PROVEEDOR_COACH, instrucciones, contenido: ctx, esquema: ESQUEMA_COACH, maxTokens: 6000 });
}
