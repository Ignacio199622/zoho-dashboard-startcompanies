// Las reglas de Control CRM. Cada una devuelve lo que esta mal HOY y, cuando
// hay foto anterior, lo que aparecio DESDE la ultima corrida.
//
// Todo es lectura. Ninguna regla escribe en Zoho.
import { paginado, get } from './zoho.js';

const ZOHO_UI = 'https://crm.zoho.com/crm/tab';
export const link = (modulo, id) => `${ZOHO_UI}/${modulo}/${id}`;

const normTel = (t) => String(t || '').replace(/\D/g, '').slice(-10);
const dias = (d) => (Date.now() - new Date(d)) / 864e5;
const vacio = (v) => v === null || v === undefined || v === '';
// Una fuente transitoria de integracion (WHATSAPP - ..., Chatbot) o "Sin dato histórico" no es un canal.
const sinCanal = (v) => vacio(v) || /^WHATSAPP|^WhatsApp - |wwebjs|^Chatbot|Bot$|^TimelinesAI|^Sin dato|^Sin origen|^No lo sé|^Landing Page$|^Web Organic$/.test(String(v));

// Regla 8: cuantos dias de historia se miran para saber el ritmo de un canal, y
// cuantos leads tiene que haber traido en esos dias para que valga la pena
// vigilarlo. Debajo de eso el promedio no dice nada y solo hace ruido.
const VENTANA = 28;
const MINIMO_CANAL = 10;

// Regla 9: cuantas horas puede quedarse quieto un lead de Meta antes de avisar.
// Seis encaja con los dos avisos: el que carga el formulario a la manana sale en
// el de las 16:30 del mismo dia, y el de la tarde o la noche en el de las 9:00.
// Con doce, el de la manana se perdia el aviso de la tarde y dormia hasta el
// otro dia, que es justo lo que hay que evitar con un lead recien entrado.
const HORAS_SIN_CONTACTO = 6;

// Regla 10: desde cuando y hasta cuando se considera "no salio". Arriba de 30
// dias ya lo cuenta la regla 7 como stock viejo abandonado; entre 1 y 30 es la
// falla de esta semana, la que todavia se puede destrabar.
const FALLA_DESDE = 1;
const FALLA_HASTA = 30;

// Regla 10, Nurturing en mensaje 0. Al entrar, la funcion "Fecha siguiente
// mensaje 15 dias" anota +15 dias CORRIDOS, pero el mensaje 1 lo programa la
// regla a 15 dias HABILES (~21 corridos), y la variante "Desactivar
// Retargeting" ni siquiera tiene el del dia 15: el siguiente sale a los 30
// habiles. Medido el 26-oct-2026: los 166 "no salieron" eran todos esto.
// Se cuenta desde la entrada (fecha anotada - 15 corridos) en dias habiles,
// con un dia de tolerancia.
const sumarHabiles = (desde, n) => {
  const d = new Date(desde);
  while (n > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) n--;
  }
  return d;
};
const nurturingTodaviaNoToca = (l) => {
  if (l.Lead_Status !== 'Nurturing' || String(l.N_mero_de_mensaje) !== '0') return false;
  const entrada = new Date(new Date(l.Fecha_Siguiente_Mensaje) - 15 * 864e5);
  const toca = sumarHabiles(entrada, l.Desactivar_Retargeting === true ? 30 : 15);
  return Date.now() < toca.getTime() + 864e5;
};

const SINGLE = /single|un solo miembro|unipersonale/i;
const MULTI = /multi|m.ltiples/i;
const FASES_CERRADAS = new Set([
  'Apertura Activa', 'Apertura Perdida', 'Cuenta Bancaria Finalizada',
  'Cuenta Bancaria Perdida', 'Renovación completa',
]);

/** Baja del CRM todo lo que necesitan las reglas, una sola vez. */
export async function leerCrm() {
  const leads = await paginado('Leads',
    'id,Full_Name,Email,Phone,Mobile,Lead_Status,Lead_Source,Owner,Retargeting,Fecha_Siguiente_Mensaje,Created_Time,'
    // `Tipo` y el id de Meta en Tratos los usan las reglas del puente (src/puente.js).
    + 'Nombre_retargeting,N_mero_de_mensaje,Last_Activity_Time,leadchain0__Social_Lead_ID,Tipo,'
    // Agregados el 13-sep-2026 para las reglas `sin-retargeting-*`: el historial dice que
    // flujos corrieron, `reserva` si tuvo reunion, `Tag` de donde entro, `Modified_Time`
    // para no avisar de un lead que cambio de estado hace un minuto.
    + 'Historial_de_Flujos,reserva,flujo_normal,Tag,Modified_Time,'
    // 26-oct-2026: la regla 10 lo necesita para saber que variante de Nurturing corre.
    + 'Desactivar_Retargeting');
  const contactos = await paginado('Contacts', 'id,Full_Name,Email,Phone,Mobile,Account_Name,Tipo_de_Contacto,Anuncio');
  const llcs = await paginado('Accounts',
    'id,Account_Name,Estructura_Societaria,Estado_de_Registro,Owner,Created_Time,'
    // `Socio` es el lookup al modulo Partners: dice quien trajo la LLC. Lo usa la regla 17.
    + 'Fecha_renovaci_n_estatal,Fecha_renovaci_n_federal,Socio');
  const tratos = await paginado('Deals',
    'id,Deal_Name,Account_Name,Contact_Name,Type,Stage,Amount,Owner,Created_Time,Modified_Time,'
    // Layout y Anuncio los usan las tres reglas de linea de negocio y atribucion.
    // `Partner` y `Lead_Source` los usa la regla 17 (18-sep-2026: el canal vive en Lead_Source).
    + 'Layout,Anuncio,leadchain0__Social_Lead_ID,Partner,Landing_Origen,'
    // Agregados el 9-sep-2026 para la regla `tratos-nuevos`: sin estos no se puede
    // decir de que anuncio vino la venta ni si Meta va a poder atribuirla.
    + 'Lead_Source,Referido,Calendario,fbc,fbclid,Campa_a_Meta,Conjunto_de_anuncios,creativeId,Url_del_anuncio');
  const props = await paginado('Propietarios_LLC', 'id,Name,LLC,Created_Time');
  const events = await paginado('Events', 'id,Event_Title,Start_DateTime,What_Id,Who_Id,Status_del_Meet,Owner');
  const fusiones = await leerFusiones();
  const sinRetargeting = await leerSinRetargeting(leads, events);
  return { leads, contactos, llcs, tratos, props, events, fusiones, sinRetargeting };
}

// Regla 20: cuantos dias para atras se revisan las fusiones. Tres cubre el fin
// de semana, que el cierre no corre; la foto evita que el mismo caso se avise
// dos veces. Y cuantos minutos entre el renombre y la fusion para que cuente
// como "lo renombro para poder fusionarlo": Zoho exige nombre y mail iguales,
// asi que el que fuerza una fusion edita y convierte de corrido.
const DIAS_FUSION = 3;
const MINUTOS_RENOMBRE = 10;
const HORAS_TELEFONO = 24;

const fecha = (s) => new Date(s).getTime();
const palabras = (n) => new Set(normNombre(n).split(' ').filter((w) => w.length > 2));
// "Mati" y "Matias Levy" o "Dany!" y "Daniel" son la misma persona: alcanza con que
// dos palabras compartan las primeras tres letras. Lo que se busca es "Enrique
// Bernabei" contra "Gaston Petruccelli". Los leads que crea WhatsApp entran como
// "New WhatsApp contact: <perfil>" y ese no es un nombre: no se comparan.
const otraPersona = (a, b) => {
  if (/^new whatsapp contact/i.test(String(a || ''))) return false;
  const pa = [...palabras(a)]; const pb = [...palabras(b)];
  if (!pa.length || !pb.length) return false;
  return !pa.some((x) => pb.some((y) => x.slice(0, 3) === y.slice(0, 3)));
};

