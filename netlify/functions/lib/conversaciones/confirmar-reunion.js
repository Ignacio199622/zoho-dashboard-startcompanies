// EL SI / NO A LA CONFIRMACION DE REUNION.
//
// Reemplaza la parte de Confirmafy que leia la respuesta del cliente. Zoho manda
// el WhatsApp de 24 h con botones Si/No (regla `Recordatorio 1 dia`) y el de
// agendado con Confirmo / Necesito reprogramar, pero no lee lo que contestan:
// `messages__s` guarda UN registro por conversacion con el ultimo mensaje.
//
// Este modulo pasa cada 5 minutos, mira las conversaciones con movimiento,
// se queda con las que hablo ultimo el cliente, y si el remitente tiene una
// reunion de venta proxima sin Confirmacion y el mensaje es un si o un no,
// escribe `Confirmaci_n` en la reunion. El resto lo hace Zoho: la regla manda
// el "gracias por confirmar" / "elegi otro horario" y pinta el calendario.
//
// ─── POR QUE CADA 5 MINUTOS Y NO 15 ────────────────────────────────────────
//
// Como el CRM solo guarda el ultimo mensaje, cualquier cosa que le conteste el
// equipo (o un bot) PISA el "Si" y ya no se ve. El 13-sep-2026 a las 14:22
// Rodolfo Martinez Rogers contesto "Si" y a los 5 minutos la guardia fuera de
// horario le contesto "hoy es domingo, agenda una llamada": el Si se perdio y
// el cliente recibio un mensaje sin sentido. Por eso (a) esto corre seguido y
// (b) la guardia tiene un freno para no contestar un si/no de alguien con
// reunion (ver guardia-tarea.js).
//
// ─── QUE CUENTA COMO SI Y COMO NO ──────────────────────────────────────────
//
// Textos de boton (exactos) y unas pocas formas escritas, comparadas despues
// de normalizar. Ante la duda NO se escribe: se avisa a Slack para que lo lea
// una persona. Un "no" mal leido manda "liberamos ese horario, elegi otro" a
// alguien que iba a venir, y eso es peor que no leer nada.
import { get, conversacionesDesde } from './zoho.js';
import { confirmarReunion } from './escritura.js';
import { cerrarPisadas, reservaDe, reservaCanceladaDe, mandarBotonReprogramar, primerNombre, HORAS_VENTANA } from './reprogramar.js';
import { reservarDeNuevo } from './cal.js';


export const HORAS_ATRAS = 2; // reuniones que ya empezaron hace poco tambien cuentan
export const DIAS_ADELANTE = 15;
export const HORAS_VENTANA_24H = 26;

