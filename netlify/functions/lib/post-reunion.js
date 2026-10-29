/*
 * Post-reunión: nadie se pierde después de una reunión de venta.
 *
 * Pedido de Ignacio, 11-oct-2026. El hueco: el vendedor marca la reunión como
 * "Asistió" (o "Asistió sin interes") y el lead se queda donde estaba (En
 * Calificación, Reunión Agendada, Agendamiento…), que son estados SIN cadencia.
 * Si no compró, nadie le vuelve a escribir. La regla:
 *
 *   A las 24 h de la reunión, si el lead NO tiene trato de Apertura vivo y
 *   sigue en un estado "de antes de la reunión":
 *     - "Asistió sin interes" → Lead_Status = Nurturing (goteo largo de mails).
 *     - "Asistió"             → Lead_Status = Retargeting (la cadencia de venta).
 *
 * LOS QUE TIENEN CADENCIA PROPIA (12-oct, Ignacio: "si es socio, lili, lead
 * magnet o lo que fuese siga su cadencia"). En Zoho hay reglas lili_show /
 * Partnerships_show (calendario de Lili o de socios + Asistió = Si + En
 * Calificación) que mandan 5 mensajes en 10 días hábiles. Si el lead cambia de
 * estado antes, Zoho cancela lo programado. Por eso:
 *   - Asistió: se espera ESPERA_FLUJO_PROPIO_DIAS y recién ahí pasa a su
 *     retargeting: Lili → "Retargeting Lili"; socios → "Retargeting" (la regla
 *     de Socios mira la etiqueta "Form Socios Meta" y arma su flujo).
 *   - Asistió sin interes: va a "No Interesado", que es lo que dispara
 *     lili_sin_interes / Partnerships_sin_interes (su propia cadencia de 10 días).
 * Lead magnet todavía no tiene cadencia en Zoho: cuando la tenga, sumarlo acá.
 *
 * QUÉ NO SE TOCA (solo se reporta):
 *   - Lead ya en Retargeting / Nurturing / No Show / Convertido / No Interesado /
 *     No Calificado / Cliente…: ya lo sigue otro proceso o ya decidió.
 *   - Lead con trato de Apertura no perdido (convertido o por mail): compró.
 *   - Tests y duplicados obvios: nombre "." o sin Mobile ni Phone. A esos no se
 *     los mueve porque Retargeting manda WhatsApp, y sin teléfono no hay a quién.
 *
 * La escritura es `moverLeadA` de conversaciones/escritura.js (mismo PUT que
 * mandarANoShow, con trigger workflow para que arranque la cadencia) y se
 * verifica releyendo. Acá no hay ningún PUT.
 *
 * Todo lo que lee y escribe entra por `deps`, para poder correrlo a mano en
 * seco con otro cliente de Zoho (ver _ensayo_post_reunion.mjs en la raíz).
 */

const H = 3600000;
const isoZoho = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const sinTildes = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export const VENTANA = { desdeH: 24, hastaDias: 21 };
export const MAX_POR_CORRIDA = 15;
// 10 días hábiles de lili_show / Partnerships_show = 14 corridos; uno de margen.
export const ESPERA_FLUJO_PROPIO_DIAS = 15;

// Estados "de antes de la reunión": sin cadencia propia, el lead queda colgado.
// Vacío también entra. Se comparan sin tildes ni mayúsculas.
export const ESTADOS_QUE_SE_MUEVEN = ['En Calificación', 'Fuera de flujo', 'Agendamiento', 'Reunión Agendada', 'Nuevo MQL'];
const MOVIBLE = new Set(ESTADOS_QUE_SE_MUEVEN.map(sinTildes));

// "Asistió sin interes" va SIN tilde en la e en Zoho (ver mapeos.js). Se compara
// normalizado para que el día que alguien lo corrija no se rompa esto.
const DESTINO = { 'asistio': 'Retargeting', 'asistio sin interes': 'Nurturing' };

const CAMPOS_EVENTO = 'id,Event_Title,Start_DateTime,Status_del_Meet,Tipo_de_reuni_n,What_Id,Who_Id,$se_module';
const CAMPOS_LEAD = 'id,Full_Name,Mobile,Phone,Email,Lead_Status,Calendario,Tag,Landing_Origen,Tipo';