/**
 * Lee el timeline de cada lead fusionado en los ultimos dias y de la ficha que
 * lo recibio. Es lo unico que deja huella de una fusion forzada: el 13-ago-2026
 * el lead de Enrique Bernabei se renombro a "Gaston Petruccelli" un segundo
 * antes de fusionarlo en la ficha de Gaston, y la ficha habia tomado el celular
 * de Enrique una hora antes. Un mes despues Gaston tenia la conversacion de otro.
 * Despues de la fusion los dos registros quedan con el mismo nombre y no hay
 * forma de verlo mirando los datos: solo el timeline conserva el nombre viejo.
 *
 * Ojo: el renombre lo hace Zoho solo cada vez que un lead se fusiona en una ficha
 * existente (le copia nombre y mail de la ficha un segundo antes del converted),
 * asi que el "antes" aparece en toda fusion. Se avisa solo cuando el nombre viejo
 * es de OTRA persona; "Mati" -> "Matias Levy" no se avisa.
 *
 * Son pocas llamadas: los leads convertidos en 3 dias son unos pocos, y por cada
 * uno se piden dos timelines.
 */
// `desde`/`hasta` en dias hacia atras. `hasta` existe para probar la regla contra
// un caso viejo sin recorrer todo lo de despues.
export async function leerFusiones(desdeDias = DIAS_FUSION, hastaDias = 0) {
  const iso = (d) => new Date(Date.now() - d * 864e5).toISOString().replace(/\.\d{3}Z$/, '-00:00');
  const crit = hastaDias
    ? `((Modified_Time:greater_than:${iso(desdeDias)})and(Modified_Time:less_than:${iso(hastaDias)}))`
    : `(Modified_Time:greater_than:${iso(desdeDias)})`;
  const r = await get(`Leads/search?criteria=${encodeURIComponent(crit)}&converted=true&per_page=200`);
  const out = [];
  for (const l of r.data || []) {
    const contacto = l.Converted_Contact || l.$converted_detail?.contact;
    const cid = contacto?.id || contacto;
    if (!cid) continue;
    const tl = (await get(`Leads/${l.id}/__timeline?per_page=40`)).__timeline || [];
    const conv = tl.find((e) => e.action === 'converted');
    if (!conv) continue;
    const t = fecha(conv.audited_time);
    // Renombre justo antes de fusionar.
    let antes = null; let fuente = null;
    for (const e of tl) {
      if (e.action !== 'updated' || t - fecha(e.audited_time) > MINUTOS_RENOMBRE * 6e4 || fecha(e.audited_time) > t) continue;
      const nombre = {};
      for (const f of e.field_history || []) if (f.api_name === 'First_Name' || f.api_name === 'Last_Name') nombre[f.api_name] = f._value?.old || '';
      if (!Object.keys(nombre).length) continue;
      antes = `${nombre.First_Name || ''} ${nombre.Last_Name || ''}`.trim();
      fuente = e.source;
    }
    // La ficha destino cambio de telefono ese dia, ANTES de la fusion. Se dejan
    // afuera los ultimos 60 segundos: al fusionar, Zoho mismo le copia el telefono
    // del lead a la ficha (crm_ui, un segundo antes del converted) y eso es normal.
    const tlc = (await get(`Contacts/${cid}/__timeline?per_page=40`)).__timeline || [];
    let telefono = null;
    for (const e of tlc) {
      const dt = t - fecha(e.audited_time);
      if (e.action !== 'updated' || dt > HORAS_TELEFONO * 36e5 || dt < 6e4) continue;
      const f = (e.field_history || []).find((x) => x.api_name === 'Mobile' || x.api_name === 'Phone');
      if (!f) continue;
      // Ultimos 8 digitos: un +54 011 15 que se corrige a +54 9 11 es el mismo numero.
      const viejo = normTel(f._value?.old).slice(-8); const nuevo = normTel(f._value?.new).slice(-8);
      if (viejo && nuevo && viejo !== nuevo) { telefono = { de: f._value?.old, a: f._value?.new, fuente: e.source, quien: e.done_by?.name }; break; }
    }
    out.push({
      lead: { id: l.id, nombre: l.Full_Name, mobile: l.Mobile, creado: l.Created_Time },
      contacto: { id: String(cid), nombre: contacto?.name || '' },
      cuando: conv.audited_time,
      quien: conv.done_by?.name || l.Modified_By?.name || 'la cuenta compartida',
      antes: antes && otraPersona(antes, l.Full_Name) ? { nombre: antes, fuente } : null,
      telefono,
    });
  }
  return out;
}

// Reglas 21 y 22: que posible cliente anda sin retargeting, y por que.
//
// Desde el rediseño de Adrian (sep-2026) cada cadencia es una regla que dispara
// cuando `Lead_Status` toma un valor y deja los mensajes en acciones programadas.
// Y cada una de esas reglas escribe su nombre en `Historial_de_Flujos` al arrancar.
// Eso da un test barato y firme: si el lead esta en Retargeting y el historial no
// dice "Retargeting", el flujo nunca arranco. Verificado el 13-sep-2026 sobre 78
// leads: todos entraron por una transicion automatica del blueprint entre el 12 y
// el 26-ago y ninguno recibio un mensaje despues. Desde el 1-sep las transiciones
// si arrancan el flujo, asi que lo que se ve es stock.
//
// Para poder afirmar "0 mensajes desde el X" se lee el timeline de cada candidato
// (una llamada por lead). El timeline tambien deshace un falso positivo: los leads
// anteriores al campo Historial (jul-ago) siguen recibiendo mensajes del motor
// viejo y no tienen historial. Si les salio algo en los ultimos dias, no son caso.
const FLUJO_DEL_ESTADO = {
  'Captación': 'Captación', 'Agendamiento': 'Agendamiento', 'Comercial': 'Comercial',
  'No Show': 'No Show', 'Retargeting': 'Retargeting', 'Retargeting Lili': 'Retargeting Lili',
  'Nurturing': 'Nurturing',
};
// Cuantos dias puede pasar un flujo vivo sin mandar nada. Retargeting tiene huecos
// de hasta 4 dias habiles entre mensajes; Nurturing de 15, por eso no se mide.
const SILENCIO_MAXIMO = {
  'Captación': 5, 'Agendamiento': 5, 'Comercial': 5, 'No Show': 4,
  'Retargeting': 9, 'Retargeting Lili': 9,
};
// Estados que no tienen ninguna cadencia. `Fuera de flujo` no esta a proposito:
// ahi se llega apretando "Desactivar Blueprint", es una decision de una persona.
const ESTADOS_SIN_FLUJO = new Set([
  'En Calificación', 'Reunión Agendada', 'Nuevo MQL', 'Attempted to Contact',
  'No Interesado', 'No Calificado',
]);
const DIAS_VENTANA_RT = 60;
const MAX_TIMELINES_RT = 160;