const normalizar = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(new RegExp("\\p{Extended_Pictographic}", "gu"), " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

// Lo que mandan los botones. Van primero y valen en cualquier momento desde que
// existe la reunion.
const BOTON_SI = new Set(['si', 'confirmo', 'sim', 'yes']); // 28-oct-2026: 'yes' = botón de cliente_confirmacion_24h_en
// Brasil (14-oct-2026): "Não" llega normalizado como "nao"; "preciso reagendar/remarcar"
// es el par de "necesito reprogramar" (va a la misma rama, reprograma).
const BOTON_NO = new Set(['no', 'necesito reprogramar', 'nao', 'preciso reagendar', 'preciso remarcar']);

// Escrito a mano. Frases ENTERAS: "si manana estoy" cuenta, "si pero a que
// hora" no (tiene pregunta y ademas no esta en la lista).
const SI_ESCRITO = new Set([
  'si confirmo', 'confirmado', 'si confirmado', 'si voy', 'si asisto', 'si asistire',
  'si puedo', 'si podre', 'si claro', 'claro que si', 'si ahi estare', 'ahi estare',
  'si por supuesto', 'por supuesto', 'si gracias', 'si ok', 'ok si', 'dale si', 'si dale',
  'si perfecto', 'perfecto si', 'si manana estoy', 'ok si manana estoy', 'si estare',
  'si nos vemos', 'nos vemos', 'si nos vemos manana', 'si confirmo asistencia',
  'confirmo asistencia', 'si si', 'sii', 'siii', 'yes',
  'sim vou', 'vou sim', 'sim confirmo', // Brasil
  'yes i will', 'yes i can', 'i will be there', 'yes see you', 'confirmed', 'i confirm', // inglés (28-oct)
]);
const NO_ESCRITO = /* @__PURE__ */ new Set([
  "no puedo",
  "no voy",
  "no podre",
  "no asistire",
  "no voy a poder",
  "no puedo asistir",
  "no puedo manana",
  "no podre asistir",
  "reprogramar",
  "quiero reprogramar",
  "necesito reagendar",
  "reagendar",
  "cancelar",
  "cancelo",
  "no gracias",
  "no no",
  "nao vou",
  // Brasil ("não vou")
  "i can t make it",
  "i cannot make it",
  "i can t attend",
  "i cannot attend",
  "need to reschedule",
  "i need to reschedule",
  "reschedule"
  // inglés (28-oct-2026)
]);

/**
 * Lee la respuesta. Devuelve { valor: 'si'|'no', boton: bool } o null.
 * Una pregunta nunca cuenta, por corta que sea.
 */
// Pide OTRO horario (no dice que no viene): le sale el boton para mover su reserva
// (ver reprogramar.js). Caso Esteban Daza, 1-oct-2026.
const PIDE_OTRO_HORARIO = /\b(reag\w*ndar|reprogramar|remarcar|cambiar (el|de) horario|otro horario)\b/;

export function leerRespuesta(texto) {
  const bruto = String(texto == null ? '' : texto);
  if (/[?¿]/.test(bruto)) return null;
  const t = normalizar(bruto);
  if (!t) return null;
  const reprograma = PIDE_OTRO_HORARIO.test(t);
  if (BOTON_SI.has(t)) return { valor: 'si', boton: true };
  if (BOTON_NO.has(t)) return { valor: 'no', boton: true, reprograma };
  if (SI_ESCRITO.has(t)) return { valor: 'si', boton: false };
  if (NO_ESCRITO.has(t)) return { valor: 'no', boton: false, reprograma };
  // Escrito largo pero inequivoco: "me surgio un imprevisto, podemos reagendar para la
  // tarde por favor" (Marco Rodriguez, 13-sep-2026). Pide otro horario = no asiste a este.
  // Solo cuenta como "escrito" (sin boton), asi vale unicamente dentro de la ventana de 24 h.
  if (/\b(reag\w*ndar|reprogramar|imprevisto|no (voy a )?poder asistir|cambiar (el|de) horario)\b/.test(t)) {
    return { valor: 'no', boton: false, reprograma };
  }
  return null;
}

const CAMPOS_EVENTO =
  'id,Event_Title,Start_DateTime,Confirmaci_n,Tipo_de_reuni_n,Status_del_Meet,What_Id,Who_Id,Created_Time,Hora_local_del_cliente,Hora_de_confirmaci_n,Owner';

const isoZoho = (d) => d.toISOString().slice(0, 19) + '+00:00';

/** Reuniones de venta proximas, sin Confirmacion todavia. 1 llamada. */
export async function reunionesPendientes(ahora = new Date()) {
  return soloPendientes(await reunionesProximas(ahora));
}

// Venta y clientes. En una reunion de cliente el remitente es el Contacto (Who_Id)
// y la respuesta dispara la regla "SC Cliente respuesta" (14-sep-2026).
// Una reunion de Clientes colgada de un lead (sin Who_Id) queda afuera: su respuesta
// dispararia la regla de venta al telefono de ese lead.
// Con Estatus ya puesto (Cancelada / Asistio / No asistio) la respuesta no se procesa:
// escribir Confirmacion dispararia "SC Cliente respuesta" y le mandaria un WhatsApp.
export const soloPendientes = (todas) =>
  todas.filter((e) => !e.Confirmaci_n && !e.Status_del_Meet && !(e.Tipo_de_reuni_n === 'Clientes' && !e.Who_Id));

/** Todas las reuniones de la ventana, con o sin Confirmacion, y el telefono de las de Clientes. */
export async function reunionesProximas(ahora = new Date()) {
  const desde = new Date(ahora.getTime() - HORAS_ATRAS * 3600e3);
  const hasta = new Date(ahora.getTime() + DIAS_ADELANTE * 86400e3);
  const criterio = `((Start_DateTime:greater_equal:${isoZoho(desde)})and(Start_DateTime:less_equal:${isoZoho(hasta)}))`;
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const j = await get(
      `Events/search?criteria=${encodeURIComponent(criterio)}&fields=${CAMPOS_EVENTO}&per_page=200&page=${page}`
    );
    out.push(...(j.data || []));
    if (!j.info?.more_records) break;
  }
  await cargarTelefonos(soloPendientes(out));
  return out;
}

const soloDigitos = (t) => String(t || '').replace(/\D/g, '');

