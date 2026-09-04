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
import { token, get } from './zoho.js';

const API = 'https://www.zohoapis.com/crm/v6';

// La transicion "Desactivar Retargeting" del blueprint "Retargeting Apertura".
// Se usa como respaldo: primero se busca por nombre entre las transiciones que
// Zoho ofrece para ese lead, asi sigue funcionando si Adrian la recrea con otro
// id.
export const TRANSICION_BAJA_ID = '6698625000056477152';
export const TRANSICION_BAJA_NOMBRE = 'Desactivar Retargeting';

// Estados en los que el lead ya esta afuera: no hay nada que apagar.
export const ESTADOS_YA_FUERA = ['No Interesado', 'Fuera de flujo'];

// `Fecha_Siguiente_Mensaje` ya no maneja la cadencia de apertura (la maneja
// `Lead_Status`), pero DOS reglas la siguen leyendo y son las que corresponden a
// estos tipos de trato. Para esos leads, apagar el blueprint no alcanza.
export const TIPOS_QUE_LEEN_LA_FECHA = ['Cuenta Bancaria', 'Renovación', 'Renovacion'];

const CAMPOS_LEAD =
  'id,Full_Name,Lead_Status,Retargeting,Fecha_Siguiente_Mensaje,Tipo,Mobile,Phone,Email';

async function put(path, cuerpo) {
  const r = await fetch(`${API}/${path}`, {
    method: 'PUT',
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

/** Como esta el lead ahora. */
export async function leerLead(id) {
  const j = await get(`Leads/${id}?fields=${CAMPOS_LEAD}`);
  return (j.data || [])[0] || null;
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