// Lo que manda el flujo (WhatsApp, mail, accion de transicion) contra lo que manda
// una persona a mano desde el chat (`Message_template_sent`). Se cuentan aparte:
// que alguien le escriba a mano no significa que el retargeting ande.
const ENVIO = /^(messagenotificationsent|email_notification_sent|transitionaction)$/;
const A_MANO = /^Message_template_sent$/;
const quien = (n) => (n === 'Start Companies Staff' ? 'la integración' : n);
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fechaCorta = (s) => { const d = new Date(s); return `${d.getDate()}-${MESES[d.getMonth()]}`; };
const fuenteCorta = (f) => (/whatsapp/i.test(f || '') ? 'WhatsApp' : f || 'sin canal');

/** Lee el timeline y cuenta que paso desde que el lead entro al estado actual. */
async function historiaDelEstado(lead) {
  const tl = ((await get(`Leads/${lead.id}/__timeline?per_page=100`)).__timeline || []).slice().reverse();
  const entradas = [];
  for (const e of tl) {
    const f = (e.field_history || []).find((x) => x.api_name === 'Lead_Status');
    if (!f || f._value?.new !== lead.Lead_Status || f._value?.old === lead.Lead_Status) continue;
    const tr = e.automation_details?.rule?.transistion_name;
    const como = e.action === 'automatic_transition' && tr ? `pasó solo: ${tr}`
      : e.source === 'blueprint' && e.done_by?.name ? `lo pasó ${quien(e.done_by.name)}`
        : e.source === 'workflow' ? `lo puso la regla ${e.automation_details?.rule?.name || ''}`.trim()
          : e.source === 'custom_function' ? 'lo puso una función'
            : e.done_by?.name ? `lo pasó ${quien(e.done_by.name)}` : '';
    entradas.push({ cuando: e.audited_time, como });
  }
  // El rebote: el blueprint lo saco del estado y una regla lo devolvio en el mismo
  // segundo. Ahi la entrada que vale es la ANTERIOR al rebote, la que arranco el flujo.
  let rebote = null;
  for (let i = 0; i < tl.length; i++) {
    const e = tl[i];
    if (e.action !== 'automatic_transition') continue;
    const f = (e.field_history || []).find((x) => x.api_name === 'Lead_Status');
    if (!f || f._value?.old !== lead.Lead_Status) continue;
    const vuelta = tl.slice(i + 1, i + 6).find((v) => v.source === 'workflow'
      && (v.field_history || []).some((x) => x.api_name === 'Lead_Status' && x._value?.new === lead.Lead_Status));
    if (vuelta) rebote = { cuando: e.audited_time, a: f._value?.new, regla: vuelta.automation_details?.rule?.name || 'Activar flujo ' + lead.Lead_Status };
  }
  const entrada = rebote
    ? [...entradas].reverse().find((x) => x.cuando < rebote.cuando) || entradas[0] || null
    : entradas[entradas.length - 1] || null;
  const desde = entrada ? entrada.cuando : lead.Created_Time;
  const envios = tl.filter((e) => e.audited_time > desde && ENVIO.test(e.action)).map((e) => e.audited_time);
  const aMano = tl.filter((e) => e.audited_time > desde && A_MANO.test(e.action)).map((e) => e.audited_time);
  return {
    entrada, desde, envios, rebote,
    ultimoEnvio: envios.length ? envios[envios.length - 1] : null,
    ultimoAMano: aMano.length ? aMano[aMano.length - 1] : null,
  };
}

/**
 * Devuelve dos listas de casos ya redactados: `flujo` (la automatizacion fallo) y
 * `estado` (el lead esta en un estado que no tiene cadencia y alguien lo tiene que
 * mover). Solo leads creados en los ultimos 60 dias: lo anterior es stock para una
 * limpieza, no una alerta diaria.
 */
export async function leerSinRetargeting(leads, events) {
  const ultimaReunion = new Map();
  for (const e of events) {
    const id = e.What_Id?.id; if (!id || !e.Start_DateTime) continue;
    const prev = ultimaReunion.get(id);
    if (!prev || e.Start_DateTime > prev.Start_DateTime) ultimaReunion.set(id, e);
  }
  const candidatos = leads.filter((l) =>
    dias(l.Created_Time) <= DIAS_VENTANA_RT && dias(l.Created_Time) * 24 >= 1
    && !vacio(l.Lead_Status)
    // El de WhatsApp sin numero real ya lo cuenta la regla 10b, y el que tiene el
    // telefono de un cliente esta frenado a proposito.
    && !/^[A-Z]{2}\.\d+$/.test(String(l.Mobile || l.Phone || ''))
    && !(l.Tag || []).some((t) => /telefono de un cliente/i.test(t?.name || ''))
    // Cuenta Bancaria sigue con el motor viejo por fecha, que no escribe historial.
    && l.Tipo !== 'Cuenta Bancaria'
  ).sort((a, b) => new Date(b.Created_Time) - new Date(a.Created_Time));

  const flujo = []; const estado = [];
  let timelines = 0;
  for (const l of candidatos) {
    const est = l.Lead_Status;
    const hist = l.Historial_de_Flujos || [];
    const nombre = l.Full_Name || 'sin nombre';
    const base = { link: link('Leads', l.id) };
    const f = FLUJO_DEL_ESTADO[est];

    if (f) {
      const arranco = hist.includes(f);
      // Flujo vivo: la fecha del proximo mensaje siempre esta adelante. Pasada mas de
      // 3 dias y el lead sigue en el mismo estado, el flujo termino y nadie lo movio.
      const vencido = SILENCIO_MAXIMO[est] && l.Fecha_Siguiente_Mensaje && dias(l.Fecha_Siguiente_Mensaje) > 3;
      if (arranco && !vencido) continue;
      if (dias(l.Modified_Time) * 24 < 1) continue;   // cambio de estado hace un rato: dejarlo arrancar
      if (timelines >= MAX_TIMELINES_RT) continue;
      timelines++;
      const h = await historiaDelEstado(l);
      const callado = h.ultimoEnvio ? dias(h.ultimoEnvio) : dias(h.desde);
      // Le salio algo hace poco: el flujo anda (motor viejo sin historial, o se reactivo).
      if (h.ultimoEnvio && callado <= (SILENCIO_MAXIMO[est] || 9)) continue;
      const dSince = `${est} desde el ${fechaCorta(h.desde)}${h.entrada?.como ? ` (${h.entrada.como})` : ''}`;
      let motivo;
      if (h.rebote) {
        motivo = `el flujo terminó · el ${fechaCorta(h.rebote.cuando)} el blueprint lo pasó a ${h.rebote.a} y la regla ${h.rebote.regla} lo devolvió`;
      } else if (!arranco && !h.envios.length) {
        motivo = `el flujo de ${f} nunca arrancó`;
      } else if (h.ultimoEnvio) {
        motivo = `el flujo se cortó: último mensaje el ${fechaCorta(h.ultimoEnvio)}`;
      } else {
        motivo = 'el flujo terminó y nadie lo movió';
      }
      const mano = h.ultimoAMano ? ` (a mano le escribieron el ${fechaCorta(h.ultimoAMano)})` : '';
      flujo.push({ ...base, id: `srf:${l.id}`, creado: h.desde,
        texto: `${nombre} · ${dSince} · ${motivo} · ${Math.round(callado)} días sin mensajes del flujo${mano}` });
      continue;
    }

    if (!ESTADOS_SIN_FLUJO.has(est)) continue;
    const reunion = ultimaReunion.get(l.id);
    const entro = `entró por ${fuenteCorta(l.Lead_Source)} el ${fechaCorta(l.Created_Time)}`;
    let texto = null;
    if (est === 'Reunión Agendada') {
      // Mientras la reunion es futura, esperar es lo correcto.
      if (!reunion || dias(reunion.Start_DateTime) < 1) continue;
      texto = `${nombre} · la reunión fue el ${fechaCorta(reunion.Start_DateTime)}${reunion.Status_del_Meet ? ` (${reunion.Status_del_Meet})` : ', no está marcada,'} y sigue en Reunión Agendada, sin cadencia · marcar si vino para que el blueprint lo mueva`;
    } else if (est === 'En Calificación' && (l.reserva === true || reunion)) {
      const cuando = reunion ? `el ${fechaCorta(reunion.Start_DateTime)}` : 'hace poco';
      texto = `${nombre} · tuvo reunión ${cuando}${reunion?.Status_del_Meet ? ` (${reunion.Status_del_Meet})` : ''} y quedó en En Calificación, que no tiene cadencia · pasarlo a Comercial, Retargeting o Nurturing`;
    } else if (est === 'En Calificación' && /web organic/i.test(l.Lead_Source || '')) {
      texto = `${nombre} · ${entro} · la regla Asignación Source manda todo Web Organic a En Calificación, sin cadencia${l.flujo_normal ? ' (y lo sacó de Captación al minuto de entrar)' : ''}`;
    } else if (est === 'En Calificación') {
      texto = `${nombre} · ${entro} · En Calificación no tiene cadencia: hay que clasificarlo (Comercial, Retargeting o Nurturing)`;
    } else if (est === 'No Interesado' || est === 'No Calificado') {
      texto = `${nombre} · ${est} · baja a mano: desde ahí no hay cadencia ni nurturing (la baja tiene que terminar en Nurturing)`;
    } else {
      texto = `${nombre} · ${entro} · está en ${est}, un estado que no entra a ningún flujo`;
    }
    estado.push({ ...base, id: `sre:${l.id}`, creado: l.Created_Time, texto });
  }
  return { flujo, estado, timelines };
}

