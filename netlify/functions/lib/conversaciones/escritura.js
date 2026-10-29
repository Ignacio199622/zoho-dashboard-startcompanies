// EL UNICO ARCHIVO QUE ESCRIBE EN ZOHO.
//
// Todo lo demas del agente es de solo lectura, a proposito (ver el encabezado de
// `zoho.js`). Aca vive la escritura y nada mas, para que se pueda auditar de un
// vistazo que toca el CRM y que no.
//
// Dos reglas que no se negocian:
//
//  1. Todo PUT de campos va con `"trigger": []`. Editar un lead en este CRM
//     dispara reglas que mandan WhatsApp. En agosto de 2026 una regla en bucle
//     mando la misma plantilla cada 3 minutos hasta que Meta bloqueo el numero.
//     Un proceso de BAJA que termina mandando un mensaje es peor que no tenerlo.
//
//  2. La baja se hace con la transicion del blueprint, no escribiendo el estado
//     a mano. `Lead_Status = No Interesado` salio del picklist (sigue en 1.417
//     registros historicos): un PUT directo lo ignora en silencio y devuelve
//     200. La transicion, ademas, hace que Zoho borre las acciones programadas
//     pendientes, que es lo que de verdad apaga la cadencia.
import { token, get, invalidarToken } from './zoho.js';


// [restaurado del deploy 16-oct-2026]
export async function avisoAgente(eventId, aviso, link = null) {
  if (!["Reprogramar", "Turno liberado"].includes(aviso)) throw new Error(`aviso invalido: ${aviso}`);
  await put("Events", { data: [{ id: eventId, Aviso_agente: null }], trigger: [] });
  const r = await put("Events", {
    data: [{ id: eventId, Aviso_agente: aviso, ...link ? { Link_reprogramar: link } : {} }],
    trigger: ["workflow"]
    // A PROPOSITO: esto es lo que manda el WhatsApp.
  });
  const j = await get(`Events/${eventId}?fields=Aviso_agente,Link_reprogramar`);
  const q = j.data?.[0] || {};
  const ok = q.Aviso_agente === aviso && (!link || q.Link_reprogramar === link);
  return { ok, http: r.http, id: ok ? `Events:${eventId}` : null, error: ok ? null : JSON.stringify(r.cuerpo?.data?.[0] || r.cuerpo).slice(0, 160) };
}

// [restaurado del deploy 16-oct-2026]
export async function apagarSiNoZoho(eventId) {
  const r = await put("Events", { data: [{ id: eventId, Hora_de_confirmaci_n: null, Hora_de_recordatorio: null }], trigger: ["workflow"] });
  const j = await get(`Events/${eventId}?fields=Hora_de_confirmaci_n,Hora_de_recordatorio`);
  const q = j.data?.[0] || {};
  const ok = !q.Hora_de_confirmaci_n && !q.Hora_de_recordatorio;
  return { ok, http: r.http, error: ok ? null : JSON.stringify(r.cuerpo?.data?.[0] || r.cuerpo).slice(0, 160) };
}

// [restaurado del deploy 16-oct-2026]
export const ESTADOS_POST_REUNION = ["Retargeting", "Nurturing", "Retargeting Lili", "No Interesado"];

// [restaurado del deploy 16-oct-2026]
export async function moverLeadA(leadId, estado) {
  if (!ESTADOS_POST_REUNION.includes(estado)) throw new Error(`moverLeadA: estado no permitido "${estado}"`);
  const r = await put("Leads", { data: [{ id: leadId, Lead_Status: estado }], trigger: ["workflow"] });
  // Si el lead esta adentro de un blueprint, Zoho no deja escribir Lead_Status
  // (RECORD_IN_BLUEPRINT) y hay que usar la transicion que lleva a ese estado.
  // Pasaba con "En Calificacion": el aviso repetia el mismo error todos los dias.
  let via = "put";
  let error = errorDe(r);
  if (r.cuerpo?.data?.[0]?.code === "RECORD_IN_BLUEPRINT") {
    const t = (await transicionesDe(leadId)).find(
      (x) => x.next_field_value === estado && !(x.fields || []).some((f) => f.mandatory)
    );
    if (!t) {
      error = `en blueprint y sin transición a ${estado}`;
      via = "sin-transicion";
    } else {
      const b = await put(`Leads/${leadId}/actions/blueprint`, { blueprint: [{ transition_id: String(t.id), data: {} }] });
      const d = b.cuerpo?.blueprint?.[0] || b.cuerpo?.data?.[0] || b.cuerpo;
      error = d?.code === "SUCCESS" ? null : JSON.stringify(d).slice(0, 160);
      via = `transicion "${t.name}"`;
    }
  }
  const j = await get(`Leads/${leadId}?fields=Lead_Status,Retargeting,Nombre_retargeting,Fecha_Siguiente_Mensaje`);
  const l = j.data?.[0] || {};
  return { ok: l.Lead_Status === estado, http: r.http, quedo: l, error, via };
}

const API = 'https://www.zohoapis.com/crm/v6';

// La transicion "Desactivar Retargeting" del blueprint "Retargeting Apertura".
// Se usa como respaldo: primero se busca por nombre entre las transiciones que
// Zoho ofrece para ese lead, asi sigue funcionando si Adrian la recrea con otro
// id.
export const TRANSICION_BAJA_ID = '6698625000056477152';
export const TRANSICION_BAJA_NOMBRE = 'Desactivar Retargeting';

// Estados en los que el lead ya esta afuera: no hay nada que apagar.
//
// "Nurturing" esta aca desde el 10-sep-2026: con el rediseño de Adrian la
// transicion "Desactivar Retargeting" ya no lleva a No Interesado sino a
// Nurturing (goteo largo de mails, sin WhatsApp de venta), y es donde Ignacio
// quiere que queden los "no me interesa". Sin esto, la baja que SI salio se
// leia como fallida ("aplicado=false" con el lead ya en Nurturing), el agente
// no la marcaba como hecha y la reintentaba en cada corrida.
export const ESTADOS_YA_FUERA = ['No Interesado', 'Fuera de flujo', 'Nurturing'];

