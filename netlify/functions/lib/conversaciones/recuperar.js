// RECUPERAR LOS LEADS DE CHAT QUE QUEDARON DORMIDOS
//
// Hasta julio de 2026, el lead que llegaba por WhatsApp o Instagram no entraba
// a ninguna cadencia: la regla que lo mete pide la etiqueta "Sin clasificar" y
// en esa epoca nadie se la ponia. Recien en agosto alguien lo arreglo: entraban
// el 3-11% por mes, y desde agosto entra el 85-91%.
//
// Quedaron **1.011 leads de chat con telefono** tirados en "En Calificación" y
// "Nuevo MQL", desde mayo de 2025. Con el corte de `DESDE` son 580.
//
// Esto los va metiendo a Captación **de a 2 por dia**, decision de Ignacio.
//
// Por que 2 y no 5: cada lead que entra a Captación recibe 5 toques en 6 dias
// habiles, y **3 de esos son WhatsApp** (dia 000, 002 y 006; el 001 y el 004
// son mail). Como las tandas se superponen, el ritmo diario en regimen es
// `leads por dia x 3`:
//
//     5 leads/dia -> 15 WhatsApp/dia
//     2 leads/dia ->  6 WhatsApp/dia   <- el elegido
//
// Sobre un numero que Meta ya bloqueo una vez, 6 por dia es un ritmo que no
// llama la atencion.
//
// Lo unico que se escribe es `Lead_Status = Captación`. De ahi en adelante lo
// maneja la regla `Flujo Captación Crear Editar`, que ya existe y esta activa.
import { get } from './zoho.js';
import { leerLead } from './escritura.js';
import { estaAbierto } from './guardia.js';

/** De donde vino: los canales de conversacion. */
const CHAT = /whats|chat|instagram|messenger/i;

/** Los dos estados donde quedaron varados. */
export const ESTADOS_DORMIDOS = ['En Calificación', 'En Calificacion', 'Nuevo MQL'];

/** El estado que dispara la cadencia. */
const ESTADO_CAPTACION = 'Captación';

export const POR_DIA = 2;

/**
 * Hasta donde se va para atras.
 *
 * El backlog real son 1.011 leads y llega hasta mayo de 2025. Escribirle
 * "contanos que necesitas" a alguien que pregunto hace 16 meses no es
 * recuperar un lead, es ruido: ya no se acuerda de nosotros y lo unico que
 * puede hacer es reportar el numero. El corte deja los de 2026: 580.
 *
 * Para mover la linea se toca esta constante:
 *   '2026-03-01' -> 448  (ultimos 6 meses)
 *   '2026-01-01' -> 580  (este año)          <- el elegido
 *   '2025-01-01' -> 1011 (todo)
 */
export const DESDE = '2026-01-01';

/**
 * Los candidatos, del mas nuevo al mas viejo.
 *
 * Del mas nuevo a proposito: un lead de julio se acuerda de nosotros mucho mas
 * que uno de diciembre. Si el goteo se corta a la mitad, mejor que lo que
 * quedo sin tocar sea lo mas frio.
 */
export async function candidatos(limite = 800) {
  const out = [];
  const campos = 'id,Full_Name,First_Name,Lead_Source,Created_Time,Lead_Status,Mobile,Phone,reserva,Owner';
  const base = `Leads?fields=${campos}&per_page=200&sort_by=Created_Time&sort_order=desc`;
  // Pasados los 2000 registros Zoho rechaza `page` con
  // DISCRETE_PAGINATION_LIMIT_EXCEEDED: de ahi en adelante hay que ir con
  // `page_token`. El CRM tiene mas de 2000 leads, asi que esto no es opcional.
  let token = null;
  let page = 1;
  for (let i = 0; i < 40; i++) {
    const j = await get(token ? `${base}&page_token=${encodeURIComponent(token)}` : `${base}&page=${page}`);
    for (const l of (j.data || [])) {
      if (!CHAT.test(l.Lead_Source || '')) continue;
      if (!ESTADOS_DORMIDOS.includes(l.Lead_Status)) continue;
      if (String(l.Created_Time) < DESDE) continue;   // demasiado viejo, ver DESDE
      if (l.reserva === true) continue;          // ya agendo, no corresponde
      if (!l.Mobile && !l.Phone) continue;       // sin telefono no hay mensaje
      out.push(l);
      if (out.length >= limite) return out;
    }
    if (!j.info?.more_records) break;
    token = j.info?.next_page_token || null;
    if (!token) {
      page++;
      if (page > 10) break; // sin token y pasados los 2000, no hay como seguir
    }
  }
  return out;
}

/**
 * ¿Esta persona ya es cliente?
 *
 * Se pregunta por telefono contra Contactos. Mandarle "contanos que necesitas
 * para tu LLC" a alguien que ya nos pago hace un año es la peor cara que puede
 * poner esto, y el cruce cuesta una llamada.
 */
export async function yaEsCliente(lead) {
  const num = String(lead.Mobile || lead.Phone).replace(/[^\d+]/g, '');
  if (!num) return false;
  const criterio = `((Mobile:equals:${num})or(Phone:equals:${num}))`;
  const j = await get(`Contacts/search?criteria=${encodeURIComponent(criterio)}&fields=id`);
  return (j.data || []).length > 0;
}

/**
 * Los que se van a mover hoy. NO escribe: solo elige y explica.
 *
 * Devuelve tambien los descartados, porque un goteo que descarta en silencio
 * es un goteo que un dia deja de mover a nadie y nadie se entera.
 */
export async function paraHoy({ cuantos = POR_DIA, ahora = new Date() } = {}) {
  if (!estaAbierto(ahora)) {
    return { abierto: false, mueve: [], descartados: [], quedan: null };
  }
  const todos = await candidatos();
  const mueve = [];
  const descartados = [];
  for (const l of todos) {
    if (mueve.length >= cuantos) break;
    if (await yaEsCliente(l)) {
      descartados.push({ ...l, porque: 'ya es cliente' });
      continue;
    }
    mueve.push(l);
  }
  return { abierto: true, mueve, descartados, quedan: todos.length };
}