/** Reuniones de venta marcadas Asistió / Asistió sin interes entre 24 h y 21 días atrás. */
export async function reunionesParaRevisar(get, ahora = new Date()) {
  const desde = isoZoho(ahora.getTime() - VENTANA.hastaDias * 24 * H);
  const hasta = isoZoho(ahora.getTime() - VENTANA.desdeH * H);
  const criterio =
    `(((Status_del_Meet:equals:Asistió)or(Status_del_Meet:equals:Asistió sin interes))` +
    `and(Start_DateTime:greater_equal:${desde})and(Start_DateTime:less_equal:${hasta}))`;
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const j = await get(`Events/search?criteria=${encodeURIComponent(criterio)}&fields=${CAMPOS_EVENTO}&per_page=200&page=${page}`);
    out.push(...(j.data || []));
    if (!j.info?.more_records) break;
  }
  return out.filter((e) =>
    e.Tipo_de_reuni_n !== 'Clientes' &&
    !/^\[(CANCELADA|REAGENDADA)\]/.test(e.Event_Title || '') &&
    e.What_Id?.id &&
    (e.$se_module || 'Leads') === 'Leads' &&
    DESTINO[sinTildes(e.Status_del_Meet)]);
}

async function leadsPorId(get, ids) {
  const fichas = {};
  for (let i = 0; i < ids.length; i += 100) {
    const tanda = ids.slice(i, i + 100);
    const j = await get(`Leads?fields=${CAMPOS_LEAD}&ids=${tanda.join(',')}`);
    for (const l of j.data || []) fichas[l.id] = l;
  }
  return fichas;
}

const aperturaViva = (d) => /apertura/i.test(d.Type || '') && !/perdid|lost/i.test(d.Stage || '');

/**
 * ¿Ya compró? Un trato de Apertura no perdido en el contacto al que se convirtió
 * el lead, o en un contacto con el mismo mail (el que compró con otra ficha).
 * Devuelve el nombre del trato o null.
 */
async function tratoDeApertura(get, lead) {
  const contactos = new Set();
  const conv = lead.Converted_Contact || lead.$converted_detail?.contact;
  if (conv?.id || typeof conv === 'string') contactos.add(conv.id || conv);
  if (lead.Email) {
    const j = await get(`Contacts/search?email=${encodeURIComponent(lead.Email)}&fields=id`);
    for (const c of j.data || []) contactos.add(c.id);
  }
  for (const cid of contactos) {
    const j = await get(`Contacts/${cid}/Deals?fields=id,Deal_Name,Stage,Type&per_page=50`);
    const d = (j.data || []).find(aperturaViva);
    if (d) return `${d.Deal_Name} (${d.Stage})`;
  }
  return null;
}

const etiquetas = (l) => (l.Tag || []).map((t) => t?.name || t || '');
const esDeSocios = (l) =>
  etiquetas(l).some((t) => /form socios meta/i.test(t)) || /socios/i.test(l.Calendario || '');

// Mismo criterio que las reglas lili_show / Partnerships_show de Zoho.
const flujoPropio = (l) => {
  if (l.Landing_Origen === 'lili-plataforma' || l.Calendario === 'lili-bank-plataforma') return 'lili';
  if ((l.Landing_Origen === 'partners-sc' || ['socios', 'partnerships-con-start-companies'].includes(l.Calendario)) &&
      l.Tipo === 'Posible Partner') return 'socios';
  return null;
};
const esDeLili = (l) => flujoPropio(l) === 'lili' || etiquetas(l).some((t) => /lili/i.test(t)) || /lili/i.test(l.Landing_Origen || '');

/** Adónde va y desde cuándo. null = todavía no (sigue su cadencia propia). */
function destinoDe(lead, ev, ahora) {
  const sinInteres = sinTildes(ev.Status_del_Meet) === 'asistio sin interes';
  const propio = flujoPropio(lead);
  if (propio && sinInteres) return 'No Interesado';
  if (propio && ahora - new Date(ev.Start_DateTime) < ESPERA_FLUJO_PROPIO_DIAS * 24 * H) return null;
  if (sinInteres) return 'Nurturing';
  return esDeLili(lead) ? 'Retargeting Lili' : 'Retargeting';
}