// `Fecha_Siguiente_Mensaje` ya no maneja la cadencia de apertura (la maneja
// `Lead_Status`), pero DOS reglas la siguen leyendo y son las que corresponden a
// estos tipos de trato. Para esos leads, apagar el blueprint no alcanza.
export const TIPOS_QUE_LEEN_LA_FECHA = ["Cuenta Bancaria", "Renovaci\xF3n", "Renovacion"];

const CAMPOS_LEAD =
  'id,Full_Name,First_Name,Tag,Owner,Lead_Status,Retargeting,Desactivar_Retargeting,En_Nurturing,Fecha_Siguiente_Mensaje,Tipo,Mobile,Phone,Email';

async function put(path, cuerpo, reintento = false) {
  const r = await fetch(`${API}/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Zoho-oauthtoken ${await token()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cuerpo),
  });
  // Mismo caso que en `get`: un token viejo del almacen compartido da 401. Se
  // tira y se reintenta una vez. Es seguro repetir un PUT identico, porque
  // escribe los mismos campos con los mismos valores.
  if (r.status === 401 && !reintento) {
    await invalidarToken();
    return put(path, cuerpo, true);
  }
  const txt = await r.text();
  let j = null;
  try {
    j = txt.trim() ? JSON.parse(txt) : null;
  } catch {
    throw new Error(`Zoho ${path}: respuesta no-JSON (${r.status}) ${txt.slice(0, 200)}`);
  }
  return { http: r.status, cuerpo: j };
}

/** Como esta el lead ahora. */
export async function leerLead(id) {
  const j = await get(`Leads/${id}?fields=${CAMPOS_LEAD}`);
  return (j.data || [])[0] || null;
}

/**
 * La ficha que Zoho ya tiene atada a la conversacion, pedida por id.
 *
 * El registro de `messages__s` trae `sender__s` con el modulo y el id de la
 * persona. Buscarla por el telefono del chat falla cuando escribe desde OTRO
 * numero que el cargado en la ficha: el 21-sep-2026 Leidy Natalia Valencia
 * (clienta, dos aperturas activas) escribio a las 18:38 desde el +573102770685
 * teniendo el +573152375313 en su ficha, y la guardia la descarto como "no
 * esta en el CRM". Sin ficha no hay aviso ni tarea.
 */
export async function fichaPorId(modulo, id) {
  if (!modulo || !id) return null;
  const campos = modulo === 'Leads' ? CAMPOS_LEAD : CAMPOS_GUARDIA;
  try {
    const j = await get(`${modulo}/${id}?fields=${campos}`);
    return (j.data || [])[0] || null;
  } catch {
    return null;
  }
}

/**
 * Todos los leads con ese telefono. En plural a proposito: con los duplicados
 * que tiene el CRM, dar de baja solo el que mando el mensaje deja al gemelo
 * mandando la cadencia y el cliente vuelve a escribir, mas enojado.
 *
 * El telefono vive en `Mobile`, no en `Phone`: buscar por Phone pierde la mitad
 * de los registros (482 tienen solo Mobile).
 */
export async function leadsConTelefono(numero) {
  if (!numero) return [];
  const limpio = String(numero).replace(/[^\d+]/g, '');
  const variantes = [...new Set([limpio, limpio.replace(/^\+/, '')])];
  const encontrados = new Map();
  for (const v of variantes) {
    const criterio = `((Mobile:equals:${v})or(Phone:equals:${v}))`;
    const j = await get(`Leads/search?criteria=${encodeURIComponent(criterio)}&fields=${CAMPOS_LEAD}`);
    for (const l of j.data || []) encontrados.set(l.id, l);
  }
  return [...encontrados.values()];
}

/** Las transiciones que Zoho ofrece hoy para ese lead. */
export async function transicionesDe(id) {
  const j = await get(`Leads/${id}/actions/blueprint`);
  const bp = Array.isArray(j.blueprint) ? j.blueprint[0] : j.blueprint;
  return bp?.transitions || [];
}

/** La de baja, si esta disponible. Por nombre primero, por id como respaldo. */
export function buscarTransicionBaja(transiciones) {
  return (
    transiciones.find((t) => t.name === TRANSICION_BAJA_NOMBRE) ||
    transiciones.find((t) => String(t.id) === TRANSICION_BAJA_ID) ||
    null
  );
}

/**
 * Ejecuta la transicion y CONFIRMA releyendo el registro.
 *
 * La confirmacion no es paranoia de mas: la v6 devuelve 200 ignorando campos en
 * silencio. Sin releer, el agente reportaria bajas que no ocurrieron y el
 * cliente seguiria recibiendo mensajes mientras el canal de Slack dice que se
 * dio de baja.
 */
export async function ejecutarBaja(id, transicionId) {
  const r = await put(`Leads/${id}/actions/blueprint`, {
    blueprint: [{ transition_id: String(transicionId), data: {} }],
  });
  const detalle = r.cuerpo?.blueprint?.[0] || r.cuerpo?.data?.[0] || r.cuerpo;
  const despues = await leerLead(id);
  const ok = !!despues && ESTADOS_YA_FUERA.includes(despues.Lead_Status);
  return {
    ok,
    estado: despues?.Lead_Status || null,
    http: r.http,
    codigo: detalle?.code || detalle?.status || null,
    mensaje: detalle?.message || null,
    lead: despues,
  };
}

/**
 * Vacia `Fecha_Siguiente_Mensaje`. Solo hace falta para los tipos cuyas reglas
 * todavia leen ese campo; para el resto el blueprint alcanza y este PUT seria
 * una escritura al pedo sobre un CRM donde escribir tiene costo.
 */
export async function vaciarFechaSiguiente(id) {
  const r = await put('Leads', {
    data: [{ id: String(id), Fecha_Siguiente_Mensaje: null }],
    trigger: [], // sin esto, editar el lead puede disparar un WhatsApp
  });
  const despues = await leerLead(id);
  return {
    ok: !!despues && !despues.Fecha_Siguiente_Mensaje,
    http: r.http,
    codigo: r.cuerpo?.data?.[0]?.code || null,
    quedo: despues?.Fecha_Siguiente_Mensaje || null,
  };
}

/** Necesita que le vaciemos la fecha ademas de apagar el blueprint. */
export const leeLaFecha = (lead) =>
  TIPOS_QUE_LEEN_LA_FECHA.includes(lead?.Tipo) && !!lead?.Fecha_Siguiente_Mensaje;

// ─── GUARDIA FUERA DE HORARIO ──────────────────────────────────────────────
//
// OJO: esta es la UNICA escritura del agente que va con los workflows
// PRENDIDOS, al reves que todas las de arriba. Es a proposito y es el mecanismo
// entero: el agente no manda el WhatsApp (no puede, `messages__s` es de solo
// lectura). Lo que hace es tildar `Aviso_Fuera_Horario`, y esa edicion dispara
// la regla de Zoho que manda la plantilla aprobada.
//
// Por eso los frenos viven en `guardia.js` (15 minutos de gracia, uno por
// conversacion por dia, tope por corrida) y no aca: cuando la llamada llega a
// esta funcion, el mensaje ya sale.
const CAMPOS_GUARDIA = 'id,Full_Name,Owner,Aviso_Fuera_Horario,Motivo_Cierre,Vuelta_Habil,Email,Mobile,Phone';

/** El contacto (cliente) con ese telefono, si existe. */
export async function contactosConTelefono(numero) {
  if (!numero) return [];
  const limpio = String(numero).replace(/[^\d+]/g, '');
  const variantes = [...new Set([limpio, limpio.replace(/^\+/, '')])];
  const encontrados = new Map();
  for (const v of variantes) {
    const criterio = `((Mobile:equals:${v})or(Phone:equals:${v}))`;
    const j = await get(`Contacts/search?criteria=${encodeURIComponent(criterio)}&fields=${CAMPOS_GUARDIA}`);
    for (const c of j.data || []) encontrados.set(c.id, c);
  }
  return [...encontrados.values()];
}

/**
 * Tilda la casilla que dispara el aviso, y CONFIRMA releyendo.
 *
 * La confirmacion no es de mas: si los campos todavia no existen en el layout,
 * Zoho contesta 200 y los ignora en silencio. Sin releer, el agente reportaria
 * avisos que nunca salieron.
 */
export async function marcarAvisoFueraDeHorario(modulo, id, porQue, frase) {
  const r = await put(modulo, {
    data: [{ id: String(id), Aviso_Fuera_Horario: true, Motivo_Cierre: porQue, Vuelta_Habil: frase }],
    trigger: ['workflow'], // A PROPOSITO: esto es lo que manda el WhatsApp.
  });
  const j = await get(`${modulo}/${id}?fields=${CAMPOS_GUARDIA}`);
  const despues = (j.data || [])[0] || null;
  const ok = despues?.Aviso_Fuera_Horario === true && despues?.Vuelta_Habil === frase
    && despues?.Motivo_Cierre === porQue;
  return {
    ok,
    http: r.http,
    codigo: r.cuerpo?.data?.[0]?.code || null,
    // Si no quedo, casi siempre es que faltan los campos en el layout.
    motivo: ok ? null : (despues ? 'los campos no quedaron guardados' : 'no se pudo releer el registro'),
    registro: despues,
  };
}

async function post(path, cuerpo) {
  const r = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${await token()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cuerpo),
  });
  const txt = await r.text();
  let j = null;
  try {
    j = txt.trim() ? JSON.parse(txt) : null;
  } catch {
    throw new Error(`Zoho ${path}: respuesta no-JSON (${r.status}) ${txt.slice(0, 200)}`);
  }
  return { http: r.status, cuerpo: j };
}

// Prefijo del asunto. Es la marca por la que se reconocen las tareas propias
// entre las que carga el equipo a mano.
export const ASUNTO_GUARDIA = 'Contestar a';
const MARCA_GUARDIA = 'Tarea creada por el agente de guardia';

/**
 * ¿Ya le dejamos una tarea de guardia a este registro en ESTE cierre?
 *
 * `desde` es el instante en que arranco el cierre (`inicioDelCierre`), no la
 * medianoche. Comparar contra el dia del calendario fue el bug del 8-sep-2026:
 * a las 00:00 se reiniciaba el contador y todos los que habian escrito la noche
 * anterior recibian el mismo aviso una segunda vez, con la oficina todavia
 * cerrada. Un cierre puede cruzar la medianoche (toda noche lo hace) o durar
 * cuatro dias (un finde largo), y en cualquiera de los dos casos corresponde un
 * solo aviso.
 *
 * Se le pregunta al CRM y no a un archivo local a proposito: en Netlify no hay
 * disco, y un estado en memoria se pierde entre corridas. Preguntandole a Zoho
 * la respuesta es la misma corra donde corra y sobrevive a que se caiga el
 * proceso a la mitad.
 */
export async function tareaGuardiaDesde(modulo, id, desde) {
  const corte = desde instanceof Date ? desde.getTime() : new Date(desde).getTime();
  const j = await get(`${modulo}/${id}/Tasks?fields=id,Subject,Description,Created_Time&per_page=50`);
  return (j.data || []).some((t) => {
    if (!String(t.Description || '').includes(MARCA_GUARDIA)) return false;
    const creada = Date.parse(t.Created_Time || '');
    return Number.isFinite(creada) && creada >= corte;
  });
}

/**
 * ¿Le SALIO el aviso de fuera de horario en este cierre?
 *
 * No es lo mismo que tener la tarea: hay casos en que se crea la tarea y el
 * WhatsApp no sale (lo venia atendiendo el equipo, cerro la conversacion...).
 * Bug del 9/11-oct-2026 con Franco Isaias Jorge Blanco: el viernes 19:22 Ignacio
 * Campo lo venia atendiendo, se creo solo la tarea; el sabado y el domingo
 * volvio a escribir sin que nadie le contestara y la guardia lo salteo porque
 * "ya tenia tarea". Finde largo por Columbus Day: sin aviso hasta el martes.
 *
 * Se lee del timeline (la unica fuente confiable de lo que mando una regla).
 * Si no se puede leer, se asume que si le salio: ante la duda, un mensaje de
 * menos y no uno repetido.
 */
export async function avisoGuardiaDesde(modulo, id, desde) {
  const corte = desde instanceof Date ? desde.getTime() : new Date(desde).getTime();
  try {
    const j = await get(`${modulo}/${id}/__timeline?per_page=50`);
    return (j.__timeline || []).some((e) => {
      if (e.action !== 'messagenotificationsent') return false;
      const a = e.automation_details || {};
      const nombre = `${a.rule?.name || ''} ${a.message_notification_sent?.notification?.name || ''}`;
      if (!/fuera de horario|fuera_horario/i.test(nombre)) return false;
      const cuando = Date.parse(e.audited_time || '');
      return Number.isFinite(cuando) && cuando >= corte;
    });
  } catch {
    return true;
  }
}

/**
 * La tarea para el que tiene que contestar.
 *
 * El vinculo al registro va en campos distintos segun el modulo, verificado
 * mirando 8 tareas reales del CRM: los Posibles clientes cuelgan de `What_Id`
 * ("Relacionado con") y los Contactos de `Who_Id` ("Nombre de contacto"). Con
 * el campo equivocado la tarea se crea igual pero queda suelta, sin aparecer en
 * la ficha de la persona, que es justo donde el vendedor la va a buscar.
 *
 * Los valores de `Priority` y `Status` son los internos en ingles ("High",
 * "Not Started") aunque la interfaz los muestre en español.
 */
export async function crearTareaGuardia({
  modulo,
  registroId,
  nombre,
  responsableId,
  vencimiento,
  cuandoEscribio,
  mensaje
}) {
  const tarea = {
    Subject: `Contestar a ${nombre || "quien escribio"}, escribio fuera de horario`,
    Due_Date: vencimiento,
    Priority: "High",
    Status: "Not Started",
    Owner: String(responsableId),
    $se_module: modulo,
    Description: `Escribio por WhatsApp ${cuandoEscribio}, con la oficina cerrada.
Ya recibio el aviso automatico de que le respondemos el proximo dia habil.

` + (mensaje ? `Lo ultimo que dijo:
"${String(mensaje).slice(0, 400)}"

` : "") + "Tarea creada por el agente de guardia."
  };
  if (modulo === "Contacts") tarea.Who_Id = String(registroId);
  else tarea.What_Id = String(registroId);
  const r = await post("Tasks", { data: [tarea], trigger: [] });
  const fila = r.cuerpo?.data?.[0] || null;
  return {
    ok: fila?.code === "SUCCESS",
    id: fila?.details?.id || null,
    http: r.http,
    codigo: fila?.code || null,
    mensaje: fila?.message || null
  };
}

// ─── LA SECUENCIA ──────────────────────────────────────────────────────────
//
// El lead que escribe al WhatsApp tiene que entrar al mismo embudo que todos:
// Agendamiento (3 mensajes empujando a reservar) -> Retargeting (11 en 30 dias)
// -> Comercial -> Nurturing. Eso lo maneja el blueprint "Retargeting Apertura",
// y lo unico que hay que hacer es dejarlo en el estado de entrada.
//
// Pero hay un si: `Flujo Agendamiento Crear y Editar`, la regla que manda esos
// 3 mensajes, esta APAGADA y nunca corrio (`last_executed_time: null`). Mientras
// siga apagada, mover el lead a "Agendamiento" no le manda nada y ademas lo
// edita, que en este CRM puede disparar otras reglas. Por eso se pregunta
// primero si la regla esta viva.
export const ESTADOS_CON_CADENCIA = [
  "Agendamiento",
  "Captaci\xF3n",
  "Captacion",
  "Comercial",
  "Retargeting",
  "Retargeting Lili",
  "Nurturing",
  "No Show"
];
export const REGLA_AGENDAMIENTO = 'Flujo Agendamiento Crear y Editar';
const ESTADO_DE_ENTRADA = 'Agendamiento';

/**
 * ¿Esta prendida la regla que manda los mensajes de agendamiento?
 *
 * Las reglas de workflow solo se leen en la v8; la v6 contesta
 * API_NOT_SUPPORTED. Y `status` viene como objeto, no como booleano: filtrar
 * por `status === 'active'` da cero siempre.
 */
export const REGLA_AGENDAMIENTO_ID = '6698625000055987020';

export async function reglaAgendamientoActiva() {
  try {
    const cab = { Authorization: `Zoho-oauthtoken ${await token()}` };
    // Se pide DIRECTO por id. Recorrer la lista y despues pedir el detalle
    // devuelve datos cacheados: el 7-sep-2026 esta regla daba `active: false`
    // y `last_executed_time: null` por ese camino, cuando en realidad estaba
    // activa y habia corrido esa misma mañana. Por id da el estado real.
    const det = await (await fetch(
      `https://www.zohoapis.com/crm/v8/settings/automation/workflow_rules/${REGLA_AGENDAMIENTO_ID}`,
      { headers: cab }
    )).json();
    return det.workflow_rules?.[0]?.status?.active === true;
  } catch {
    return false;
  }
}

