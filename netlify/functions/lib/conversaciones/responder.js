// DECIDE SI CORRESPONDE UNA RESPUESTA AUTOMATICA, Y CUAL.
//
// No manda nada. Igual que `guardia.js`, este modulo solo decide; el envio lo
// hace Zoho con una plantilla aprobada. La razon esta en el encabezado de
// `zoho.js`: en agosto de 2026 una regla en bucle mando la misma plantilla cada
// tres minutos hasta que Meta bloqueo el numero.
//
// El orden importa y es a proposito:
//
//   1. Los frenos deterministicos, que no cuestan un token y no fallan.
//   2. Recien despues el modelo, que ELIGE una entrada del catalogo. Nunca
//      escribe: el texto lo escribio una persona (ver `respuestas.js`).
//
// Los tres primeros frenos salieron de leer dos conversaciones reales enteras
// (Emiliano y Katherine, agosto y septiembre de 2026). No son hipotesis.
import { limpiar } from './texto.js';
import { RESPUESTAS, porId, catalogo, LINK_AGENDA, LINKS_AGENDA, calendarioDeFicha } from './respuestas.js';

// ─── Frenos deterministicos ────────────────────────────────────────────────

// 1. YA LO INTENTO.
//
// Emiliano escribio tres veces que ya habia estado en los videos: "sii los vi",
// "no lo encontre en los videos, por eso molesto", "perdon no vi los videos
// aun". Dos de tres, ya habia ido. Contestarle "esta el video en tu panel" a
// alguien que viene de ahi es la peor respuesta posible: suena a que no lo
// leyeron.
const YA_INTENTO = [
  /\bme trab[eé]\b/, /\bestoy trabad[oa]\b/, /\bno encontr[eé]\b/, /\bno lo encuentro\b/,
  /\bya (lo |los |las )?vi\b/, /\bya mir[eé]\b/, /\bya le[ií]\b/, /\bya intent[eé]\b/,
  /\bya prob[eé]\b/, /\bno me funciona\b/, /\bno funciona\b/, /\bno me deja\b/,
  /\bno puedo\b/, /\bsigo sin\b/, /\bno me sale\b/, /\bme da error\b/,
  /\bno aparece\b/, /\bme rechaz/, /\bme bloque/, /\bno me lleg/,
];

// 2. REGATEO.
//
// Con Katherine el precio bajo de 599 a 550, a 500 y se cobro 499. Eso lo
// decide una persona y a veces lo decide el dueño. Un robot no negocia.
const REGATEO = [
  /\bdescuento\b/, /\bmas barato\b/, /\bm[aá]s barato\b/, /\brebaja/, /\boferta\b/,
  /\bno hay posibilidad\b/, /\bpodr[ií]as dejarme\b/, /\bme lo dej[aá]s en\b/,
  /\bhacem[eé] un precio\b/, /\bes mucho\b/, /\bes caro\b/, /\bcobra menos\b/,
  /\botra (empresa|persona) (me )?(cobra|hace)\b/, /\bmas econom/, /\bm[aá]s econ[oó]m/,
];

// 3. PREFIERE ESCRIBIR.
//
// Katherine escribio "preferiria mediante texto whatsapp, ya que estoy en el
// trabajo y no puedo hablar telefono" y le siguieron ofreciendo llamadas. Si
// dijo que no puede hablar, no se le ofrece agendar.
const PREFIERE_ESCRIBIR = [
  /\bpor (aqu[ií]|ac[aá]|este medio|whatsapp)\b.*\bmejor\b/,
  /\bprefier[oa].*(texto|escrib|whatsapp|ac[aá]|aqu[ií])/,
  /\bno puedo (hablar|atender|llamar)/, /\bestoy (en el )?trabaj/,
  /\bsin llamada\b/, /\bno quiero (una )?llamada\b/,
];

