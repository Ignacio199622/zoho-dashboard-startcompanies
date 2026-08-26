// Escritura en Zoho. Dos reglas, sin excepciones:
//
//   1. NUNCA se pisa un campo que ya tiene algo. Si una persona lo cargó a
//      mano, gana la persona. El agente solo llena huecos.
//   2. La nota siempre se puede agregar: las notas se suman, no reemplazan.
//
// Los picklists (Modalidad de Pago, Modalidad de Cierre) NO se tocan: sus
// valores son sobre el estado del pago y del cierre ("Pago Total", "No cerró"),
// no sobre el medio de pago, así que el dato que extrae el agente no encaja ahi.
import { env } from './fathom.js';

let cache = null;

async function token() {
  if (cache && Date.now() < cache.exp) return cache.v;
  const p = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const j = await (await fetch(`https://accounts.zoho.com/oauth/v2/token?${p}`, { method: 'POST' })).json();
  if (!j.access_token) throw new Error('Zoho no devolvio token');
  cache = { v: j.access_token, exp: Date.now() + 55 * 60 * 1000 };
  return j.access_token;
}

async function api(path, opciones = {}) {
  const t = await token();
  const r = await fetch(`https://www.zohoapis.com/crm/v6/${path}`, {
    ...opciones,
    headers: {
      Authorization: `Zoho-oauthtoken ${t}`,
      ...(opciones.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (r.status === 204) return {};
  const j = await r.json();
  if (j.status === 'error') throw new Error(`${path}: ${j.code} ${j.message}`);
  return j;
}

const vacio = (v) => v === null || v === undefined || String(v).trim() === '';

/** El texto de la nota que se adjunta al lead. */
export function armarNota(analisis, llamada) {
  const d = analisis;
  const L = [];
  L.push(`Analisis automatico de la llamada del ${String(llamada.fecha || '').slice(0, 10)}` +
    (llamada.minutos ? ` (${llamada.minutos} min)` : ''));
  L.push('');
  const f = (k, v) => { if (!vacio(v)) L.push(`${k}: ${v}`); };
  f('Resultado', d.resultado);
  f('Interes', d.nivel_de_interes);
  f('Atendio', d.vendedor);
  f('Pais', d.pais);
  f('Se dedica a', d.a_que_se_dedica);
  f('Motivo de la LLC', d.motivo_llc);
  f('Estructura', d.estructura);
  f('Estado de registro', d.estado_registro);
  f('Medio de pago mencionado', d.medio_de_pago);
  f('Precio discutido', d.precio_discutido);
  f('Objecion', d.objecion);
  f('Proximo paso', d.proximo_paso);
  f('Responsable del proximo paso', d.responsable_proximo_paso);
  if (d.senales_de_compra?.length) {
    L.push('');
    L.push('Senales de compra:');
    for (const s of d.senales_de_compra) L.push(`  - ${s}`);
  }
  if (d.riesgos?.length) {
    L.push('');
    L.push('Riesgos:');
    for (const s of d.riesgos) L.push(`  - ${s}`);
  }
  if (llamada.url) {
    L.push('');
    L.push(`Grabacion: ${llamada.url}`);
  }
  return L.join('\n');
}

/** La descripcion corta que va al campo Description, solo si esta vacio. */
export function armarDescripcion(analisis) {
  const d = analisis;
  const partes = [d.resumen];
  if (!vacio(d.objecion)) partes.push(`Objecion: ${d.objecion}`);
  if (!vacio(d.proximo_paso)) {
    const quien = d.responsable_proximo_paso ? ` (${d.responsable_proximo_paso})` : '';
    partes.push(`Proximo paso${quien}: ${d.proximo_paso}`);
  }
  return partes.filter(Boolean).join(' | ').slice(0, 30000);
}

/**
 * Que haria el agente con este lead. No escribe: devuelve el plan.
 * Un campo solo entra al plan si hoy esta vacio.
 */
export function planDeEscritura({ lead, analisis, llamada }) {
  const acciones = [];

  acciones.push({ tipo: 'nota', titulo: 'Analisis de llamada', contenido: armarNota(analisis, llamada) });

  if (vacio(lead.Description)) {
    acciones.push({ tipo: 'campo', campo: 'Description', valor: armarDescripcion(analisis) });
  } else {
    acciones.push({ tipo: 'omitido', campo: 'Description', motivo: 'ya tiene contenido' });
  }

  return acciones;
}

export async function agregarNota(leadId, titulo, contenido) {
  // Parent_Id va como objeto con el modulo; el par plano `Parent_Id` + `se_module`
  // que aceptaban versiones anteriores devuelve INVALID_DATA en la v6.
  const body = {
    data: [
      {
        Note_Title: titulo.slice(0, 120),
        Note_Content: contenido.slice(0, 32000),
        Parent_Id: { module: { api_name: 'Leads' }, id: leadId },
      },
    ],
  };
  const j = await api('Notes', { method: 'POST', body: JSON.stringify(body) });
  const r = (j.data || [])[0];
  if (r?.code !== 'SUCCESS') throw new Error(`nota: ${r?.code} ${r?.message}`);
  return r.details?.id;
}

export async function escribirCampos(leadId, campos) {
  const j = await api('Leads', { method: 'PUT', body: JSON.stringify({ data: [{ id: leadId, ...campos }] }) });
  const r = (j.data || [])[0];
  if (r?.code !== 'SUCCESS') throw new Error(`campos: ${r?.code} ${r?.message}`);
  return true;
}

/** Volver a leer el lead, para confirmar que quedo lo que se queria escribir. */
export async function releerLead(leadId) {
  const j = await api(`Leads/${leadId}?fields=id,Full_Name,Description`);
  return (j.data || [])[0] || null;
}

/** ¿Salio algun mensaje al cliente despues de tocar el lead? */
export async function huboEnvios(leadId, desde) {
  const tl = (await api(`Leads/${leadId}/__timeline?per_page=25`)).__timeline || [];
  return tl.filter((t) => {
    if (new Date(t.audited_time).getTime() < desde) return false;
    return /messagenotificationsent|email_notification|notification/i.test(t.action || '');
  });
}
