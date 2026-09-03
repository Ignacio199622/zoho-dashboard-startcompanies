// De una llamada de Fathom al registro de Zoho que le corresponde.
//
// POR QUE EXISTE ESTE ARCHIVO
// El agente cruzaba solo por mail, y el mail esta en el 47% de las llamadas
// (medido sobre 90). El resto quedaba invisible. Se probo un segundo camino,
// por horario contra el modulo Events, y llega al 67%. Juntos: 72%.
//
//   los dos caminos      41%
//   solo por mail         6%
//   solo por horario     26%
//   ninguno              28%   <- estas siguen siendo invisibles
//
// El camino por horario ademas sirve para algo que el mail no puede: marcar
// Status_del_Meet en la reunion, que hoy esta vacio en el 30% de 1.600 events.
import { get } from './zoho-rw.mjs';

const MIN = 60000;
export const VENTANA_MIN = 20;

const enc = (s) => encodeURIComponent(s);
const iso = (d) => new Date(d).toISOString().slice(0, 19) + '+00:00';

/** La reunion de Zoho que corresponde a esta llamada, por cercania de horario.
 *
 * Devuelve null si no hay ninguna o si hay varias: dos reuniones dentro de la
 * misma ventana no se pueden desambiguar por hora, y elegir una al azar seria
 * escribir en el registro de otro cliente. En la medicion fue el 6% de los casos.
 */
export async function eventPorHorario(fecha, ventana = VENTANA_MIN) {
  const t = new Date(fecha).getTime();
  const crit = `((Start_DateTime:greater_equal:${iso(t - ventana * MIN)})and(Start_DateTime:less_equal:${iso(t + ventana * MIN)}))`;
  const j = await get(`Events/search?criteria=${enc(crit)}&fields=id,Event_Title,Start_DateTime,Status_del_Meet,Who_Id,What_Id,$se_module&per_page=50`);
  const d = j.data || [];
  if (!d.length) return { event: null, motivo: 'no hay ninguna reunion en Zoho a esa hora' };
  if (d.length > 1) {
    return { event: null, motivo: `hay ${d.length} reuniones dentro de +-${ventana} min, no se puede saber cual es` };
  }
  return { event: d[0], motivo: `reunion unica a +-${ventana} min` };
}

/** A quien apunta la reunion. What_Id puede ser Lead, Contacto o Cuenta: lo dice $se_module. */
export function aQuienApunta(event) {
  if (!event) return null;
  if (event.Who_Id) return { modulo: 'Contacts', id: event.Who_Id.id, nombre: event.Who_Id.name };
  if (event.What_Id) return { modulo: event.$se_module || 'Leads', id: event.What_Id.id, nombre: event.What_Id.name };
  return null;
}

/** Los tratos que cuelgan de un contacto o de una cuenta (la LLC). */
export async function tratosDe({ contactoId, cuentaId }) {
  const campos = 'id,Deal_Name,Stage,Quien_lo_vendio,Pago,Medios_de_pago,Amount,Closing_Date,Created_Time';
  if (contactoId) {
    const j = await get(`Contacts/${contactoId}/Deals?fields=${campos}`);
    if ((j.data || []).length) return j.data;
  }
  if (cuentaId) {
    const j = await get(`Accounts/${cuentaId}/Deals?fields=${campos}`);
    if ((j.data || []).length) return j.data;
  }
  return [];
}

/**
 * Resuelve una llamada a todo lo que se pueda alcanzar en Zoho.
 * Deja constancia del camino usado en `camino`, para poder auditar despues
 * por que el agente escribio donde escribio.
 */
export async function resolver({ fecha, mail }) {
  const r = { event: null, lead: null, contacto: null, cuenta: null, tratos: [], camino: [] };

  // Camino 1: el mail. Es el mas directo cuando esta.
  if (mail) {
    const l = await get(`Leads/search?criteria=${enc(`(Email:equals:${mail})`)}&fields=id,Full_Name,Email,Description,Owner,Lead_Status`);
    r.lead = (l.data || [])[0] || null;
    const c = await get(`Contacts/search?criteria=${enc(`(Email:equals:${mail})`)}&fields=id,Full_Name,Email,Account_Name`);
    r.contacto = (c.data || [])[0] || null;
    if (r.lead || r.contacto) r.camino.push('mail');
  }

  // Camino 2: el horario. Alcanza llamadas que no tienen mail.
  const e = await eventPorHorario(fecha);
  r.event = e.event;
  r.motivoEvent = e.motivo;
  const ap = aQuienApunta(e.event);
  if (ap) {
    r.camino.push(`horario -> ${ap.modulo}`);
    if (ap.modulo === 'Contacts' && !r.contacto) {
      const c = await get(`Contacts/${ap.id}?fields=id,Full_Name,Email,Account_Name`);
      r.contacto = (c.data || [])[0] || null;
    } else if (ap.modulo === 'Leads' && !r.lead) {
      const l = await get(`Leads/${ap.id}?fields=id,Full_Name,Email,Description,Owner,Lead_Status`);
      r.lead = (l.data || [])[0] || null;
    } else if (ap.modulo === 'Accounts') {
      r.cuenta = { id: ap.id, nombre: ap.nombre };
    }
  }

  if (r.contacto?.Account_Name && !r.cuenta) {
    r.cuenta = { id: r.contacto.Account_Name.id, nombre: r.contacto.Account_Name.name };
  }
  r.tratos = await tratosDe({ contactoId: r.contacto?.id, cuentaId: r.cuenta?.id });
  return r;
}