/**
 * Las siete reglas. Cada una devuelve:
 *   clave    id corto para comparar contra la corrida anterior
 *   titulo   como se lee en Slack
 *   nivel    'alto' | 'medio'
 *   casos    [{ id, texto, link, creado }]
 */
function normNombre(n) {
  return String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean).sort().join(' ');
}

export function evaluar({ leads, contactos, llcs, tratos, props, events, fusiones = [], sinRetargeting = { flujo: [], estado: [] } }) {
  const reglas = [];
  // Un lead que ya explican las reglas 21/22 no se repite en las 7 y 10: ahi la
  // fecha vencida es la del flujo anterior, y "debia salir hace 20 dias" seria
  // mentira sobre un mensaje que si salio.
  const explicados = new Set([...sinRetargeting.flujo, ...sinRetargeting.estado].map((c) => c.id.split(':')[1]));

  // 1. Dos posibles clientes con el mismo telefono.
  const porTel = new Map();
  for (const l of leads) {
    const t = normTel(l.Mobile || l.Phone);
    if (!t) continue;
    (porTel.get(t) || porTel.set(t, []).get(t)).push(l);
  }
  reglas.push({
    clave: 'duplicados',
    titulo: 'posibles clientes duplicados',
    nivel: 'alto',
    casos: [...porTel.entries()].filter(([, v]) => v.length > 1).map(([tel, v]) => {
      const orden = [...v].sort((a, b) => new Date(b.Created_Time) - new Date(a.Created_Time));
      return {
        id: `tel:${tel}`,
        texto: `${orden[0].Full_Name || 'sin nombre'} · ${orden.map((x) => x.Lead_Source || 'sin canal').join(' / ')}`,
        link: link('Leads', orden[0].id),
        creado: orden[0].Created_Time,
      };
    }),
  });

  // 2. Se abrio un lead de alguien que ya es cliente: arranca cadencia de captacion.
  const telContactos = new Map();
  for (const c of contactos) {
    const t = normTel(c.Mobile || c.Phone);
    if (t) telContactos.set(t, c);
  }
  reglas.push({
    clave: 'lead-de-cliente',
    titulo: 'posibles clientes que ya son clientes',
    nivel: 'alto',
    // El texto dice DE QUIEN es el telefono: el 11-sep-2026 un referido se agendo desde
    // el celular de su socio (cliente) y el lead nuevo quedo con ese numero. "Ya existe
    // como contacto" no alcanzaba para entender que cualquier WhatsApp a ese lead le llega
    // al cliente. Si el nombre no coincide, es otra persona con el telefono de un cliente.
    casos: leads.filter((l) => telContactos.has(normTel(l.Mobile || l.Phone))).map((l) => {
      const c = telContactos.get(normTel(l.Mobile || l.Phone));
      const llc = c.Account_Name?.name ? ` (${c.Account_Name.name})` : '';
      const mismo = normNombre(l.Full_Name) === normNombre(c.Full_Name);
      return {
        id: `lc:${l.id}`,
        texto: mismo
          ? `${l.Full_Name || 'sin nombre'} · ya es contacto${llc}`
          : `${l.Full_Name || 'sin nombre'} · tiene el teléfono de ${c.Full_Name}${llc}, que ya es contacto`,
        link: link('Leads', l.id),
        creado: l.Created_Time,
      };
    }),
  });

  // 3. LLC sin ninguna ficha de propietario.
  const conProp = new Set(props.map((p) => p.LLC?.id).filter(Boolean));
  reglas.push({
    clave: 'llc-sin-propietario',
    titulo: 'LLCs sin propietario cargado',
    nivel: 'medio',
    casos: llcs.filter((a) => !conProp.has(a.id)).map((a) => ({
      id: `sp:${a.id}`,
      texto: `${a.Account_Name} · ${a.Estado_de_Registro || 'sin estado'}`,
      link: link('Accounts', a.id),
      creado: a.Created_Time,
    })),
  });

  // 4. La estructura societaria no coincide con los socios cargados. Importa
  //    porque de ese campo sale la fecha de renovacion federal.
  const cuentaProp = new Map();
  for (const p of props) {
    const id = p.LLC?.id;
    if (id) cuentaProp.set(id, (cuentaProp.get(id) || 0) + 1);
  }
  reglas.push({
    clave: 'estructura',
    titulo: 'estructura societaria que no coincide',
    nivel: 'medio',
    casos: llcs.filter((a) => {
      const n = cuentaProp.get(a.id) || 0;
      if (!n) return false;
      const es = String(a.Estructura_Societaria || '');
      return (MULTI.test(es) && n === 1) || (SINGLE.test(es) && n > 1);
    }).map((a) => ({
      id: `es:${a.id}`,
      texto: `${a.Account_Name} · dice ${MULTI.test(a.Estructura_Societaria) ? 'multi' : 'single'} y tiene ${cuentaProp.get(a.id)} socio(s)`,
      link: link('Accounts', a.id),
      creado: a.Created_Time,
    })),
  });

  // 5. Reunion que ya paso y nadie marco si la persona vino.
  reglas.push({
    clave: 'reuniones-sin-marcar',
    titulo: 'reuniones sin marcar si vino',
    nivel: 'medio',
    casos: events.filter((e) => e.Start_DateTime && dias(e.Start_DateTime) > 2 && vacio(e.Status_del_Meet)).map((e) => ({
      id: `rm:${e.id}`,
      texto: `${e.Event_Title || 'sin título'} · ${String(e.Start_DateTime).slice(0, 10)} · ${e.Owner?.name || 'sin dueño'}`,
      link: link('Events', e.id),
      creado: e.Start_DateTime,
      duenio: e.Owner?.name || null,
    })),
  });

  // 6. Trato abierto que no se mueve.
  reglas.push({
    clave: 'tratos-frenados',
    titulo: 'tratos abiertos frenados +90 días',
    nivel: 'medio',
    casos: tratos.filter((d) => !FASES_CERRADAS.has(d.Stage) && dias(d.Modified_Time) > 90).map((d) => ({
      id: `tf:${d.id}`,
      texto: `${d.Deal_Name} · ${d.Stage} · ${Math.round(dias(d.Modified_Time))} días sin moverse`,
      link: link('Deals', d.id),
      creado: d.Modified_Time,
      duenio: d.Owner?.name || null,
    })),
  });

  // 7. Cadencia prendida con el mensaje vencido. Es el patron del bloqueo de
  //    WhatsApp: si algo lee el flag, los despierta a todos juntos.
  reglas.push({
    clave: 'cadencias-vencidas',
    titulo: 'cadencias vencidas con el flag prendido',
    nivel: 'alto',
    casos: leads.filter((l) =>
      l.Retargeting === true && l.Fecha_Siguiente_Mensaje && dias(l.Fecha_Siguiente_Mensaje) > 30
      && !explicados.has(l.id)
    ).map((l) => ({
      id: `cv:${l.id}`,
      texto: `${l.Full_Name || 'sin nombre'} · ${l.Lead_Status} · vencido hace ${Math.round(dias(l.Fecha_Siguiente_Mensaje))} días`,
      link: link('Leads', l.id),
      creado: l.Fecha_Siguiente_Mensaje,
    })),
  });

  // 8. Un canal que venia trayendo leads todos los dias dejo de traer.
  //    Asi se ve desde el CRM que se corto una integracion, sin llamar a Meta.
  //    El 3-sep-2026 se descubrio a mano que 48 de 61 leads de los formularios
  //    de Meta nunca habian llegado: esta regla es para no volver a enterarse
  //    una semana tarde.
  //
  //    El umbral se calcula solo con el ritmo de cada canal en los ultimos 28
  //    dias: un canal que trae 2 por dia se avisa a las 48 h de silencio, uno
  //    que trae 1 cada 3 dias recien a los 12. Asi no hay que mantener una
  //    lista de canales ni un numero fijo por canal.
  const ahora = Date.now();
  const ritmo = new Map();
  for (const l of leads) {
    if (!l.Created_Time || !l.Lead_Source) continue;
    const t = new Date(l.Created_Time).getTime();
    if (ahora - t > VENTANA * 864e5) continue;
    const v = ritmo.get(l.Lead_Source) || { n: 0, ultimo: 0 };
    v.n++;
    v.ultimo = Math.max(v.ultimo, t);
    ritmo.set(l.Lead_Source, v);
  }
  reglas.push({
    clave: 'canal-sin-leads',
    titulo: 'canales que dejaron de traer leads',
    nivel: 'alto',
    casos: [...ritmo.entries()].filter(([, v]) => v.n >= MINIMO_CANAL).map(([fuente, v]) => {
      const porDia = v.n / VENTANA;
      const umbral = Math.max(24, 4 * (24 / porDia));   // horas
      const silencio = (ahora - v.ultimo) / 36e5;
      return { fuente, porDia, umbral, silencio, ultimo: new Date(v.ultimo).toISOString() };
    }).filter((c) => c.silencio > c.umbral).map((c) => ({
      id: `pulso:${c.fuente}`,
      texto: `${c.fuente} · sin leads nuevos hace ${Math.round(c.silencio)} h · venía trayendo ${c.porDia.toFixed(1)} por día`,
      link: `${ZOHO_UI}/Leads`,
      creado: c.ultimo,
    })),
  });

  // 9. Lead de Meta que entro y nadie toco. Los que recupera la sincronizacion
  //    de Lead Chain entran crudos: estado `Nuevo MQL`, sin cadencia, sin
  //    fecha de proximo mensaje. Eso es bueno (no dispara WhatsApp masivo) y
  //    peligroso: si nadie los reparte se quedan ahi. Son justo los que ventas
  //    tiene que llamar en caliente.
  reglas.push({
    clave: 'meta-sin-contactar',
    titulo: 'leads de Meta que nadie contactó',
    nivel: 'alto',
    casos: leads.filter((l) =>
      l.leadchain0__Social_Lead_ID
      && vacio(l.Nombre_retargeting)
      && dias(l.Created_Time) * 24 > HORAS_SIN_CONTACTO
      // Sin actividad posterior a la creacion: nadie lo abrio, ni le escribio,
      // ni le cambio el estado. Zoho toca Last_Activity_Time con cualquiera de
      // esas tres cosas, asi que alcanza para saber si esta virgen.
      && (!l.Last_Activity_Time || new Date(l.Last_Activity_Time) - new Date(l.Created_Time) < 5 * 60e3)
    ).map((l) => ({
      id: `msc:${l.id}`,
      texto: `${l.Full_Name || 'sin nombre'} · ${l.Mobile || l.Phone || 'sin teléfono'} · entró hace ${Math.round(dias(l.Created_Time) * 24)} h y sigue en ${l.Lead_Status || 'sin estado'}`,
      link: link('Leads', l.id),
      creado: l.Created_Time,
    })),
  });

  // 10. El mensaje tenia fecha para salir, la fecha paso y sigue sin salir.
  //     Es la falla del motor de cadencia, no el stock viejo: eso lo cuenta la
  //     regla 7 (+30 dias). Aca esta lo que todavia se puede destrabar.
  reglas.push({
    clave: 'mensajes-que-no-salieron',
    titulo: 'mensajes de cadencia que no salieron',
    nivel: 'alto',
    casos: leads.filter((l) =>
      l.Retargeting === true && l.Fecha_Siguiente_Mensaje
      && dias(l.Fecha_Siguiente_Mensaje) > FALLA_DESDE
      && dias(l.Fecha_Siguiente_Mensaje) <= FALLA_HASTA
      && !explicados.has(l.id)
      && !nurturingTodaviaNoToca(l)
    ).map((l) => ({
      id: `mns:${l.id}`,
      texto: `${l.Full_Name || 'sin nombre'} · ${l.Nombre_retargeting || 'sin cadencia'} · mensaje ${l.N_mero_de_mensaje ?? '?'} · debía salir hace ${Math.round(dias(l.Fecha_Siguiente_Mensaje))} días`,
      link: link('Leads', l.id),
      creado: l.Fecha_Siguiente_Mensaje,
    })),
  });

  // 10b. El que escribio por WhatsApp entro sin numero de telefono. Desde
  //      sep-2026 WhatsApp le oculta el numero al negocio a parte de la gente
  //      que escribe desde un anuncio (identidad privada): la integracion de
  //      Zoho guarda en Movil un identificador tipo `CO.3507376112750885`, que
  //      no es un numero. El numero real NO esta en ningun lado del CRM.
  //      La cadencia le marca msj 1 y no le manda nada, y el lead se queda
  //      esperando. Lo unico que sirve: contestarle en el chat de WhatsApp (ahi
  //      si llega) y pedirle el numero. Medido el 13-sep-2026: 3 de 18 en 5 dias.
  reglas.push({
    clave: 'whatsapp-sin-numero',
    titulo: 'leads de WhatsApp sin número real',
    nivel: 'alto',
    casos: leads.filter((l) =>
      /^[A-Z]{2}\.\d+$/.test(String(l.Mobile || l.Phone || ''))
      && dias(l.Created_Time) <= FALLA_HASTA
    ).map((l) => ({
      id: `wsn:${l.id}`,
      texto: `${l.Full_Name || 'sin nombre'} · escribió hace ${Math.round(dias(l.Created_Time) * 24)} h · ${l.Nombre_retargeting || 'sin cadencia'} · WhatsApp le ocultó el número: la cadencia no le llega, contestarle en el chat y pedírselo`,
      link: link('Leads', l.id),
      creado: l.Created_Time,
    })),
  });

  // 11. La fecha de renovacion cargada no es la proxima que toca.
  //     Una renovacion es anual: desde hoy, la proxima vez que cae ese mes y
  //     dia es una sola fecha, no hay opcion. Si lo cargado es otra cosa, la
  //     renovacion de este ano se vuelve invisible para la planilla y para
  //     cualquier alerta.
  //
  //     Aparecio el 4-sep-2026: una carga masiva puso 2027 en las 530
  //     estatales, y 58 LLCs que renuevan en oct, nov y dic de 2026 quedaron
  //     figurando para el ano siguiente. Ninguna regla lo habria visto.
  const proximaVez = (fecha) => {
    const [, mes, dia] = fecha.split('-');
    const hoy = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
    const anio = hoy.getUTCFullYear();
    for (const y of [anio, anio + 1, anio + 2]) {
      const c = `${y}-${mes}-${dia}`;
      if (new Date(c + 'T00:00:00Z') >= hoy) return c;
    }
    return null;
  };
  // Si la LLC ya tuvo un trato de Renovacion cerrado este ano, que la fecha
  // apunte al ano que viene es lo correcto y no hay nada que avisar. Sin este
  // filtro la regla grita por 19 LLCs que estan bien.
  const anioActual = String(new Date().getUTCFullYear());
  const yaRenovaron = new Set(
    tratos.filter((d) => d.Type === 'Renovación' && String(d.Created_Time).startsWith(anioActual))
      .map((d) => d.Account_Name?.id).filter(Boolean)
  );

  const desfasadas = [];
  for (const a of llcs) {
    if (yaRenovaron.has(a.id)) continue;
    for (const [campo, cual] of [['Fecha_renovaci_n_estatal', 'estatal'], ['Fecha_renovaci_n_federal', 'federal']]) {
      const f = a[campo];
      if (!f || !/^\d{4}-\d{2}-\d{2}/.test(f)) continue;
      const deberia = proximaVez(f.slice(0, 10));
      if (deberia && deberia !== f.slice(0, 10)) desfasadas.push({ a, cual, cargada: f.slice(0, 10), deberia });
    }
  }
  reglas.push({
    clave: 'renovacion-desfasada',
    titulo: 'renovaciones con la fecha en el año equivocado',
    nivel: 'alto',
    casos: desfasadas.map((d) => ({
      id: `rd:${d.a.id}:${d.cual}`,
      texto: `${d.a.Account_Name} · ${d.a.Estado_de_Registro || 'sin estado'} · renovación ${d.cual} dice ${d.cargada} y toca el ${d.deberia}`,
      link: link('Accounts', d.a.id),
      creado: d.deberia,
    })),
  });

  // 12. Lead que nacio sin estado. Es el agujero mas silencioso del CRM: con
  //     `Lead_Status` vacio el registro no aparece en NINGUNA vista filtrada por
  //     estado, asi que no lo ve nadie salvo que lo busque a proposito. Y no
  //     entra a ningun flujo, porque todas las reglas de apertura arrancan
  //     mirando el estado o la etiqueta.
  //
  //     Medido el 6-sep-2026: 141 leads asi en toda la base, 24 desde agosto,
  //     ninguno con cadencia. Reparto por fuente: Meta Ads 40, Facturacion
  //     Gratis Web 21, Web Organic 19, TimelinesAI 19, Clientes Actuales 13,
  //     Marca Personal 12, Landing Page 9, Chatbot Starti 7.
  //
  //     La causa no es Zoho: son integraciones que crean el registro con los
  //     disparadores apagados (el chatbot Starti lo hace desde SalesIQ con la
  //     funcion `handleContext...`, que no es una funcion del CRM). Cuando un
  //     alta llega asi, NINGUNA regla corre por mas que exista, y por eso esto
  //     no se puede tapar con una regla nueva en Zoho: hay que avisar y
  //     repartir a mano hasta que se arregle del lado de cada integracion.
  //
  //     La ventana es la misma que la regla 9 (6 h): un lead sin estado es tan
  //     urgente como uno de Meta sin contactar, y los viejos ya son stock.
  reglas.push({
    clave: 'lead-sin-estado',
    titulo: 'leads que entraron sin estado y no los ve nadie',
    nivel: 'alto',
    casos: leads.filter((l) =>
      vacio(l.Lead_Status)
      && vacio(l.Nombre_retargeting)
      && dias(l.Created_Time) * 24 > HORAS_SIN_CONTACTO
      // Solo los de los ultimos 30 dias. Atras hay 117 mas, de hasta un año:
      // eso es stock para una limpieza, no una alerta diaria.
      && dias(l.Created_Time) <= 30
    ).map((l) => ({
      id: `sinestado:${l.id}`,
      texto: `${l.Full_Name || 'sin nombre'} · ${l.Lead_Source || 'sin canal'} · ${l.Mobile || l.Phone || 'sin teléfono'} · entró hace ${Math.round(dias(l.Created_Time) * 24)} h sin estado y sin cadencia`,
      link: link('Leads', l.id),
      creado: l.Created_Time,
    })),
  });

  // 13. Cuenta bancaria sola cargada en el diseño de Aperturas.
  //     El nombre es lo UNICO que separa las dos lineas: "Cuenta Bancaria - X"
  //     es una cuenta sola, "Apertura - X" es una LLC (que puede incluir la
  //     cuenta como fase). Si se mezclan, el LTV de las dos queda mal.
  reglas.push({
    clave: 'cb-mal-clasificado',
    titulo: 'cuentas bancarias cargadas como apertura de LLC',
    nivel: 'alto',
    casos: tratos
      .filter((d) => /^\s*cuenta bancaria/i.test(d.Deal_Name || '') && d.Layout?.name !== 'Cuentas Bancarias')
      .map((d) => ({
        id: `cbm:${d.id}`,
        texto: `${d.Deal_Name} · está en el diseño "${d.Layout?.name || 'sin diseño'}" y debería estar en Cuentas Bancarias`,
        link: link('Deals', d.id),
        creado: d.Created_Time,
        duenio: d.Owner?.name || null,
      })),
  });

  // 14. Trato terminado sin importe. Es como la linea de cuentas bancarias
  //     llego a facturar USD 100 en total: nadie carga el monto y no salta nada.
  reglas.push({
    clave: 'trato-sin-importe',
    titulo: 'tratos terminados sin importe cargado',
    nivel: 'alto',
    casos: tratos
      .filter((d) => FASES_CERRADAS.has(d.Stage) && !/perdid/i.test(d.Stage) && !(Number(d.Amount) > 0))
      .map((d) => ({
        id: `tsi:${d.id}`,
        texto: `${d.Deal_Name} · ${d.Stage} · sin importe`,
        link: link('Deals', d.id),
        creado: d.Created_Time,
        duenio: d.Owner?.name || null,
      })),
  });

  // 14b. Trato terminado sin contacto vinculado. Hermano del anterior, y peor:
  //      sin importe la venta llega sin monto, pero sin contacto no llega a
  //      nadie. El aviso que le manda la venta a Meta saca el mail y el telefono
  //      del contacto del trato; si el trato no tiene contacto, esa venta es
  //      invisible para la atribucion y tampoco se puede facturar sola.
  reglas.push({
    clave: 'trato-sin-contacto',
    titulo: 'tratos terminados sin contacto vinculado',
    nivel: 'alto',
    casos: tratos
      .filter((d) => FASES_CERRADAS.has(d.Stage) && !/perdid/i.test(d.Stage) && !d.Contact_Name?.id)
      .map((d) => ({
        id: `tsc:${d.id}`,
        texto: `${d.Deal_Name} · ${d.Stage} · sin contacto vinculado`,
        link: link('Deals', d.id),
        creado: d.Created_Time,
        duenio: d.Owner?.name || null,
      })),
  });

  // 15. El contacto sabe de que anuncio vino y su trato no. Eso significa que la
  //     Asignacion de conversion de Posible cliente dejo de copiar los campos, y
  //     es justo lo que hace que el CRM no pueda decir que anuncio hizo la venta.
  {
    const conAnuncio = new Map(contactos.filter((c) => !vacio(c.Anuncio)).map((c) => [c.id, c]));
    reglas.push({
      clave: 'trato-sin-anuncio',
      titulo: 'tratos sin anuncio cuyo contacto sí lo tiene',
      nivel: 'alto',
      casos: tratos
        .filter((d) => vacio(d.Anuncio) && d.Contact_Name?.id && conAnuncio.has(d.Contact_Name.id))
        .map((d) => ({
          id: `tsa:${d.id}`,
          texto: `${d.Deal_Name} · el contacto vino de "${conAnuncio.get(d.Contact_Name.id).Anuncio}" y el trato quedó vacío`,
          link: link('Deals', d.id),
          creado: d.Created_Time,
          duenio: d.Owner?.name || null,
        })),
    });
  }

  // 16. El trato sabe cual es la LLC y el contacto quedo suelto. Es el vinculo
  //     que mira el panel del chat y la cabecera de la ficha: si esta vacio, al
  //     cliente se le atiende sin ver de que empresa habla. En sep-2026 esto
  //     estaba en 323 contactos y se corrigio a mano; la regla existe para
  //     enterarnos el mismo dia si vuelve a crecer, porque la causa vive en una
  //     automatizacion de Zoho que no se puede leer por API.
  {
    const llcDelTrato = new Map();
    for (const d of tratos) {
      if (!d.Contact_Name?.id || !d.Account_Name?.id) continue;
      if (!llcDelTrato.has(d.Contact_Name.id)) llcDelTrato.set(d.Contact_Name.id, new Set());
      llcDelTrato.get(d.Contact_Name.id).add(d.Account_Name.id);
    }
    const nombreLlc = new Map(llcs.map((a) => [a.id, a.Account_Name]));
    reglas.push({
      clave: 'contacto-sin-llc',
      titulo: 'contactos sin la LLC vinculada',
      nivel: 'alto',
      // Solo los que tienen UNA sola LLC posible: los duenios de varias van al
      // multi-lookup y ahi el campo vacio es lo correcto, no un error.
      casos: contactos
        .filter((c) => !c.Account_Name?.id && llcDelTrato.get(c.id)?.size === 1)
        .map((c) => {
          const [llcId] = [...llcDelTrato.get(c.id)];
          return {
            id: `csl:${c.id}`,
            texto: `${c.Full_Name || 'sin nombre'} · su trato es de ${nombreLlc.get(llcId) || 'una LLC'} y la ficha no la muestra`,
            link: link('Contacts', c.id),
            creado: null,
          };
        }),
    });
  }

  // 17. La LLC dice que la trajo un socio y el trato no lo dice. **Esto no se
  //     arregla solo y no se puede mapear**: el socio vive en la LLC, y cuando
  //     el lead se convierte la LLC recien se crea, con `Socio` todavia vacio.
  //     Alguien lo carga despues, a mano, y de ahi no baja a ningun lado.
  //     Sin esto el trato de un partner no se distingue de una venta directa, y
  //     el LTV por socio queda corto. Son ~7 por mes, asi que la solucion es
  //     avisar y correr los dos scripts, no armar una automatizacion:
  //       node canal-partners.js --aplicar     (pone Landing_Origen = "Partner")
  //       node partner-en-trato.js --aplicar   (copia el nombre del socio)
  {
    const socioDeLlc = new Map(llcs.filter((a) => a.Socio?.name).map((a) => [a.id, a.Socio.name]));
    reglas.push({
      clave: 'trato-partner-sin-marcar',
      titulo: 'tratos de un socio que no dicen que vinieron de un socio',
      nivel: 'medio',
      // OJO: el canal y el socio NO son lo mismo y pueden convivir. Hay tratos con
      // `Lead_Source = "Meta Ads"` cuya LLC ademas tiene socio: esa persona vino
      // por un anuncio y su LLC quedo asociada a un partner. Ahi el canal de
      // adquisicion es Meta y esta bien. Por eso solo se avisa cuando el canal esta
      // VACIO, nunca cuando dice otra cosa: exigir "Partner" pisaria un dato bueno.
      casos: tratos
        .filter((d) => d.Account_Name?.id && socioDeLlc.has(d.Account_Name.id)
          && (vacio(d.Partner) || sinCanal(d.Lead_Source)))
        .map((d) => {
          const socio = socioDeLlc.get(d.Account_Name.id);
          const falta = [vacio(d.Partner) ? 'Partner' : null,
            sinCanal(d.Lead_Source) ? 'Fuente' : null].filter(Boolean).join(' y ');
          return {
            id: `tps:${d.id}`,
            texto: `${d.Deal_Name} · la LLC la trajo ${socio} y al trato le falta ${falta}`,
            link: link('Deals', d.id),
            creado: d.Created_Time,
            duenio: d.Owner?.name || null,
          };
        }),
    });
  }

  // 18. Cada trato que entra, con de donde vino y que le falta. No es un error:
  //     es el parte diario de las ventas nuevas, que era justo lo que no se veia.
  //     Un trato se mira UNA vez, en sus primeras 48 h: asi entra en el aviso de
  //     las 9:00 y en el de las 16:30 sin repetirse para siempre.
  //
  //     El origen se busca por orden de firmeza: el canal, despues el socio,
  //     despues quien lo refirio, y al final la fuente del lead. Si no hay
  //     ninguno, la venta entra sin saber de donde vino y eso es lo que hay que
  //     ver. El detalle del anuncio solo se exige cuando el canal dice Meta:
  //     pedirselo a una venta de WhatsApp seria ruido.
  {
    const HORAS_NUEVO = 24;
    const nuevos = tratos.filter((d) => dias(d.Created_Time) <= HORAS_NUEVO / 24);
    reglas.push({
      clave: 'tratos-nuevos',
      titulo: 'tratos nuevos: de donde vinieron y que les falta',
      nivel: 'medio',
      casos: nuevos.map((d) => {
        // 18-sep-2026: el canal es Lead_Source ("Fuente"); Landing_Origen es la pagina por donde entro.
        const esMeta = /meta|facebook|instagram/i.test(String(d.Lead_Source || ''));
        const origen = !sinCanal(d.Lead_Source) ? `${d.Lead_Source}${vacio(d.Landing_Origen) ? '' : ` (${d.Landing_Origen})`}`
          : !vacio(d.Partner) ? `socio ${d.Partner}`
            : !vacio(d.Referido) ? `referido por ${d.Referido}`
              : 'SIN ORIGEN';
        const falta = [
          vacio(d.Amount) ? 'importe' : null,
          vacio(d.Type) ? 'tipo' : null,
          !d.Contact_Name?.id ? 'contacto' : null,
          !d.Account_Name?.id ? 'LLC' : null,
          sinCanal(d.Lead_Source) ? 'canal' : null,
          // El _fbc es el Click ID: sin el, Lead Chain manda la venta a Meta y Meta
          // no la puede atribuir al anuncio que la trajo.
          esMeta && vacio(d.fbc) && vacio(d.leadchain0__Social_Lead_ID) ? 'el _fbc' : null,
          esMeta && vacio(d.Anuncio) ? 'que anuncio fue' : null,
        ].filter(Boolean);
        const anuncio = !vacio(d.Anuncio) ? ` · anuncio "${String(d.Anuncio).slice(0, 40)}"` : '';
        const monto = vacio(d.Amount) ? '' : ` · USD ${d.Amount}`;
        const cola = falta.length ? ` · falta ${falta.join(', ')}` : ' · completo';
        return {
          id: `tn:${d.id}`,
          texto: `${d.Deal_Name}${monto} · ${origen}${anuncio}${cola}`,
          link: link('Deals', d.id),
          creado: d.Created_Time,
          duenio: d.Owner?.name || null,
        };
      }),
    });
  }

  // 20. Un lead que se renombro para poder fusionarlo, o una ficha que cambio de
  //     telefono el dia que recibio la fusion. La cuenta compartida no deja nombre
  //     y la fusion no tiene vuelta atras: el historial de WhatsApp queda pegado
  //     a la ficha donde cayo. Lo unico que se puede hacer es verlo al dia siguiente.
  reglas.push({
    clave: 'fusion-sospechosa',
    titulo: 'fusiones que cambiaron de persona',
    nivel: 'alto',
    casos: fusiones.filter((f) => f.antes || f.telefono).map((f) => {
      const partes = [];
      if (f.antes) partes.push(`el lead se llamaba "${f.antes.nombre}" y se renombro a "${f.lead.nombre}" antes de fusionarlo`);
      if (f.telefono) partes.push(`la ficha paso del ${f.telefono.de} al ${f.telefono.a} ese dia (${f.telefono.fuente})`);
      return {
        id: `fs:${f.lead.id}`,
        texto: `${f.contacto.nombre || f.lead.nombre} · ${partes.join(' · ')} · por ${f.quien}`,
        link: link('Contacts', f.contacto.id),
        creado: f.cuando,
      };
    }),
  });

  // 23. Reuniones de varias personas colgadas de la LLC de otro. Pasa cuando al
  //     convertir un lead se elige una LLC ajena: Zoho mueve ahi todas las reuniones
  //     del lead. Entre el 4 y el 10-sep-2026 se convirtieron 11 leads dentro de
  //     FUTURE LABS LLC (la de Arturo Mont Martinez) y 12 reuniones de venta de
  //     otra gente, entre ellas las que cerraron TOWERS y CHIVA, quedaron ahi.
  //     Se avisa por LLC y solo cuando son 2 personas o mas, para no marcar al
  //     dueno de varias LLCs que tiene una reunion en la otra.
  {
    const llcDeContacto = new Map(contactos.map((c) => [c.id, c.Account_Name?.id || null]));
    const porLlc = new Map();
    for (const e of events) {
      if (e.$se_module !== 'Accounts' || !e.What_Id?.id || !e.Who_Id?.id) continue;
      if (!e.Start_DateTime || dias(e.Start_DateTime) > 60) continue;
      const suya = llcDeContacto.get(e.Who_Id.id);
      if (suya === e.What_Id.id) continue;
      const v = porLlc.get(e.What_Id.id) || { nombre: e.What_Id.name, personas: new Set(), reuniones: 0, ultima: e.Start_DateTime };
      v.personas.add(e.Who_Id.name || e.Who_Id.id);
      v.reuniones++;
      if (e.Start_DateTime > v.ultima) v.ultima = e.Start_DateTime;
      porLlc.set(e.What_Id.id, v);
    }
    reglas.push({
      clave: 'reuniones-en-llc-ajena',
      titulo: 'reuniones de otras personas colgadas de una LLC',
      nivel: 'alto',
      casos: [...porLlc.entries()].filter(([, v]) => v.personas.size >= 2).map(([id, v]) => ({
        id: `rl:${id}:${v.personas.size}`,
        texto: `${v.nombre} tiene ${v.reuniones} reuniones de ${v.personas.size} personas que no son de esa LLC (${[...v.personas].slice(0, 4).join(', ')}${v.personas.size > 4 ? '…' : ''}). Casi seguro se convirtieron leads eligiendo esta LLC por error: mover cada reunión a la LLC de su persona`,
        link: link('Accounts', id),
        creado: v.ultima,
      })),
    });
  }

  // 21 y 22. Que posible cliente anda sin retargeting, y por que. Los casos ya
  //     vienen redactados y verificados por timeline desde leerSinRetargeting():
  //     aca solo se reparten. Van en dos reglas porque los arregla gente distinta:
  //     si la automatizacion no arranco es de quien maneja los flujos; si el lead
  //     esta en un estado sin cadencia, alguien de ventas lo tiene que mover.
  reglas.push({
    clave: 'sin-retargeting-flujo',
    titulo: 'sin retargeting: el flujo no arrancó o se cortó',
    nivel: 'alto',
    casos: sinRetargeting.flujo,
  });
  reglas.push({
    clave: 'sin-retargeting-estado',
    titulo: 'sin retargeting: en un estado sin cadencia',
    nivel: 'alto',
    casos: sinRetargeting.estado,
  });

  return reglas;
}