// 4. QUIERE AVANZAR, NO QUE LE EXPLIQUEN.
//
// Salio de evaluar la base contra preguntas reales: a "Pero necesito el itin
// number" el bot iba a explicarle QUE es el ITIN, cuando la persona ya lo sabia
// y lo que queria era el link de pago. El que pide avanzar no quiere una
// definicion: quiere que alguien le mueva el tramite.
const QUIERE_AVANZAR = [
  /\bnecesito (el|la|un|una|mi)\b/, /\bquiero (avanzar|contratar|empezar|arrancar|comprar)\b/,
  /\bpasame el link\b/, /\bmandame el link\b/, /\bcomo (le )?pago\b.*\bahora\b/,
  /\bvamos con (eso|esa|ese)\b/, /\bdale,? (avanc|proced|hagam)/,
  /\bhagamoslo\b/, /\bya pagu[eé]\b/, /\bcuando (lo )?(hacemos|empezamos)\b/,
];

// 5. PREGUNTA SI ES UN ROBOT.
//
// La politica de mensajeria de Meta pide no engañar sobre quien es el negocio.
// Firmar como Marcos esta bien y lo hace todo el mundo; sostener que es una
// persona cuando te lo preguntan derecho, no. Y ademas es malisimo
// comercialmente: el que pregunta eso ya sospecha, y una respuesta automatica
// le confirma la sospecha. Contesta una persona.
const PREGUNTA_SI_ES_BOT = [
  /\bso[sn] (un )?(bot|robot|maquina|ia|inteligencia)\b/,
  /\bes(to)? (un )?(bot|robot|automatico)\b/,
  /\b(habl|atend|comunic)[a-z]* con (una persona|un humano|alguien|un asesor|una asesora)/,
  /\bpersona (real|de verdad|humana)\b/,
  /\b(hay|sos) (una )?persona (real|de verdad)\b/,
  /\bme (esta )?contest(a|ando) (un|una) (bot|robot|maquina)\b/,
];

// 6. ENOJO. Nunca sale una respuesta automatica sobre un reclamo.
const ENOJO = [
  /\breclam/, /\bqueja\b/, /\bp[eé]sim/, /\bverg[uü]enz/, /\bestafa/, /\bmentir/,
  /\bcansad[oa] de\b/, /\bhace (d[ií]as|semanas|un mes)\b.*\bnadie\b/,
  /\bdevu[eé]lvanme\b/, /\bquiero (la )?baja\b/, /\bcancelar el servicio\b/,
  /\bno me est[aá]s ayudando\b/, /\bmolest[oa]\b/,
];

// Un archivo suelto no se puede leer. No es un freno del contenido, es que no
// hay contenido.
const SOLO_ARCHIVO = /^\s*\d{6,}\.(ogg|opus|jpeg|jpg|png|pdf|mp4|xlsx?|docx?)\s*$/i;