/** Deja el lead en el estado de entrada del embudo. Confirma releyendo. */
export async function ponerEnSecuencia(id) {
  const r = await put('Leads', {
    data: [{ id: String(id), Lead_Status: ESTADO_DE_ENTRADA }],
    trigger: ['workflow'], // A PROPOSITO: es lo que arranca la cadencia.
  });
  const despues = await leerLead(id);
  return {
    ok: despues?.Lead_Status === ESTADO_DE_ENTRADA,
    estado: despues?.Lead_Status || null,
    http: r.http,
    codigo: r.cuerpo?.data?.[0]?.code || null,
  };
}

/**
 * Mete un lead dormido a la cadencia de Captación.
 *
 * Escribe UN campo, `Lead_Status`, y de ahi en adelante lo maneja la regla
 * `Flujo Captación Crear Editar`, que dispara con `Lead_Status = Captación`.
 * Va con workflows PRENDIDOS: es lo que arranca la cadencia.
 *
 * Confirma releyendo porque un valor que no este en el picklist Zoho lo ignora
 * en silencio y devuelve 200 (ya paso con `No Interesado`).
 */
export async function mandarACaptacion(id) {
  const r = await put("Leads", {
    data: [{ id: String(id), Lead_Status: "Captaci\xF3n" }],
    trigger: ["workflow"]
    // A PROPOSITO: esto arranca los 5 mensajes.
  });
  const despues = await leerLead(id);
  return {
    ok: despues?.Lead_Status === "Captaci\xF3n",
    estado: despues?.Lead_Status || null,
    http: r.http,
    codigo: r.cuerpo?.data?.[0]?.code || null
  };
}

