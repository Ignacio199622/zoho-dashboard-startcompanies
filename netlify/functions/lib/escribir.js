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

const TEXTOS = {
  es: {
    titulo: 'Analisis de llamada',
    encabezado: 'Analisis automatico de la llamada del',
    resultado: 'Resultado', interes: 'Interes', atendio: 'Atendio', pais: 'Pais', dedica: 'Se dedica a',
    motivo: 'Motivo de la LLC', estructura: 'Estructura', estado: 'Estado de registro',
    pago: 'Medio de pago mencionado', precio: 'Precio discutido', objecion: 'Objecion',
    paso: 'Proximo paso', responsable: 'Responsable del proximo paso',
    senales: 'Senales de compra', riesgos: 'Riesgos', grabacion: 'Grabacion',
    valores: {},
  },
  pt: {
    titulo: 'Análise da ligação',
    encabezado: 'Análise automática da ligação de',
    resultado: 'Resultado', interes: 'Interesse', atendio: 'Atendeu', pais: 'País', dedica: 'Atividade',
    motivo: 'Motivo da LLC', estructura: 'Estrutura', estado: 'Estado de registro',
    pago: 'Meio de pagamento mencionado', precio: 'Preço discutido', objecion: 'Objeção',
    paso: 'Próximo passo', responsable: 'Responsável pelo próximo passo',
    senales: 'Sinais de compra', riesgos: 'Riscos', grabacion: 'Gravação',
    valores: {
      cerro_en_la_llamada: 'fechou na ligação',
      no_cerro_quedo_pendiente: 'não fechou, ficou pendente',
      no_calificado: 'não qualificado',
      solo_informativa: 'apenas informativa',
      soporte_cliente_actual: 'suporte a cliente atual',
      alto: 'alto', medio: 'médio', bajo: 'baixo',
      single_member: 'um sócio (single member)', multi_member: 'vários sócios (multi member)',
      cliente: 'cliente', start_companies: 'Start Companies',
    },
  },
};
const textos = (idioma) => TEXTOS[idioma] || TEXTOS.es;

/** El titulo de la nota, en el idioma de la llamada. */
export const tituloNota = (idioma) => textos(idioma).titulo;

/** El texto de la nota que se adjunta al lead. */
export function armarNota(analisis, llamada) {
  const d = analisis;
  const T = textos(llamada.idioma);
  const v = (x) => T.valores[x] ?? x;
  const L = [];
  L.push(`${T.encabezado} ${String(llamada.fecha || '').slice(0, 10)}` +
    (llamada.minutos ? ` (${llamada.minutos} min)` : ''));
  L.push('');
  const f = (k, x) => { if (!vacio(x)) L.push(`${k}: ${x}`); };
  f(T.resultado, v(d.resultado));
  f(T.interes, v(d.nivel_de_interes));
  f(T.atendio, d.vendedor);
  f(T.pais, d.pais);
  f(T.dedica, d.a_que_se_dedica);
  f(T.motivo, d.motivo_llc);
  f(T.estructura, v(d.estructura));
  f(T.estado, d.estado_registro);
  f(T.pago, d.medio_de_pago);
  f(T.precio, d.precio_discutido);
  f(T.objecion, d.objecion);
  f(T.paso, d.proximo_paso);
  f(T.responsable, v(d.responsable_proximo_paso));
  if (d.senales_de_compra?.length) {
    L.push('');
    L.push(`${T.senales}:`);
    for (const s of d.senales_de_compra) L.push(`  - ${s}`);
  }
  if (d.riesgos?.length) {
    L.push('');
    L.push(`${T.riesgos}:`);
    for (const s of d.riesgos) L.push(`  - ${s}`);
  }
  if (llamada.url) {
    L.push('');
    L.push(`${T.grabacion}: ${llamada.url}`);
  }
  return L.join('\n');
}

/** La descripcion corta que va al campo Description, solo si esta vacio. */
export function armarDescripcion(analisis, idioma) {
  const d = analisis;
  const T = textos(idioma);
  const partes = [d.resumen];
  if (!vacio(d.objecion)) partes.push(`${T.objecion}: ${d.objecion}`);
  if (!vacio(d.proximo_paso)) {
    const r = d.responsable_proximo_paso;
    const quien = r ? ` (${T.valores[r] ?? r})` : '';
    partes.push(`${T.paso}${quien}: ${d.proximo_paso}`);
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

/**
 * Campos de una REUNION (Events), con trigger vacio: las reuniones de cliente
 * no estan en ningun blueprint y no queremos despertar reglas.
 */
export async function escribirEvento(eventoId, campos) {
  const j = await api('Events', { method: 'PUT', body: JSON.stringify({ data: [{ id: eventoId, ...campos }], trigger: [] }) });
  const r = (j.data || [])[0];
  if (r?.code !== 'SUCCESS') throw new Error(`reunion: ${r?.code} ${r?.message}`);
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