/**
 * Una pasada. No escribe si `aplicar` es false: arma la lista y nada más.
 *
 * deps:
 *   get(path)            lectura de Zoho (tira si falla)
 *   mover(id, estado)    escritura + relectura; solo se llama con aplicar=true
 *   yaProcesado(evId)    ¿este evento ya se resolvió en otra corrida?
 *   marcar(evId, motivo) anota el evento como resuelto (solo con aplicar=true)
 */
export async function unaPasada({ get, mover, yaProcesado = async () => false, marcar = async () => {} }, { aplicar = false, ahora = new Date() } = {}) {
  const r = { reuniones: 0, movidos: [], reportados: [], salteados: [], pendientes: 0, aplicar };

  const eventos = await reunionesParaRevisar(get, ahora);
  r.reuniones = eventos.length;

  // Un lead con dos reuniones en la ventana se decide una vez, por la más nueva:
  // si la última fue "sin interés", esa es la que manda.
  eventos.sort((a, b) => new Date(b.Start_DateTime) - new Date(a.Start_DateTime));
  const porLead = new Map();
  const repetidos = [];
  for (const e of eventos) {
    if (await yaProcesado(e.id)) continue;
    if (porLead.has(e.What_Id.id)) repetidos.push(e);
    else porLead.set(e.What_Id.id, e);
  }
  if (!porLead.size) return r;

  const fichas = await leadsPorId(get, [...porLead.keys()]);

  for (const [leadId, ev] of porLead) {
    const lead = fichas[leadId];
    const base = { evento: ev.id, leadId, reunion: ev.Start_DateTime, meet: ev.Status_del_Meet, nombre: lead?.Full_Name || ev.What_Id.name || leadId };
    const resolver = async (lista, fila) => {
      lista.push(fila);
      if (aplicar) await marcar(ev.id, fila.motivo);
    };

    // Sin ficha visible: convertido (Zoho esconde los convertidos de la lista) o borrado.
    if (!lead) { await resolver(r.salteados, { ...base, estado: '?', motivo: 'lead no visible (convertido o borrado)' }); continue; }
    base.estado = lead.Lead_Status || '(vacío)';
    if (!MOVIBLE.has(sinTildes(lead.Lead_Status)) && lead.Lead_Status) {
      await resolver(r.salteados, { ...base, motivo: `ya está en ${lead.Lead_Status}` });
      continue;
    }

    const destino = destinoDe(lead, ev, ahora);
    if (!destino) {
      // No se marca: mañana se vuelve a mirar, hasta que termine su cadencia.
      r.salteados.push({ ...base, motivo: `sigue su cadencia de ${flujoPropio(lead)} (10 días hábiles)` });
      continue;
    }
    const nombre = String(lead.Full_Name || '').trim();
    if (!nombre || /^[.\s]+$/.test(nombre) || (!lead.Mobile && !lead.Phone)) {
      await resolver(r.reportados, { ...base, destino, motivo: !lead.Mobile && !lead.Phone ? 'sin teléfono (test/duplicado?)' : 'nombre "." (test)' });
      continue;
    }

    if (r.movidos.length >= MAX_POR_CORRIDA) { r.pendientes++; continue; }

    const trato = await tratoDeApertura(get, lead);
    if (trato) { await resolver(r.salteados, { ...base, motivo: `tiene Apertura: ${trato}` }); continue; }

    const fila = { ...base, destino, socios: esDeSocios(lead), motivo: ev.Status_del_Meet };
    if (aplicar) {
      const res = await mover(leadId, destino);
      fila.ok = res.ok;
      fila.quedo = res.quedo?.Lead_Status;
      if (!res.ok) fila.error = res.error || `quedó en ${fila.quedo || '?'}`;
      // Si falló no se marca: se reintenta mañana, y el aviso a Slack lo muestra.
      // Salvo que Zoho no ofrezca ninguna transición: eso no se arregla solo y
      // repetirlo cada día solo tapa el canal. Va una vez a "mirar a mano".
      if (res.ok) await marcar(ev.id, `${destino} ok`);
      else if (res.via === 'sin-transicion') {
        await resolver(r.reportados, { ...base, destino, motivo: `está en un blueprint que no deja pasar a ${destino}: moverlo a mano` });
        continue;
      }
    }
    r.movidos.push(fila);
  }

  // Las reuniones viejas de un lead que ya se decidió por la nueva.
  if (aplicar) for (const e of repetidos) await marcar(e.id, 'otra reunión del mismo lead');
  return r;
}