/** Vuelve a dejar la casilla en blanco. Para probar y para deshacer. */
export async function limpiarAvisoFueraDeHorario(modulo, id) {
  await put(modulo, {
    data: [{ id: String(id), Aviso_Fuera_Horario: false, Motivo_Cierre: null, Vuelta_Habil: null }],
    trigger: [], // limpiar NO tiene que disparar nada
  });
  const j = await get(`${modulo}/${id}?fields=${CAMPOS_GUARDIA}`);
  const despues = (j.data || [])[0] || null;
  return { ok: despues?.Aviso_Fuera_Horario !== true, registro: despues };
}

// ─── RESPUESTA AUTOMATICA (Marcos) ─────────────────────────────────────────
//
// Mismo mecanismo que la guardia, y por la misma razon: `messages__s` es de
// solo lectura y el numero esta onboardeado a traves de Zoho como BSP, asi que
// la Cloud API de Meta devuelve (#200) desde una app propia. La unica puerta es
// que Zoho mande una plantilla aprobada.
//
// La plantilla es UNA sola y lleva un hueco:
//
//     Hola {{1}}, soy Marcos, del equipo de Start Companies.
//     {{2}}
//     Cualquier otra duda, escribime por aca.
//
// {{1}} = First_Name  ·  {{2}} = Respuesta_Automatica
//
// Las 40 respuestas entran por ese hueco. Meta aprueba el marco, no el
// contenido, exactamente igual que con `Vuelta_Habil` en la guardia.
//
// OJO: igual que en la guardia, esta escritura va con los workflows PRENDIDOS.
// Cuando la llamada llega aca, el mensaje ya sale. Los frenos viven antes, en
// `responder.js` y `autorespuesta.js`.
const CAMPOS_RESPUESTA = 'id,Full_Name,First_Name,Respuesta_Automatica,Enviar_Respuesta,Mobile,Phone';

