// Extraccion de tareas del equipo a partir de una reunion interna.
//
// No lo hace Fathom solo: sus action items vienen sin responsable y con ruido
// de transcripcion. Lo que aporta este paso es el roster (quien hace que) y la
// lista de lo que ya esta abierto, para no duplicar.
import { MAX_CARACTERES_TRANSCRIPCION, TITULOS_DE_CLIENTE } from './config.js';
import { pensar } from './cerebro.js';
import { transcripcionATexto } from './fathom.js';
import { rosterATexto } from './equipo.js';

// Los responsables ya no viven aca: salen de la tabla "Equipo y roles" de Notion.
export const AREAS = ['WhatsApp y CRM', 'Campañas y retargeting', 'Panel y desarrollo', 'Ventas', 'Marketing', 'Datos', 'Operaciones', 'Renovaciones', 'Equipo'];
// "WhatsApp y CRM" es la plomeria del CRM (conversion, blueprint, campos, deduplicacion,
// chatbot). "Campanas y retargeting" es todo lo que SALE hacia el lead: flujos, cadencias,
// nurturing, templates, creditos y los numeros de WhatsApp usados para campanas.
export const URGENCIAS = ['Ahora', 'Esta semana', 'Después'];
// La biblioteca usa los mismos temas que las decisiones, mas las herramientas
// (Relay, Zoho, Notion, TimelinesAI): buena parte de lo que se explica es "como se usa X".
export const TEMAS = ['WhatsApp y CRM', 'Campañas y retargeting', 'Panel y desarrollo', 'Ventas', 'Marketing', 'Datos', 'Operaciones', 'Renovaciones', 'Precios', 'Herramientas', 'Equipo'];

// Las llamadas de venta no generan tareas de equipo: esas van al CRM.
// La lista vive en config.js porque el Coach usa la misma.
export { TITULOS_DE_CLIENTE };

export const esquemaCon = (responsables) => ({
  type: 'object',
  properties: {
    es_reunion_interna: {
      type: 'boolean',
      description: 'false si es una llamada de venta o con un cliente, en vez de una reunión del equipo',
    },
    tareas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tarea: { type: 'string', description: 'Una línea, en infinitivo: "Corregir...", "Mandar...". Nunca en segunda persona ("Corregí", "Mandale").' },
          responsable: { type: 'string', enum: responsables },
          area: { type: 'string', enum: AREAS },
          urgencia: { type: 'string', enum: URGENCIAS },
          contexto: { type: 'string', description: 'Una línea con el porqué o el cómo se resuelve' },
        },
        required: ['tarea', 'responsable', 'area', 'urgencia', 'contexto'],
      },
    },
    decisiones: {
      type: 'array',
      description: 'Definiciones que quedaron tomadas y NO son una tarea de nadie. Solo si es una definición real, no una opinión.',
      items: {
        type: 'object',
        properties: {
          decision: { type: 'string', description: 'La definición, en una línea' },
          tema: { type: 'string', enum: TEMAS },
          por_que: { type: 'string' },
          quien: { type: 'string', description: 'Quién la tomó' },
        },
        required: ['decision', 'tema', 'por_que', 'quien'],
      },
    },
    explicaciones: {
      type: 'array',
      description: 'Procedimientos que alguien EXPLICÓ en la reunión: cómo se hace algo, con pasos o condiciones. No lo que se mencionó al pasar.',
      items: {
        type: 'object',
        properties: {
          tema: { type: 'string', description: 'Cómo se llama lo que se explicó, en una línea: "Cómo se aplica Relay en una LLC"' },
          area: { type: 'string', enum: TEMAS },
          como_se_hace: { type: 'string', description: 'Los pasos o el criterio, en las palabras de la call. Tiene que servirle a alguien que no estuvo y que recién entra.' },
          cuando_aplica: { type: 'string', description: 'En qué caso se usa y en cuál no' },
          quien: { type: 'string', description: 'Quién lo explicó' },
          amplia: { type: 'string', description: 'Si esto corrige o amplía una ficha ya existente, el Tema exacto de esa ficha. Si es nueva, cadena vacía.' },
        },
        required: ['tema', 'area', 'como_se_hace', 'cuando_aplica', 'quien', 'amplia'],
      },
    },
    ya_hechas: {
      type: 'array',
      description: 'Tareas de la lista de abiertas que en esta reunión se dijo que ya están resueltas',
      items: {
        type: 'object',
        properties: {
          tarea_abierta: { type: 'string', description: 'El texto exacto de la lista de tareas abiertas' },
          por_que: { type: 'string' },
        },
        required: ['tarea_abierta', 'por_que'],
      },
    },
  },
  required: ['es_reunion_interna', 'tareas', 'decisiones', 'explicaciones', 'ya_hechas'],
});