/**
 * El celular del Contacto de cada reunion de Clientes, para cruzar por telefono.
 *
 * Por que hace falta: `messages__s` cuelga el hilo de WhatsApp del PRIMER registro
 * que tenga ese numero, y muchos clientes conservan su lead viejo con el mismo
 * celular (medido 15-sep-2026 con Camila: reunion en el Contacto, hilo en el
 * lead). Cruzando solo por id de remitente, el Si/No de esos clientes se pierde.
 * Se lee `Contacts?ids=` de a 100 (1 llamada) y queda en `e._telefono`.
 */
async function cargarTelefonos(reuniones) {
  const ids = [...new Set(reuniones.filter((e) => e.Tipo_de_reuni_n === 'Clientes' && e.Who_Id?.id).map((e) => e.Who_Id.id))];
  const telefonos = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const j = await get(`Contacts?ids=${ids.slice(i, i + 100).join(',')}&fields=id,Mobile,Phone`).catch(() => ({}));
    for (const c of j.data || []) telefonos.set(c.id, soloDigitos(c.Mobile || c.Phone));
  }
  for (const e of reuniones) if (e.Who_Id?.id && telefonos.get(e.Who_Id.id)) e._telefono = telefonos.get(e.Who_Id.id);
}

/**
 * Cruza conversaciones con reuniones y decide.
 *
 * Devuelve por cada cruce: { evento, conversacion, decision } donde decision es
 *   { accion: 'confirmar'|'no_asiste'|'revisar'|'ignorar', motivo }
 * Exportada aparte para poder probarla sin red.
 */
export function decidir(conversaciones, reuniones, todas = reuniones) {
  const abiertas = /* @__PURE__ */ new Map();
  for (const e of todas) {
    if (e.Tipo_de_reuni_n === "Clientes" || !e.What_Id?.id || e.Status_del_Meet) continue;
    if (/^\[(CANCELADA|REAGENDADA)\]/.test(e.Event_Title || "")) continue;
    if (!abiertas.has(e.What_Id.id)) abiertas.set(e.What_Id.id, []);
    abiertas.get(e.What_Id.id).push(e);
  }
  const liberadas = /* @__PURE__ */ new Map();
  for (const e of todas) {
    if (e.Tipo_de_reuni_n === "Clientes" || !e.What_Id?.id) continue;
    if (!/^\[CANCELADA\]/.test(e.Event_Title || "")) continue;
    if (!liberadas.has(e.What_Id.id)) liberadas.set(e.What_Id.id, []);
    liberadas.get(e.What_Id.id).push(e);
  }
  const porPersona = /* @__PURE__ */ new Map();
  const porTelefono = /* @__PURE__ */ new Map();
  const masCercana = (mapa, clave2, e) => {
    const previa = mapa.get(clave2);
    if (!previa || new Date(e.Start_DateTime) < new Date(previa.Start_DateTime)) mapa.set(clave2, e);
  };
  for (const e of reuniones) {
    for (const ref of [e.What_Id?.id, e.Who_Id?.id]) if (ref) masCercana(porPersona, ref, e);
    if (e._telefono) masCercana(porTelefono, e._telefono, e);
  }
  const cruces = [];
  for (const c of conversaciones) {
    if (c.conversation_status__s !== "Responded") continue;
    const quien2 = c.sender__s?.id;
    const r0 = leerRespuesta(c.last_message__s);
    if (r0?.reprograma && quien2 && abiertas.has(quien2)) {
      const cuando3 = new Date(c.message_time__s);
      const previas = abiertas.get(quien2).filter((e) => new Date(e.Created_Time) <= cuando3 && new Date(e.Start_DateTime) > cuando3);
      const horarios = new Set(previas.map((e) => new Date(e.Start_DateTime).getTime()));
      if (horarios.size === 1) {
        const evento2 = previas.sort((a, b) => new Date(b.Created_Time) - new Date(a.Created_Time))[0];
        cruces.push({ evento: evento2, conversacion: c, decision: { accion: "reprogramar", motivo: r0.boton ? "boton" : "escrito" } });
        continue;
      }
      if (horarios.size > 1) {
        cruces.push({ evento: previas[0], conversacion: c, decision: { accion: "revisar", motivo: "pidio reprogramar y tiene mas de una reunion" } });
        continue;
      }
    }
    const evento = quien2 && porPersona.get(quien2) || porTelefono.get(soloDigitos(c.mobile_number__s));
    if (!evento) {
      const cuando3 = new Date(c.message_time__s);
      const lib = (liberadas.get(quien2) || []).filter(
        (e) => new Date(e.Created_Time) <= cuando3 && new Date(e.Start_DateTime) > cuando3
      );
      if (lib.length && !abiertas.has(quien2) && leerRespuesta(c.last_message__s)?.valor === "si") {
        cruces.push({ evento: lib[0], conversacion: c, decision: { accion: "revisar", motivo: "si_tardio" } });
      }
      continue;
    }
    const cuando2 = new Date(c.message_time__s);
    const inicio = new Date(evento.Start_DateTime);
    const creada = new Date(evento.Created_Time);
    const desde24h = new Date(inicio.getTime() - HORAS_VENTANA_24H * 36e5);
    const texto = String(c.last_message__s || "").trim();
    if (cuando2 < creada) {
      cruces.push({ evento, conversacion: c, decision: { accion: "ignorar", motivo: "mensaje anterior a la reunion" } });
      continue;
    }
    const r = leerRespuesta(texto);
    if (!r) {
      const accion = cuando2 >= desde24h ? "revisar" : "ignorar";
      cruces.push({ evento, conversacion: c, decision: { accion, motivo: "no es un si ni un no" } });
      continue;
    }
    if (r.valor === "si") {
      cruces.push({ evento, conversacion: c, decision: { accion: "confirmar", motivo: r.boton ? "boton" : "escrito" } });
      continue;
    }
    const preguntada = evento.Hora_de_confirmaci_n ? new Date(evento.Hora_de_confirmaci_n) : desde24h;
    if (cuando2 >= preguntada) {
      cruces.push({ evento, conversacion: c, decision: { accion: "no_asiste", motivo: r.boton ? "boton" : "escrito" } });
    } else {
      cruces.push({ evento, conversacion: c, decision: { accion: "revisar", motivo: "un no antes del recordatorio de 24 h" } });
    }
  }
  return cruces;
}

