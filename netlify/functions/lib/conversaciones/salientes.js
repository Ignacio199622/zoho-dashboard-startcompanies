// El punto ciego: las conversaciones que el equipo contesta rapido.
//
// El agente busca conversaciones donde el ultimo que hablo fue el cliente. Si
// el equipo contesta ANTES de que pase el agente, esa conversacion nunca estuvo
// en ese estado y no se abre seguimiento. Medido sobre casos reales: el 82% se
// contesta en menos de una hora, o sea que con pasadas cada hora el agente se
// perdia la mayoria. Justo las que se contestan rapido y se abandonan, que es
// el caso de David.
//
// Como el CRM no guarda historial (verificado: no hay endpoint), no se puede
// saber que pidio el cliente. Pero SI se puede leer lo que le contestaron, y de
// la respuesta se deduce que habia en juego: de "contame en que estado la
// queres" se deduce una venta.
import { generar } from './gemini.js';
import { MODELO_GEMINI } from './config.js';

const INSTRUCCIONES = `Sos parte del equipo de Start Companies, que abre y administra LLCs en Estados
Unidos para emprendedores de Latinoamerica y España.

Te paso mensajes que el EQUIPO le mando a clientes por WhatsApp. No tenes lo que el cliente
habia preguntado, solo la respuesta. Tu tarea es deducir, de esa respuesta, si del otro lado
habia una oportunidad comercial abierta que puede quedar sin cerrarse.

Marca "hubo_venta": true cuando la respuesta da a entender que el cliente estaba pidiendo
contratar o ampliar algo: se le explica un servicio que todavia no tiene, se le pide un dato
para avanzar con una apertura, se le pasa un precio o un link de pago, se le contesta sobre
abrir otra LLC, sumar un socio, ITIN, contabilidad o una cuenta bancaria nueva, o se lo deriva
a un asesor. Tambien cuando se le pasa el precio de la renovacion anual o el link para pagarla:
una renovacion sin pagar es una venta que se muere igual que cualquier otra.

Marca false cuando la respuesta es de otra cosa: un tramite en curso de algo que el cliente ya
contrato, mandarle un documento, coordinar un horario, contestar una duda de uso, o un
agradecimiento.

Y marca false, sobre todo, cuando el mensaje NO es una respuesta sino que lo iniciamos
nosotros. Se reconocen porque hablan sin que nadie haya preguntado nada: "vi que te pusiste en
contacto", "como no tuvimos respuesta en estos dias", "no queremos ser insistentes", "seguis
evaluando lo de tu LLC?", "para no mandarte info que no te sirve, elegi una opcion", mandar el
brochure de la nada, o presentarse ("soy Santiago, vimos que estas interesado"). Todo eso es la
cadencia de retargeting saliendo sola, no un cliente que pidio algo.

La regla practica: si el mensaje se entiende perfecto sin saber que pregunto el cliente, es que
el cliente no pregunto nada. Marcalo false.

Ojo con dos casos que parecen venta y no lo son:
- Responder sobre la LLC que el cliente YA tiene es soporte, no venta.
- Un mensaje de bienvenida despues de que ya compro es post venta, no venta.

Y uno que parece soporte y SI es venta: cuando la respuesta manda al cliente a resolverlo solo
("desde el mismo panel podes gestionarla") sobre algo que implicaria contratar de nuevo. Ese
es exactamente el caso que hace perder ventas.

Campos:
- hubo_venta: true o false.
- tema: "venta_nueva", "renovacion", "partnership", "referidos", o "otro" si hubo_venta es false.
- resumen: una linea, maximo 90 caracteres, en español rioplatense, diciendo que parece que
  queria el cliente. Solo alfabeto latino.`;

const ESQUEMA = {
  type: 'object',
  properties: {
    resultados: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          hubo_venta: { type: 'boolean' },
          tema: { type: 'string', enum: ['venta_nueva', 'renovacion', 'partnership', 'referidos', 'otro'] },
          resumen: { type: 'string' },
        },
        required: ['ref', 'hubo_venta', 'tema', 'resumen'],
      },
    },
  },
  required: ['resultados'],
};

/**
 * De las conversaciones de esta pasada, cuales hay que mirar.
 *
 * Se descarta lo que no aporta o directamente ensucia:
 *  - las que el agente ya vio pendientes: esas ya siguen su carril
 *  - las que ya estan en seguimiento
 *  - las que ya se revisaron antes, para no pagar dos veces por lo mismo
 *  - los envios masivos: si el mismo texto aparece en varias conversaciones de
 *    la misma pasada, es una difusion y no una respuesta a nadie
 */