/**
 * Escribe la respuesta y tilda la casilla que la manda. CONFIRMA releyendo:
 * si los campos todavia no existen en el layout, Zoho contesta 200 y los
 * ignora en silencio, y el agente reportaria mensajes que nunca salieron.
 */
export async function marcarRespuestaAutomatica(modulo, id, texto) {
  const r = await put(modulo, {
    data: [{ id: String(id), Respuesta_Automatica: texto, Enviar_Respuesta: true }],
    trigger: ['workflow'], // A PROPOSITO: esto es lo que manda el WhatsApp.
  });
  const j = await get(`${modulo}/${id}?fields=${CAMPOS_RESPUESTA}`);
  const despues = (j.data || [])[0] || null;
  const ok = despues?.Enviar_Respuesta === true && despues?.Respuesta_Automatica === texto;
  return {
    ok,
    http: r.http,
    codigo: r.cuerpo?.data?.[0]?.code || null,
    motivo: ok
      ? null
      : despues
        ? 'los campos no quedaron guardados: revisar que existan en el layout'
        : 'no se pudo releer el registro',
    registro: despues,
  };
}

/**
 * Destilda la casilla para que la proxima vez pueda volver a dispararse.
 * Se llama despues de confirmar el envio. NO dispara workflows.
 */
export async function limpiarRespuestaAutomatica(modulo, id) {
  await put(modulo, {
    data: [{ id: String(id), Enviar_Respuesta: false }],
    trigger: [],
  });
  const j = await get(`${modulo}/${id}?fields=${CAMPOS_RESPUESTA}`);
  const despues = (j.data || [])[0] || null;
  return { ok: despues?.Enviar_Respuesta !== true, registro: despues };
}