const norm = (s) =>
  limpiar(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/**
 * ¿Hay algo que impida contestar automaticamente, sin mirar el contenido?
 * Devuelve el motivo, o null si no hay freno.
 */
export function freno(mensaje) {
  const t = norm(mensaje);
  if (!t) return 'mensaje vacio';
  if (SOLO_ARCHIVO.test(String(mensaje).trim())) return 'es un archivo o un audio, hay que abrirlo';
  if (PREGUNTA_SI_ES_BOT.some((re) => re.test(t))) return 'pregunta si habla con una persona';
  if (ENOJO.some((re) => re.test(t))) return 'viene con enojo o reclamo';
  if (QUIERE_AVANZAR.some((re) => re.test(t))) return 'quiere avanzar, no que le expliquen';
  if (YA_INTENTO.some((re) => re.test(t))) return 'ya lo intento por su cuenta';
  if (REGATEO.some((re) => re.test(t))) return 'esta negociando el precio';
  return null;
}

/** ¿Pidió que no le ofrezcan llamadas? No frena la respuesta, la recorta. */
export function noQuiereLlamada(mensaje) {
  const t = norm(mensaje);
  return PREFIERE_ESCRIBIR.some((re) => re.test(t));
}

// ─── Apertura ──────────────────────────────────────────────────────────────

// Decision de Ignacio (2026-09-08): si la conversacion recien arranca, se
// presenta como Marcos. Si ya venian hablando, entra directo. Un "Hola X, soy
// Marcos" en el mensaje numero ocho delata al robot mas que cualquier otra cosa.
export const FIRMA = 'Marcos, del equipo de Start Companies';

// Pasada una semana sin hablar, el cliente ya no se acuerda con quien hablaba:
// vuelve a ser un inicio.
export const DIAS_PARA_VOLVER_A_PRESENTARSE = 7;

export function esInicio(conversacion, ahora = new Date()) {
  if (!conversacion.replied_by__s) return true;
  const ultimo = conversacion.message_time__s ? new Date(conversacion.message_time__s) : null;
  if (!ultimo || Number.isNaN(ultimo.getTime())) return false;
  const dias = (ahora - ultimo) / (24 * 3600 * 1000);
  return dias > DIAS_PARA_VOLVER_A_PRESENTARSE;
}

function primerNombre(ficha) {
  const full = (ficha?.Full_Name || '').trim();
  if (!full) return null;
  const n = full.split(/\s+/)[0];
  if (n.length < 2 || /^\+?\d+$/.test(n)) return null;
  return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
}

/**
 * El mensaje final, listo para escribir en el campo que dispara la plantilla.
 */
export function componer(entrada, { ficha, inicio, sinLlamada } = {}) {
  let texto = entrada.texto;
  // Lili y partners reagendan en su calendario, no en el /agendar de LLC (16-oct).
  const cal = calendarioDeFicha(ficha);
  if (cal && LINKS_AGENDA[cal]) texto = texto.split(LINK_AGENDA).join(LINKS_AGENDA[cal]);

  // Si pidio no hablar por telefono, se le saca la invitacion a agendar.
  if (sinLlamada) {
    texto = texto
      .split('\n\n')
      .filter((p) => !/llamada de 30 minutos|agend[aá]|asesor/i.test(p))
      .join('\n\n');
  }

  const nombre = primerNombre(ficha);
  if (!inicio) return texto;

  const saludo = nombre
    ? `Hola ${nombre}, soy ${FIRMA}.`
    : `Hola, soy ${FIRMA}.`;
  return `${saludo}\n\n${texto}`;
}

// Cuantos mensajes previos se le muestran al modelo. Con mas, la charla vieja
// empieza a pesar mas que la pregunta de ahora: elige por lo que se hablo hace
// media hora en vez de por lo que le acaban de preguntar.
export const MENSAJES_DE_CONTEXTO = 6;

const SALTO = String.fromCharCode(10);

/**
 * El hilo como lo lee el modelo. Devuelve null si no hay nada util: sin esto,
 * una conversacion nueva mostraria un encabezado vacio y el modelo se pondria a
 * interpretar el silencio.
 */
export function renderHilo(hilo) {
  const previos = (hilo || []).filter((m) => m && m.texto);
  if (!previos.length) return null;
  return previos
    .slice(-MENSAJES_DE_CONTEXTO)
    .map((m) => `${m.de === 'nosotros' ? 'nosotros' : 'cliente'}: ${String(m.texto).slice(0, 300)}`)
    .join(SALTO);
}

// ─── La eleccion ───────────────────────────────────────────────────────────

const INSTRUCCIONES = `Sos parte del equipo de Start Companies, que abre y administra LLCs en Estados
Unidos para emprendedores de Latinoamerica y España.

Te paso mensajes que escribieron clientes por WhatsApp y un catalogo de respuestas ya escritas.
Tu unica tarea es decir CUAL de esas respuestas contesta el mensaje, o ninguna.

NO escribas respuestas. Solo elegis un id del catalogo.

Elegi "ninguna" siempre que:
- el mensaje sea sobre el estado del tramite de esa persona ("¿ya salio mi EIN?", "¿en que quedo lo mio?")
- pida un monto, un link de pago o un dato de su cuenta puntual
- sea un saludo, un agradecimiento o una confirmacion sin pregunta
- la pregunta tenga matices que la respuesta elegida no cubre
- tengas dudas entre dos entradas

Ante la duda, "ninguna". Una respuesta que no encaja del todo es peor que no contestar:
si no contestamos, contesta una persona en unos minutos.

A veces te paso "lo que se dijeron antes". Eso esta para UNA sola cosa: entender a que se
refiere el mensaje de ahora cuando viene cortado. "¿Y de la LLC?" despues de hablar de plazos
es una pregunta por los plazos de la LLC; el mismo mensaje suelto no es nada.

Dos limites con eso:
- Contestas el ULTIMO mensaje, no lo que quedo pendiente mas arriba en la charla.
- Si en el hilo ya venia contestando una persona del equipo algo puntual del caso de este
  cliente, elegi "ninguna": esa charla es de alguien y no hay que meterse en el medio.

Devolve tambien "confianza" del 1 al 5, donde 5 es que la respuesta contesta exactamente
lo que preguntaron y 1 es que se le parece.`;

const ESQUEMA = {
  type: 'object',
  properties: {
    resultados: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          id: { type: 'string', description: 'el id del catalogo, o "ninguna"' },
          confianza: { type: 'integer' },
          porque: { type: 'string' },
        },
        required: ['ref', 'id', 'confianza'],
      },
    },
  },
  required: ['resultados'],
};