/**
 * Una pasada completa. `escribir=false` decide pero no toca el CRM.
 * `desde` es el corte de lectura de conversaciones (Date).
 */
export async function unaPasada({ escribir = false, ahora = /* @__PURE__ */ new Date(), desde = null, hechos = /* @__PURE__ */ new Set() } = {}) {
  const corte = desde || new Date(ahora.getTime() - 6 * 36e5);
  const [conversaciones, proximas2] = await Promise.all([conversacionesDesde(corte), reunionesProximas(ahora)]);
  const pisadas2 = await cerrarPisadas({ todas: proximas2, escribir, ahora });
  const fuera = new Set(pisadas2.filter((p) => !p.dudosa && (!escribir || p.zoho?.ok)).map((p) => p.cerrar.id));
  const todas = proximas2.filter((e) => !fuera.has(e.id));
  const cruces = decidir(conversaciones, soloPendientes(todas), todas);
  const resultados = [];
  for (const x of cruces) {
    if (x.decision.accion === "ignorar") continue;
    const salida = { ...x, ejecucion: null };
    if (x.decision.accion === "reprogramar") {
      const clave2 = `reprog:${x.evento.id}:${x.conversacion.message_time__s}`;
      if (hechos.has(clave2)) continue;
      salida.clave = clave2;
      const edad = (ahora - new Date(x.conversacion.message_time__s)) / 36e5;
      if (edad > HORAS_VENTANA) {
        salida.decision = { accion: "revisar", motivo: "pidio reprogramar hace mas de 23 h" };
      } else if (escribir) {
        try {
          salida.ejecucion = await confirmarReunion(x.evento.id, "No asiste");
        } catch (e) {
          salida.ejecucion = { ok: false, error: String(e.message) };
        }
      }
      resultados.push(salida);
      continue;
    }
    if (x.decision.motivo === "si_tardio") {
      const clave2 = `${x.evento.id}:${x.conversacion.message_time__s}`;
      if (hechos.has(clave2)) continue;
      if (escribir && new Date(x.evento.Start_DateTime) - ahora > 45 * 6e4) {
        try {
          const b = await reservaCanceladaDe(x.evento);
          salida.ejecucion = b ? await reservarDeNuevo(b) : { ok: false, error: "no encontre la reserva cancelada en Cal" };
        } catch (e) {
          salida.ejecucion = { ok: false, error: String(e.message) };
        }
      } else if (escribir) salida.ejecucion = { ok: false, error: "falta menos de 45 min" };
      resultados.push(salida);
      continue;
    }
    if (["confirmar", "no_asiste"].includes(x.decision.accion) && escribir) {
      const valor = x.decision.accion === "confirmar" ? "Confirm\xF3" : "No asiste";
      try {
        salida.ejecucion = await confirmarReunion(x.evento.id, valor);
      } catch (e) {
        salida.ejecucion = { ok: false, error: String(e.message) };
      }
    }
    resultados.push(salida);
  }
  return { leidas: conversaciones.length, reuniones: todas.length, resultados, pisadas: pisadas2 };
}