// ─── Confirmacion de reunion ─────────────────────────────────────────────────
// El cliente contesto Si/No al recordatorio de 24 h (o toco "Confirmo" /
// "Necesito reprogramar" en el WhatsApp de agendado). Se escribe en la REUNION
// (modulo Events), no en el lead: las reglas que mandan cadencias miran al lead
// y no se enteran. Ver [[project_confirmacion_reunion_hora_local]].
//
// `trigger: ['workflow']` A PROPOSITO: la regla `SC Respuesta confirmacion
// reunion` es la que manda el "gracias por confirmar" o el "elegi otro
// horario", y llama a la funcion que pinta el Google Calendar.
/**
 * Escribe cuando sale el Si/No (`Hora_de_confirmaci_n`) y el "recorda responder"
 * (`Hora_de_recordatorio`) en una reunion. Con trigger workflow a proposito: es
 * lo que hace que las reglas por fecha de Zoho programen el envio (verificado
 * 14-sep-2026). Solo Events, nunca el lead. Relee para confirmar que entro.
 */
/**
 * Crea la reunion de un CLIENTE (la que viene de Calendly / agendaclientes).
 * Trigger vacio a proposito: las reglas de recordatorio de Reuniones hoy leen
 * el telefono del lead y excluyen Clientes; disparar workflows no mandaria
 * nada util y si podria tocar cosas de venta. Relee para confirmar que existe.
 */
export async function crearReunionCliente(datos) {
  const { Tipo_de_reuni_n: _t, ...sinTipo } = datos;
  const r = await post('Events', { data: [sinTipo], trigger: [] });
  const d = r.cuerpo?.data?.[0];
  const id = d?.details?.id || null;
  if (!id) return { ok: false, http: r.http, error: JSON.stringify(d || r.cuerpo).slice(0, 200) };
  // Segundo paso, CON workflows: Tipo = Clientes. Es la edicion que despierta
  // "SC Cliente agendada" (WhatsApp de reserva al Contacto) y la que hace que
  // Zoho programe el recordatorio de 30 min por fecha. Las reglas de venta
  // tambien se evaluan, pero leen el telefono del lead (vacio aca): no mandan.
  const w = await put('Events', { data: [{ id, Tipo_de_reuni_n: 'Clientes' }], trigger: ['workflow', 'blueprint'] });
  const j = await get(`Events/${id}?fields=id,Event_Title,Tipo_de_reuni_n`);
  const tipo = j.data?.[0]?.Tipo_de_reuni_n;
  return { ok: tipo === 'Clientes', id, http: r.http, error: tipo === 'Clientes' ? null : `Tipo quedo ${tipo} (${w.http})` };
}

/**
 * El Contacto no tenia Mobile y el cliente dejo su WhatsApp en Calendly (pregunta
 * obligatoria desde el 15-sep-2026): se completa, y solo si estaba VACIO. Un
 * Mobile ya cargado no se pisa: es el que matchea las conversaciones de
 * WhatsApp en el CRM, y cambiarlo partiria el hilo. Trigger vacio, releer.
 */
export async function completarMobileContacto(contactoId, mobile) {
  const r = await put('Contacts', { data: [{ id: contactoId, Mobile: mobile }], trigger: [] });
  const j = await get(`Contacts/${contactoId}?fields=id,Mobile`);
  const quedo = j.data?.[0]?.Mobile || null;
  return { ok: quedo === mobile, http: r.http, quedo };
}

// Transicion "Cancelar" del blueprint Circuito de Clientes (Reuniones): -None- -> Cancelada.
const TRANSICION_CANCELAR = '6698625000057804020';

/**
 * La reserva se cancelo en Calendly: se marca el titulo y, ademas, se aprieta el boton
 * "Cancelar" del blueprint (Estatus = Cancelada + motivo). Sin el Estatus, el Si/No de
 * 24 h, el aviso de 30 min y una respuesta tardia le seguian llegando al cliente: las
 * reglas de cliente solo frenan cuando el Estatus del Meet deja de estar vacio
 * (candado del 16-sep-2026). Confirmacion no se toca (mandaria WhatsApp).
 * La transicion es la misma que usa el equipo desde la ficha: no tiene acciones.
 */
export async function cancelarReunionCliente(eventId, titulo) {
  const nuevo = /^\[CANCELADA\]/.test(titulo || '') ? titulo : `[CANCELADA] ${titulo || ''}`.trim();
  const r = await put('Events', { data: [{ id: eventId, Event_Title: nuevo }], trigger: [] });
  const code = r.cuerpo?.data?.[0]?.code;
  if (code !== 'SUCCESS') return { ok: false, http: r.http, error: JSON.stringify(r.cuerpo?.data?.[0] || r.cuerpo).slice(0, 160) };
  const t = await put(`Events/${eventId}/actions/blueprint`, {
    blueprint: [{ transition_id: TRANSICION_CANCELAR, data: { Motivo_de_cancelaci_n: 'El cliente cancelo la reserva desde Calendly.' } }],
  });
  const j = await get(`Events/${eventId}?fields=id,Status_del_Meet`);
  const estatus = j.data?.[0]?.Status_del_Meet || null;
  // El titulo ya quedo: si la transicion falla (la reunion no esta en el blueprint, p. ej.
  // una vieja) se avisa pero no se considera fallida la cancelacion.
  return { ok: true, http: r.http, error: null, estatus, transicion: estatus === 'Cancelada' ? 'ok' : JSON.stringify(t.cuerpo).slice(0, 160) };
}

export async function agendarRecordatorio(eventId, conf, rec) {
  const iso = (d) => d.toISOString().slice(0, 19) + '+00:00';
  const datos = { id: eventId, Hora_de_confirmaci_n: iso(conf) };
  if (rec) datos.Hora_de_recordatorio = iso(rec);
  const r = await put('Events', { data: [datos], trigger: ['workflow'] });
  const j = await get(`Events/${eventId}?fields=Hora_de_confirmaci_n,Hora_de_recordatorio`);
  const quedo = j.data?.[0]?.Hora_de_confirmaci_n || null;
  const code = r.cuerpo?.data?.[0]?.code;
  return { ok: Boolean(quedo), http: r.http, quedo, error: code === 'SUCCESS' ? null : JSON.stringify(r.cuerpo?.data?.[0] || r.cuerpo).slice(0, 160) };
}

