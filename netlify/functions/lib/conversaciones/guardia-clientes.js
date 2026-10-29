// GUARDIA DE CLIENTES EN CADENCIA.
//
// Saca de la cadencia de venta a los leads que en realidad son clientes: mismo
// telefono (ultimos 9 digitos) o mismo mail que un contacto REAL.
//
// Reemplaza a la regla de Zoho "SC telefono de cliente", que nunca corrio: escucha
// la edicion de `Fecha_Siguiente_Mensaje`, pero las cadencias escriben esa fecha
// desde funciones ("Fecha siguiente mensaje 1", "...2 dias") y en Zoho una edicion
// hecha por una funcion no despierta reglas. Medido el 1-oct-2026 en el timeline:
// 0 ejecuciones en leads con 4 y 8 escrituras de la fecha. Un barrido programado no
// depende de quien escribio la fecha.
//
// Contacto REAL = tiene LLC, tiene un trato, o esta marcado Cliente / Partner. Asi
// una ficha basura que crea el chat de la web ("Zoho Sales iq", sin mail, sin LLC,
// sin ventas) no saca de la cadencia a un posible cliente de verdad.
//
// Mira solo los mensajes programados en las proximas HORIZONTE_H horas: corre cada
// hora, asi que nadie se escapa, y pide pocas paginas al token compartido.
import { get } from './zoho.js';
import { vaciarFechaSiguiente, transicionesDe, ejecutarBaja } from './escritura.js';

// Como se saca al cliente de la cadencia (corregido el 1-oct-2026, tarde):
// vaciar Fecha_Siguiente_Mensaje NO frena las cadencias de venta, porque Zoho
// encola los mensajes al entrar al estado y esa fecha es solo una etiqueta. Lo
// que borra los mensajes programados es SACAR AL LEAD DEL ESTADO con la
// transicion "Desactivar Blueprint" (-> Fuera de flujo). Probado ese dia con un
// lead real: quedo Fuera de flujo y no rebotó al minuto.
// No se usa "Desactivar Retargeting" (la de bajas): lleva a Nurturing, que es
// otra cadencia y sigue mandando mensajes.
const TRANSICION_SALIDA = 'Desactivar Blueprint';
const ESTADOS_SIN_CADENCIA = ['Fuera de flujo', 'No Interesado', 'Convertido', 'Cerrado ganado', 'Cerrado perdido'];

/** Saca un lead de la cadencia. Devuelve { ok, estado, ... } sin tirar. */
async function sacarDeCadencia(caso) {
  // La fecha se vacia SIEMPRE, no solo en Renovacion y Cuenta Bancaria: hay
  // reglas que disparan por Fecha_Siguiente_Mensaje sin mirar el estado (ver
  // control-crm/frenar.js). El 12-oct-2026 cuatro leads quedaron Fuera de flujo
  // con la fecha intacta y hubo que vaciarla a mano.
  if (ESTADOS_SIN_CADENCIA.includes(caso.estado)) {
    const v = await vaciarFechaSiguiente(caso.leadId);
    return { ok: v.ok, estado: caso.estado, yaEstaba: true, error: v.ok ? null : `no quedó vacía la fecha (${v.codigo || v.http})` };
  }
  const transicion = (await transicionesDe(caso.leadId)).find((t) => t.name === TRANSICION_SALIDA);
  if (!transicion) return { ok: false, estado: caso.estado, error: `sin la transición "${TRANSICION_SALIDA}" en este estado` };
  const r = await ejecutarBaja(caso.leadId, transicion.id);
  const salio = r.estado === 'Fuera de flujo';
  // Va despues de la transicion, que dispara reglas que pueden reescribir la fecha.
  const v = salio ? await vaciarFechaSiguiente(caso.leadId) : null;
  const ok = salio && v.ok;
  const error = !salio ? r.mensaje || `quedó en ${r.estado}` : !v.ok ? `salió del flujo pero la fecha quedó en ${v.quedo}` : null;
  return { ok, estado: r.estado, codigo: r.codigo, error };
}