function instrucciones(abiertas, roster, decisiones = [], fichas = []) {
  const fichasPrevias = fichas.length
    ? fichas.map((f) => `- ${f.tema}`).join(String.fromCharCode(10))
    : '(ninguna todavía)';
  const decisionesPrevias = decisiones.length
    ? decisiones.map((d) => '- ' + d).join(String.fromCharCode(10))
    : '(ninguna todavía)';
  const lista = abiertas.length
    ? abiertas.map((t) => `- ${t.tarea}${t.responsable ? ` (${t.responsable})` : ''}`).join('\n')
    : '(no hay ninguna todavía)';
  return `Sos el asistente de operaciones de Start Companies, que abre LLCs en Estados Unidos para latinoamericanos.
Te paso la transcripción de una reunión. Extraé las tareas concretas que quedaron.

QUIÉN HACE QUÉ
${roster}

REGLAS
- Si esto es una llamada de venta o con un cliente y no una reunión interna del equipo, poné es_reunion_interna en false y devolvé las listas vacías.
- Asigná el responsable por lo que se dijo en la conversación. Si no queda claro, asignalo por el área. Si tampoco, poné "Sin asignar". No adivines.
- CUIDADO CON LOS DOS IGNACIOS: son personas distintas y en las calls a los dos les dicen "Ignacio" o "Nacho". Distinguilos por lo que hacen, no por el nombre.
- La transcripción tiene errores y a veces atribuye frases a la persona equivocada. Deducí quién habla por el contenido, no por el nombre del hablante.
- No inventes tareas. Si algo se mencionó pero no quedó como acción, dejalo afuera.
- Urgencia "Ahora" solo si alguien dijo hoy o mañana. "Esta semana" si hay una fecha cercana. Si no, "Después".
- El contexto tiene que servirle a alguien que no estuvo en la llamada: por qué hay que hacerlo o cómo se resuelve.
- Escribí la tarea en infinitivo y sin tutear a nadie: "Revisar el tracking", no "Revisá el tracking".
- Agrupá. Si en la reunión se hablaron cinco detalles del mismo tema, es una tarea con contexto, no cinco tareas.

NO DUPLIQUES. Estas tareas ya están abiertas en el tablero. Si en la reunión se habló de una de ellas, NO la vuelvas a crear:
${lista}

Si en la reunión se dijo que alguna de esas ya está resuelta, ponela en ya_hechas con el texto exacto de la lista.

DECISIONES. Aparte de las tareas, anotá las definiciones que quedaron tomadas y que no son trabajo de nadie: una regla, un precio, una política, una elección de herramienta. Ejemplo: "la renovación no es gratis, es plazo de pago a un año para single member en Florida, Wyoming y Nuevo México". Solo definiciones reales, no opiniones ni ideas sueltas. Estas ya están registradas, no las repitas:
${decisionesPrevias}

BIBLIOTECA. Aparte, anotá lo que alguien EXPLICÓ: cómo se hace algo, cómo se usa una herramienta, qué criterio se sigue en un caso. Es lo que hoy se pierde: no es tarea de nadie ni una decisión nueva, es conocimiento que uno del equipo tiene y los demás no.
- Solo si alguien lo explica de verdad, con pasos o condiciones, aunque sea al pasar dentro de otro tema. Si el tema apenas se nombra, no va.
- Escribilo para alguien que recién entra al equipo y no estuvo en la llamada. Nada de "lo que dijo Adrián": contá el procedimiento, no quién habló.
- Una explicación por tema. Si se explicaron tres cosas distintas, son tres fichas.
- Si lo que se explicó corrige o amplía una de estas fichas que ya existen, poné su Tema exacto en "amplia" y no crees una ficha nueva:
${fichasPrevias}`;
}

export async function extraerTareas(reunion, abiertas, gente, decisiones = [], fichas = []) {
  const roster = rosterATexto(gente);
  const responsables = [...gente.map((p) => p.nombre), 'Sin asignar'];
  const texto = transcripcionATexto(reunion).slice(0, MAX_CARACTERES_TRANSCRIPCION);
  const resumen = reunion.default_summary?.markdown_formatted || '';
  const contenido = `Reunión: ${reunion.title}
Fecha: ${reunion.recording_start_time}
Participantes: ${(reunion.calendar_invitees || []).map((i) => i.email).join(', ') || 'sin datos'}

RESUMEN DE FATHOM
${resumen.slice(0, 4000)}

TRANSCRIPCIÓN
${texto}`;

  return pensar({
    instrucciones: instrucciones(abiertas, roster, decisiones, fichas),
    contenido,
    esquema: esquemaCon(responsables),
    maxTokens: 8000,
  });
}