/**
 * Una reunion de venta que quedo pisada por otra reserva del mismo lead (ver
 * reprogramar.js). Se cierra igual que lo hace el Flow de Cal con una reagenda:
 * `[REAGENDADA]` en el titulo + Confirmacion = No asiste, con `trigger: []`, asi
 * no sale el "elegi otro horario" (la regla `SC Respuesta confirmacion reunion`)
 * y las reglas de 24 h y 30 min la dejan de lado.
 *
 * Tambien se vacian las horas programadas. Si no, una `Hora_de_recordatorio` que
 * quedo de la confirmacion dispara `Cancelacion reagendar` (criterio No asiste) y
 * le llega "Ayer nos avisaste que no podias" a alguien que dijo Si y reservo otra
 * (caso Maria del mar Gargari, 11-oct-2026).
 */
const HORAS_PROGRAMADAS = { Hora_de_confirmaci_n: null, Hora_de_recordatorio: null, Hora_tercer_aviso: null, Hora_recordatorio_3h: null };

export async function cerrarReunionReagendada(eventId, titulo) {
  const nuevo = /^\[REAGENDADA\]/.test(titulo || '') ? titulo : `[REAGENDADA] ${titulo || ''}`.trim();
  const r = await put('Events', { data: [{ id: eventId, Event_Title: nuevo, Confirmaci_n: 'No asiste', ...HORAS_PROGRAMADAS }], trigger: [] });
  const j = await get(`Events/${eventId}?fields=Event_Title,Confirmaci_n`);
  const quedo = j.data?.[0] || {};
  const ok = /^\[REAGENDADA\]/.test(quedo.Event_Title || '') && quedo.Confirmaci_n === 'No asiste';
  return { ok, http: r.http, error: ok ? null : JSON.stringify(r.cuerpo?.data?.[0] || r.cuerpo).slice(0, 160) };
}

/**
 * Turno liberado por no confirmar (liberar-sin-confirmar.js). `[CANCELADA]` + No asiste,
 * trigger []: no sale el "entendido, liberamos ese horario" y el de 30 min la deja de lado.
 */
export async function liberarReunion(eventId, titulo) {
  const nuevo = /^\[CANCELADA\]/.test(titulo || '') ? titulo : `[CANCELADA] ${titulo || ''}`.trim();
  const r = await put('Events', { data: [{ id: eventId, Event_Title: nuevo, Confirmaci_n: 'No asiste', ...HORAS_PROGRAMADAS }], trigger: [] });
  const j = await get(`Events/${eventId}?fields=Event_Title,Confirmaci_n`);
  const quedo = j.data?.[0] || {};
  const ok = /^\[CANCELADA\]/.test(quedo.Event_Title || '') && quedo.Confirmaci_n === 'No asiste';
  return { ok, http: r.http, error: ok ? null : JSON.stringify(r.cuerpo?.data?.[0] || r.cuerpo).slice(0, 160) };
}

export async function confirmarReunion(eventId, valor) {
  if (!["Confirm\xF3", "No asiste"].includes(valor)) throw new Error(`valor invalido: ${valor}`);
  const r = await put("Events", {
    data: [{ id: eventId, Confirmaci_n: valor }],
    trigger: ["workflow"]
  });
  const j = await get(`Events/${eventId}?fields=Confirmaci_n`);
  const quedo = j.data?.[0]?.Confirmaci_n || null;
  return { ok: quedo === valor, http: r.http, quedo };
}

// ─── EL "NO" A LA CONFIRMACION (cancelaciones.js) ──────────────────────────

const errorDe = (r) => {
  const d = r.cuerpo?.data?.[0];
  return d?.code === 'SUCCESS' ? null : JSON.stringify(d || r.cuerpo).slice(0, 160);
};

/**
 * Programa el "¿pudiste encontrar otro horario?": escribe Hora_de_recordatorio y la
 * regla de Zoho `Cancelacion reagendar` (por ese campo, Confirmacion = No asiste) manda
 * el WhatsApp. Misma mecanica que el Si/No de 24 h.
 */
export async function programarRecordatorioCancelacion(eventId, cuando2) {
  const iso = cuando2.toISOString().slice(0, 19) + "+00:00";
  const r = await put("Events", { data: [{ id: eventId, Hora_de_recordatorio: iso }], trigger: ["workflow"] });
  const j = await get(`Events/${eventId}?fields=Hora_de_recordatorio`);
  const quedo = j.data?.[0]?.Hora_de_recordatorio || null;
  const ok = Boolean(quedo) && Math.abs(new Date(quedo).getTime() - cuando2.getTime()) < 6e4;
  return { ok, http: r.http, quedo, error: errorDe(r) };
}

/**
 * El lead pasa a Retargeting. Los leads en "Reunion Agendada" NO estan en el blueprint
 * (RECORD_NOT_IN_PROCESS, medido 20-sep-2026), asi que el estado se escribe directo y
 * los workflows de Zoho arman la cadencia al ver el cambio de estado. Relee el lead.
 */
export async function mandarARetargeting(leadId) {
  const r = await put('Leads', { data: [{ id: leadId, Lead_Status: 'Retargeting' }], trigger: ['workflow'] });
  const j = await get(`Leads/${leadId}?fields=Lead_Status,Retargeting,Nombre_retargeting,Fecha_Siguiente_Mensaje`);
  const l = j.data?.[0] || {};
  return { ok: l.Lead_Status === 'Retargeting', http: r.http, quedo: l, error: errorDe(r) };
}