const HORIZONTE_H = 48;
const TOPE_POR_CORRIDA = 20; // si aparecen mas, algo raro paso: se avisa y no se toca

const dig = (x) => String(x || '').replace(/\D/g, '');
const tel9 = (x) => {
  const d = dig(x);
  return d.length >= 8 ? d.slice(-9) : '';
};
const mail = (x) => String(x || '').trim().toLowerCase();
const nombre = (x) => (x == null ? '' : typeof x === 'object' ? x.name ?? '' : String(x));

async function todas(modulo, campos) {
  const out = [];
  let pageToken = null;
  for (let pagina = 1; pagina <= 60; pagina++) {
    const base = `${modulo}?fields=${campos}&per_page=200`;
    const j = await get(pageToken ? `${base}&page_token=${encodeURIComponent(pageToken)}` : `${base}&page=${pagina}`);
    out.push(...(j.data || []));
    if (!j.info?.more_records) break;
    pageToken = j.info.next_page_token || null;
  }
  return out;
}

async function leadsConMensajeProximo(ahora) {
  const hasta = new Date(ahora.getTime() + HORIZONTE_H * 3600e3);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const criterio = `((Fecha_Siguiente_Mensaje:greater_than:${iso(ahora)})and(Fecha_Siguiente_Mensaje:less_than:${iso(hasta)}))`;
  const campos = 'id,Full_Name,Last_Name,Mobile,Phone,Email,Lead_Status,Fecha_Siguiente_Mensaje';
  const out = [];
  for (let pagina = 1; pagina <= 10; pagina++) {
    const j = await get(`Leads/search?criteria=${encodeURIComponent(criterio)}&fields=${campos}&per_page=200&page=${pagina}`);
    out.push(...(j.data || []));
    if (!j.info?.more_records) break;
  }
  return out;
}

/** Una pasada. Con `escribir: false` no toca nada y devuelve lo que haria. */
export async function unaPasada({ escribir = false, ahora = new Date() } = {}) {
  const contactos = await todas('Contacts', 'id,Full_Name,Mobile,Phone,Email,Secondary_Email,Tipo_de_Contacto,Account_Name');
  const tratos = await todas('Deals', 'id,Contact_Name');
  const leads = await leadsConMensajeProximo(ahora);

  const conTrato = new Set(tratos.map((d) => d.Contact_Name?.id).filter(Boolean));
  const esReal = (c) => !!c.Account_Name || conTrato.has(c.id) || ['Cliente', 'Partner'].includes(nombre(c.Tipo_de_Contacto));
  const reales = contactos.filter(esReal);
  const porTel = new Map();
  const porMail = new Map();
  for (const c of reales) {
    for (const t of [c.Mobile, c.Phone]) if (tel9(t)) porTel.set(tel9(t), c);
    for (const m of [c.Email, c.Secondary_Email]) if (mail(m)) porMail.set(mail(m), c);
  }

  const casos = [];
  for (const l of leads) {
    const c = porTel.get(tel9(l.Mobile)) || porTel.get(tel9(l.Phone)) || porMail.get(mail(l.Email));
    if (!c) continue;
    casos.push({
      leadId: l.id,
      lead: l.Full_Name || l.Last_Name || '(sin nombre)',
      estado: nombre(l.Lead_Status),
      proximo: l.Fecha_Siguiente_Mensaje,
      contactoId: c.id,
      contacto: nombre(c.Full_Name),
      tipo: nombre(c.Tipo_de_Contacto),
      llc: nombre(c.Account_Name),
    });
  }

  const demasiados = casos.length > TOPE_POR_CORRIDA;
  if (escribir && !demasiados) {
    for (const caso of casos) {
      try {
        caso.ejecucion = await sacarDeCadencia(caso);
      } catch (e) {
        caso.ejecucion = { ok: false, error: String(e.message || e) };
      }
    }
  }

  return {
    contactosReales: reales.length,
    leadsMirados: leads.length,
    casos,
    demasiados,
    tope: TOPE_POR_CORRIDA,
    horizonteH: HORIZONTE_H,
  };
}