/**
 * En que fase esta cada cadencia. No es una regla: no hay nada que arreglar de
 * a un lead, es la foto de como viene el motor. Va al pie del aviso de las 9:00.
 *
 * Devuelve una fila por cadencia con el total, los dos mensajes donde se
 * amontona la gente y cuantos tienen el proximo envio vencido esta semana.
 */
export function mapaCadencias(leads) {
  const activos = leads.filter((l) => l.Retargeting === true);
  const porCadencia = new Map();
  for (const l of activos) {
    const c = l.Nombre_retargeting || 'con el flag prendido y sin cadencia';
    const v = porCadencia.get(c) || { total: 0, mensajes: new Map(), vencidos: 0 };
    v.total++;
    const m = l.N_mero_de_mensaje ?? '?';
    v.mensajes.set(m, (v.mensajes.get(m) || 0) + 1);
    if (l.Fecha_Siguiente_Mensaje && dias(l.Fecha_Siguiente_Mensaje) > 1 && dias(l.Fecha_Siguiente_Mensaje) <= 7) v.vencidos++;
    porCadencia.set(c, v);
  }
  return {
    activos: activos.length,
    total: leads.length,
    filas: [...porCadencia.entries()]
      .map(([cadencia, v]) => ({
        cadencia,
        total: v.total,
        vencidos: v.vencidos,
        picos: [...v.mensajes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
          .map(([m, n]) => ({ mensaje: m, cuantos: n })),
      }))
      .sort((a, b) => b.total - a.total),
  };
}

/** Que apareció y que se resolvio desde la foto anterior. */
export function comparar(reglas, anterior) {
  return reglas.map((r) => {
    const antes = new Set(anterior?.[r.clave] || []);
    const ahora = r.casos.map((c) => c.id);
    const hayFoto = !!anterior?.[r.clave];
    return {
      ...r,
      total: r.casos.length,
      nuevos: hayFoto ? r.casos.filter((c) => !antes.has(c.id)) : [],
      resueltos: hayFoto ? [...antes].filter((id) => !ahora.includes(id)).length : 0,
      primeraVez: !hayFoto,
    };
  });
}

export const fotoDe = (reglas) =>
  Object.fromEntries(reglas.map((r) => [r.clave, r.casos.map((c) => c.id)]));