/**
 * El lead pasa a No Show. Lo llama lib/matias-seguimiento.js cuando Matias se rinde con
 * un no-show ("ponelo en secuencia", Ignacio 23-sep-2026): recien ahi arranca la cadencia
 * de No Show del CRM, no antes, porque si no salian las dos juntas (20 de 24 leads tenian
 * las dos encima).
 *
 * RECONSTRUIDA el 23-sep-2026. La version original la escribio otra sesion directo en la
 * copia de netlify/functions/lib/conversaciones/ y una sincronizacion desde src/ la piso;
 * git no la tenia. Se rehizo desde el sitio que la llama: recibe el id del lead, escribe
 * Lead_Status = 'No Show' y devuelve { ok, error, quedo }. Mismo molde que mandarARetargeting.
 * SI ALGO DE LA CADENCIA DE NO SHOW SE COMPORTA RARO, EMPEZAR POR ACA.
 */
export async function mandarANoShow(leadId) {
  const r = await put('Leads', { data: [{ id: leadId, Lead_Status: 'No Show' }], trigger: ['workflow'] });
  const j = await get(`Leads/${leadId}?fields=Lead_Status,Retargeting,Nombre_retargeting,Fecha_Siguiente_Mensaje`);
  const l = j.data?.[0] || {};
  return { ok: l.Lead_Status === 'No Show', http: r.http, quedo: l, error: errorDe(r) };
}

/**
 * Programa el tercer toque ("tenemos la agenda completa"): escribe `Hora_tercer_aviso`
 * y la regla de Zoho manda la plantilla `confirmacion_agenda_llena`. Misma mecanica
 * que el Si/No. Ver tercer-aviso.js para por que existe y a que hora sale.
 */
export async function programarTercerAviso(eventId, cuando2) {
  const iso = cuando2.toISOString().slice(0, 19) + "+00:00";
  const r = await put("Events", { data: [{ id: eventId, Hora_tercer_aviso: iso }], trigger: ["workflow"] });
  const j = await get(`Events/${eventId}?fields=Hora_tercer_aviso`);
  const quedo = j.data?.[0]?.Hora_tercer_aviso || null;
  const ok = Boolean(quedo) && Math.abs(new Date(quedo).getTime() - cuando2.getTime()) < 6e4;
  return { ok, http: r.http, quedo, error: errorDe(r) };
}

/**
 * Programa el recordatorio de 3 h (solo a los que YA confirmaron): escribe
 * `Hora_recordatorio_3h` y la regla `Recordatorio 3 horas` manda `recordatorio_3_horas`.
 */
export async function programarRecordatorio3h(eventId, cuando2) {
  const iso = cuando2.toISOString().slice(0, 19) + "+00:00";
  const r = await put("Events", { data: [{ id: eventId, Hora_recordatorio_3h: iso }], trigger: ["workflow"] });
  const j = await get(`Events/${eventId}?fields=Hora_recordatorio_3h`);
  const quedo = j.data?.[0]?.Hora_recordatorio_3h || null;
  const ok = Boolean(quedo) && Math.abs(new Date(quedo).getTime() - cuando2.getTime()) < 6e4;
  return { ok, http: r.http, quedo, error: errorDe(r) };
}

/**
 * Nuestra marca de "esta la cancelamos nosotros para liberar el hueco". Hace falta
 * porque el Flow de Cal le pone [CANCELADA] al titulo igual que a una cancelacion del
 * cliente, y `canceladas()` descarta esos titulos: sin la marca, liberar el hueco
 * apagaba todo el seguimiento (24 h, 72 h, no-show). 'Cancelada' es un valor que el
 * modulo ya trataba como "sigue siendo nuestra" (ver el paso 1 de unaPasada).
 */
export async function marcarCancelada(eventId) {
  const r = await put('Events', { data: [{ id: eventId, Status_del_Meet: 'Cancelada' }], trigger: [] });
  const j = await get(`Events/${eventId}?fields=Status_del_Meet`);
  const quedo = j.data?.[0]?.Status_del_Meet || null;
  return { ok: quedo === 'Cancelada', http: r.http, quedo, error: errorDe(r) };
}

/**
 * Marca la reunion como "No asistio". Es el click que antes hacia Santi a mano y que
 * desde que liberamos el hueco (SC pintar reunion google borra el evento de Google) ya
 * no puede hacer nadie: la reunion desaparecio de su calendario. Con esto la levanta
 * lib/matias-noshow.js, que busca Status_del_Meet = "No asistio" modificadas en las
 * ultimas 48 h, y arranca su cadencia (ofrece horarios y reserva; 3 toques y cierra).
 *
 * OJO con el tilde: el picklist guarda internamente "Option 2", pero la API entiende
 * los valores VISIBLES y el visible lleva tilde. Ver mapeos.js lineas 99-111.
 */
// `reglas: false` (reprogramar.js): sin disparar el workflow que pasa el lead a No Show en el
// acto, asi va primero Matias y el CRM despues (orden del 23-sep). Matias lo levanta igual:
// mira Status_del_Meet + Modified_Time, no el estado del lead.
export async function marcarNoShow(eventId, { reglas = true } = {}) {
  let r = await put("Events", { data: [{ id: eventId, Status_del_Meet: "No asisti\xF3" }], trigger: reglas ? ["workflow"] : [] });
  if (r.cuerpo?.data?.[0]?.code === "RECORD_IN_BLUEPRINT") {
    const bp = await get(`Events/${eventId}/actions/blueprint`).catch(() => ({}));
    const t = (bp.blueprint?.transitions || []).find((x) => x.next_field_value === "No asisti\xF3");
    if (t) r = await put(`Events/${eventId}/actions/blueprint`, { blueprint: [{ transition_id: t.id, data: {} }] });
  }
  const j = await get(`Events/${eventId}?fields=Status_del_Meet`);
  const quedo = j.data?.[0]?.Status_del_Meet || null;
  return { ok: quedo === "No asisti\xF3", http: r.http, quedo, error: errorDe(r) };
}