// Debajo de esto no sale. Se sube o se baja mirando los aciertos de la sombra.
export const CONFIANZA_MINIMA = 4;

/**
 * Elige una entrada para cada conversacion. Recibe las que ya pasaron los
 * frenos, asi no se gasta un token en las que no iban a salir igual.
 */
export async function elegir(conversaciones, { generar, modelo }) {
  if (!conversaciones.length) return { porRef: {}, uso: { entrada: 0, salida: 0 } };

  const contenido = conversaciones
    .map((c) => {
      const esCliente = c.ficha?.modulo === 'Contacts';
      const partes = [
        `--- ref: ${c.ref}`,
        `es: ${esCliente ? 'cliente, ya compro' : 'posible cliente, todavia no compro'}`,
        `catalogo disponible para esta persona:`,
        catalogo(esCliente ? 'cliente' : 'lead'),
      ];
      const hilo = renderHilo(c.hilo);
      if (hilo) partes.push('lo que se dijeron antes (lo mas viejo primero):', hilo);
      partes.push(`mensaje: ${String(c.last_message__s || '').slice(0, 900)}`);
      return partes.join(SALTO);
    })
    .join('\n\n');

  const { datos, uso } = await generar({
    modelo,
    instrucciones: INSTRUCCIONES,
    contenido: `Elegi la respuesta para estos ${conversaciones.length} mensajes:\n\n${contenido}`,
    esquema: ESQUEMA,
    maxTokens: Math.max(2000, conversaciones.length * 400),
  });

  const porRef = {};
  for (const r of datos.resultados || []) porRef[r.ref] = r;
  return { porRef, uso };
}

/**
 * La decision completa de una conversacion. Devuelve siempre un motivo, para
 * que la sombra se pueda leer y se entienda por que no salio.
 */
export function decidirRespuesta(conversacion, eleccion, { ahora = new Date() } = {}) {
  const motivoFreno = freno(conversacion.last_message__s);
  if (motivoFreno) return { responde: false, motivo: motivoFreno };

  if (!eleccion || !eleccion.id || eleccion.id === 'ninguna') {
    return { responde: false, motivo: 'ninguna entrada contesta esto' };
  }

  const entrada = porId(eleccion.id);
  if (!entrada) return { responde: false, motivo: `id inexistente: ${eleccion.id}` };

  if (entrada.estado !== 'lista') {
    return { responde: false, motivo: `entrada frenada: ${entrada.frenoPorque || 'sin dato'}`, entrada };
  }

  const esCliente = conversacion.ficha?.modulo === 'Contacts';
  if (entrada.publico === 'cliente' && !esCliente) {
    return {
      responde: false,
      motivo: 'la respuesta manda al panel y esta persona todavia no es cliente',
      entrada,
    };
  }
  // La inversa tambien: una respuesta de lead lleva al calendario de venta o
  // al pitch de apertura, y a un cliente eso lo mete en la cadencia equivocada.
  if (entrada.publico === 'lead' && esCliente) {
    return {
      responde: false,
      motivo: 'la respuesta es para posibles clientes y esta persona ya es cliente',
      entrada,
    };
  }

  if ((eleccion.confianza || 0) < CONFIANZA_MINIMA) {
    return { responde: false, motivo: `confianza ${eleccion.confianza}, por debajo de ${CONFIANZA_MINIMA}`, entrada };
  }

  const inicio = esInicio(conversacion, ahora);
  const sinLlamada = noQuiereLlamada(conversacion.last_message__s);
  return {
    responde: true,
    motivo: `${entrada.id} (confianza ${eleccion.confianza})`,
    entrada,
    inicio,
    texto: componer(entrada, { ficha: conversacion.ficha, inicio, sinLlamada }),
  };
}

export { RESPUESTAS };