/**
 * Huella de una plantilla. Los envios masivos llevan el nombre de cada persona
 * adentro, asi que sin normalizar parecen mensajes distintos y se cuelan como si
 * fueran respuestas. Se saca el saludo, los numeros y los emojis, y lo que queda
 * identifica la plantilla.
 */
export function huella(texto) {
  return String(texto || '')
    .replace(/^[¡!]*\s*hola[^,.!?\n]*[,.!?\n]?/i, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70)
    .toLowerCase();
}

export function candidatas(conversaciones, estado) {
  const vistas = estado.esperandoRespuesta || {};
  const enSeguimiento = estado.ventasAbiertas || {};
  const revisadas = estado.salientesRevisadas || (estado.salientesRevisadas = {});

  const previas = conversaciones.filter(
    (c) =>
      c.conversation_status__s === 'Replied' &&
      c.last_message__s &&
      String(c.last_message__s).trim().length > 30 &&
      !vistas[c.id] &&
      !enSeguimiento[c.id] &&
      !revisadas[c.id]
  );

  // Plantillas conocidas: cualquier texto que ya se vio salir hacia dos personas
  // distintas es un envio masivo, no una respuesta. La lista se arma sola y se
  // guarda entre corridas, asi que a los pocos dias reconoce toda la cadencia
  // sin que nadie la cargue a mano.
  const conocidas = estado.plantillasConocidas || (estado.plantillasConocidas = {});
  const ahora = {};
  for (const c of previas) {
    const h = huella(c.last_message__s);
    ahora[h] = (ahora[h] || 0) + 1;
  }
  for (const [h, n] of Object.entries(ahora)) conocidas[h] = (conocidas[h] || 0) + n;

  return previas.filter((c) => {
    const h = huella(c.last_message__s);
    return ahora[h] < 2 && conocidas[h] < 2;
  });
}

/**
 * Llama al modelo partiendo en tandas cuando hace falta. El presupuesto de
 * salida se comparte con los tokens de razonamiento, asi que no se puede
 * calcular exacto por fila: cuando se corta, se parte al medio y se reintenta.
 */
async function pedir(lista) {
  const contenido = lista
    .map((c) => `--- ref: ${c.id}\nel equipo contesto: ${String(c.last_message__s).slice(0, 600)}`)
    .join('\n\n');

  try {
    return await generar({
      modelo: MODELO_GEMINI,
      instrucciones: INSTRUCCIONES,
      contenido: `Mira estas ${lista.length} respuestas del equipo:\n\n${contenido}`,
      esquema: ESQUEMA,
      maxTokens: Math.max(4000, lista.length * 1200),
    });
  } catch (e) {
    if (!/MAX_TOKENS/.test(e.message) || lista.length === 1) throw e;
    const mitad = Math.ceil(lista.length / 2);
    const [a, b] = await Promise.all([pedir(lista.slice(0, mitad)), pedir(lista.slice(mitad))]);
    return {
      datos: { resultados: [...(a.datos.resultados || []), ...(b.datos.resultados || [])] },
      uso: { entrada: a.uso.entrada + b.uso.entrada, salida: a.uso.salida + b.uso.salida },
    };
  }
}

export async function revisar(conversaciones, estado) {
  const lista = candidatas(conversaciones, estado);
  if (!lista.length) return { hallazgos: [], uso: { entrada: 0, salida: 0 }, miradas: 0 };

  const { datos, uso } = await pedir(lista);

  const porRef = Object.fromEntries((datos.resultados || []).map((r) => [r.ref, r]));
  const hallazgos = [];
  const ahora = new Date().toISOString();

  for (const c of lista) {
    estado.salientesRevisadas[c.id] = ahora;
    const r = porRef[c.id];
    if (!r?.hubo_venta || r.tema === 'otro') continue;
    hallazgos.push({ ...c, clase: { tema: r.tema, categoria: 'venta', resumen: r.resumen } });
  }
  return { hallazgos, uso, miradas: lista.length };
}

/** Para que el archivo de estado no crezca sin freno. */
export function podar(estado, dias = 30) {
  const limite = Date.now() - dias * 86400 * 1000;
  for (const [id, cuando] of Object.entries(estado.salientesRevisadas || {})) {
    if (new Date(cuando).getTime() < limite) delete estado.salientesRevisadas[id];
  }
}
