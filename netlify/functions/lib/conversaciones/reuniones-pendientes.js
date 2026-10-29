// LO QUE QUEDA COLGADO DESPUES DE UNA REUNION.
//
// Dos cosas que medimos el 13-sep-2026 sobre los ultimos 30 dias:
//
//  1. 41 de 134 reuniones (31%) quedaron sin `Status del Meet`. El operador no
//     siempre marca "Asistio / No asistio", y sin esa marca no corre el plan de
//     accion de no-show ("status Meeting"). Aca: 2 horas despues de cada
//     reunion sin estado, un aviso en Slack para que alguien la marque.
//
//  2. 20 de 189 reservas de Cal (10%) se cancelaron. Desde hoy la reunion
//     vieja se cierra sola (Confirmacion = No asiste), pero el lead queda en
//     "Reunion Agendada" para siempre: ninguna cadencia lo vuelve a tocar. Aca:
//     si a los 3 dias no reagendo, vuelve a la secuencia de Agendamiento, la
//     misma que usa la guardia y por la misma puerta (`ponerEnSecuencia`).
//
// Todas las reuniones son del usuario robot, asi que el aviso no puede ir "al
// dueño de la reunion": va al canal de ventas, mencionando al dueño del lead si
// es una persona y si no al que esta de guardia ese dia.
import { get } from './zoho.js';
import { leerLead, ponerEnSecuencia, reglaAgendamientoActiva } from './escritura.js';

export const HORAS_DESPUES_MIN = 2; // desde cuando se reclama el estado
export const HORAS_DESPUES_MAX = 6; // hasta cuando (el cron es cada hora; con esto no se escapa ninguna)
export const DIAS_GRACIA_REAGENDA = 3; // cuanto se espera antes de devolverlo a la secuencia
export const DIAS_MAX_RESCATE = 14; // mas viejo que esto ya no se rescata por aca

const CAMPOS =
  'id,Event_Title,Start_DateTime,End_DateTime,Confirmaci_n,Tipo_de_reuni_n,Status_del_Meet,What_Id,Who_Id,Modified_Time,Hora_local_del_cliente';

const isoZoho = (d) => d.toISOString().slice(0, 19) + '+00:00';
const cerrada = (e) => /^\[(CANCELADA|REAGENDADA)\]/.test(e.Event_Title || '');

async function eventos(criterio) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const j = await get(`Events/search?criteria=${encodeURIComponent(criterio)}&fields=${CAMPOS}&per_page=200&page=${page}`);
    out.push(...(j.data || []));
    if (!j.info?.more_records) break;
  }
  return out;
}

/**
 * Reuniones de venta que ya pasaron (entre 2 y 6 h) y nadie marco si asistio.
 * Se excluyen las cerradas por cancelacion/reagenda y las que el cliente dijo
 * que no venia: ahi no hay nada que marcar.
 */
export async function sinEstado(ahora = new Date()) {
  const desde = new Date(ahora.getTime() - HORAS_DESPUES_MAX * 3600e3);
  const hasta = new Date(ahora.getTime() - HORAS_DESPUES_MIN * 3600e3);
  const lista = await eventos(`((Start_DateTime:greater_equal:${isoZoho(desde)})and(Start_DateTime:less_equal:${isoZoho(hasta)}))`);
  const pend = lista.filter(
    (e) =>
      e.Tipo_de_reuni_n !== 'Clientes' &&
      !e.Status_del_Meet &&
      e.Confirmaci_n !== 'No asiste' &&
      !cerrada(e) &&
      (e.What_Id || e.Who_Id)
  );
  // El dueño del lead, para saber a quien mencionar. Son pocas por hora.
  for (const e of pend) {
    e.lead = e.What_Id?.id ? await leerLead(e.What_Id.id) : null;
  }
  return pend;
}

/**
 * Leads cuya reunion se cayo (el cliente dijo No, pidio reagendar, o cancelo
 * en Cal) hace mas de 3 dias, que siguen en "Reunion Agendada" y no tienen
 * ninguna reunion futura. Esos estan en tierra de nadie.
 */
export async function candidatosARescate(ahora = new Date()) {
  const desde = new Date(ahora.getTime() - DIAS_MAX_RESCATE * 86400e3);
  const hasta = new Date(ahora.getTime() - DIAS_GRACIA_REAGENDA * 86400e3);
  const lista = await eventos(
    `((Confirmaci_n:equals:No asiste)and(Modified_Time:greater_equal:${isoZoho(desde)})and(Modified_Time:less_equal:${isoZoho(hasta)}))`
  );
  const porLead = new Map();
  for (const e of lista) {
    if (e.Tipo_de_reuni_n === 'Clientes' || !e.What_Id?.id) continue;
    if (!porLead.has(e.What_Id.id)) porLead.set(e.What_Id.id, e);
  }
  const out = [];
  for (const [leadId, evento] of porLead) {
    const lead = await leerLead(leadId);
    if (!lead) continue;
    if (String(lead.Lead_Status || '').trim() !== 'Reunión Agendada' && String(lead.Lead_Status || '').trim() !== 'Reunion Agendada') {
      out.push({ lead, evento, decision: { accion: 'ignorar', motivo: `esta en ${lead.Lead_Status || 'sin estado'}, no en Reunion Agendada` } });
      continue;
    }
    // ¿Reagendo? Cualquier reunion futura del lead lo saca de la lista.
    const rel = await get(`Leads/${leadId}/Events?fields=Start_DateTime,Event_Title&per_page=50`);
    const futura = (rel.data || []).find((x) => new Date(x.Start_DateTime) > ahora && !cerrada(x));
    if (futura) {
      out.push({ lead, evento, decision: { accion: 'ignorar', motivo: `ya reagendo para ${futura.Start_DateTime}` } });
      continue;
    }
    out.push({ lead, evento, decision: { accion: 'rescatar', motivo: 'sin reunion futura y en Reunion Agendada' } });
  }
  return out;
}

/** Una pasada. `escribir=false` decide sin tocar el CRM. */
export async function unaPasada({ escribir = false, ahora = new Date() } = {}) {
  const reclamos = await sinEstado(ahora);
  const candidatos = await candidatosARescate(ahora);
  const secuenciaViva = escribir ? await reglaAgendamientoActiva() : null;
  const rescates = [];
  for (const c of candidatos) {
    if (c.decision.accion !== 'rescatar') continue;
    const r = { ...c, ejecucion: null };
    if (escribir) {
      if (!secuenciaViva) r.ejecucion = { ok: false, error: 'la regla de Agendamiento esta apagada' };
      else {
        try {
          r.ejecucion = await ponerEnSecuencia(c.lead.id);
        } catch (e) {
          r.ejecucion = { ok: false, error: String(e.message) };
        }
      }
    }
    rescates.push(r);
  }
  return { reclamos, candidatos, rescates, secuenciaViva };
}
