/*
 * Agente: reinicia en el blueprint de su idioma los tratos que nacieron mal (10-nov-2026).
 *
 * El blueprint de Zoho se elige UNA vez, al crear el trato. Si el trato nace sin
 * Idioma (el PANEL lo crea asi: mapRequestToDeal no lo manda, y la API esta
 * freezada), cae en "Apertura LLC" (espanol) aunque el contacto sea brasilero, y
 * Zoho no deja moverlo. A Jorge Moro y Fernando (Brascast) les llegaron asi los
 * mensajes en espanol.
 *
 * Cada 5 minutos mira los tratos de Apertura creados en las ultimas 6 h que
 * siguen en "Apertura Confirmada" (la primera etapa: todavia no salio ningun
 * WhatsApp del blueprint) y estan en "Apertura LLC" siendo portugueses. A cada
 * uno lo reinicia igual que se hizo a mano con Jorge y Fernando:
 *   1. crea uno nuevo con los mismos campos, la MISMA LLC y el MISMO contacto,
 *      Idioma = Portugues  -> entra a "Apertura LLC_PT". El panel busca el trato
 *      por la LLC (el ultimo modificado), asi que sigue conectado.
 *   2. copia etiquetas y adjuntos.
 *   3. anota { nuevo: viejo } en venta-meta/reiniciados: la venta no se duplica en Meta.
 *   4. borra el viejo (queda 60 dias en la papelera de Zoho) y avisa en #control-crm.
 * Si algo sale mal en el medio, NO borra el viejo y avisa.
 *
 * Como sabe que es portugues: Idioma del trato, si no el del contacto, si no el
 * del lead con el mismo mail, si no el pais del contacto (Brasil / Portugal).
 * NO usa el +55 del telefono: hay hispanos viviendo en Brasil.
 * Ingles: no hay blueprint en ingles todavia; eso lo avisa control-idioma-tratos.
 *
 * Interruptor: blob `idioma-arreglar-apagado` en el store venta-meta, o
 * IDIOMA_ARREGLAR=0. En seco (solo dice que haria): correr({ store, seco: true }).
 */
import { getStore } from '@netlify/blobs';
import { env } from './lib/entorno.js';
import { get, tokenActual } from './lib/control-crm/zoho.js';
import { CANALES, avisarFalla } from './lib/aviso-falla.js';

const API = 'https://www.zohoapis.com/crm/v6';
const ZOHO_UI = 'https://crm.zoho.com/crm/org881745849/tab/Potentials';
const PT = 'Português';
const ETAPA_INICIAL = 'Apertura Confirmada';
const BP_ES = 'Apertura LLC';
const BP_PT = 'Apertura LLC_PT';
const PAISES_PT = /^(brasil|brazil|portugal)$/i;
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');

// Lo que nunca se copia: lo pone Zoho, o lo decide el reinicio.
const FUERA = new Set(['id', 'Stage', 'Tag', 'Layout', 'Created_Time', 'Modified_Time', 'Created_By', 'Modified_By',
  'Last_Activity_Time', 'Stage_Modified_Time', 'Change_Log_Time__s', 'Record_Status__s', 'Locked__s',
  'Probability', 'Expected_Revenue', 'Pipeline', 'Idioma']);
const TIPOS_NO = new Set(['formula', 'autonumber', 'rollup_summary', 'fileupload', 'imageupload', 'subform',
  'multiselectlookup', 'profileimage']);

async function zoho(metodo, path, cuerpo) {
  const r = await fetch(`${API}/${path}`, {
    method: metodo,
    headers: { Authorization: `Zoho-oauthtoken ${await tokenActual()}`, 'Content-Type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const txt = await r.text();
  let j = {};
  try { j = txt ? JSON.parse(txt) : {}; } catch { j = { _raw: txt.slice(0, 300) }; }
  return { http: r.status, j };
}

async function postear(text) {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel: CANALES[0], text, unfurl_links: false }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
}

/** Pura: el idioma que le corresponde, o '' si no hay como saberlo. */
export function idiomaDestino({ trato, contacto, lead }) {
  if (trato?.Idioma) return trato.Idioma;
  if (contacto?.Idioma) return contacto.Idioma;
  if (lead?.Idioma) return lead.Idioma;
  const pais = String(contacto?.Mailing_Country || '').trim();
  if (PAISES_PT.test(pais)) return PT;
  return '';
}

/** Pura: los campos del trato viejo que van al nuevo. */
export function camposCopiables(viejo, metaCampos) {
  const ok = new Map(metaCampos.filter((f) => !f.read_only && !TIPOS_NO.has(f.data_type)).map((f) => [f.api_name, f]));
  const out = {};
  for (const [k, v] of Object.entries(viejo)) {
    if (k.startsWith('$') || FUERA.has(k) || !ok.has(k)) continue;
    if (v === null || v === '' || v === false || (Array.isArray(v) && !v.length)) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && v.id ? { id: v.id } : v;
  }
  return out;
}

async function reiniciar(resumen, metaCampos, idioma, store) {
  const viejo = (await get(`Deals/${resumen.id}`)).data?.[0];
  if (!viejo) throw new Error('no se pudo leer el trato completo');
  const campos = camposCopiables(viejo, metaCampos);
  campos.Idioma = idioma;
  campos.Stage = ETAPA_INICIAL;
  if (viejo.Layout?.id) campos.Layout = { id: viejo.Layout.id };

  // trigger solo blueprint: entra al proceso del idioma, sin volver a correr reglas de creacion.
  const c = await zoho('POST', 'Deals', { data: [campos], trigger: ['blueprint'] });
  const nuevo = c.j?.data?.[0]?.details?.id;
  if (!nuevo) throw new Error(`no se creo el trato nuevo: ${JSON.stringify(c.j).slice(0, 300)}`);

  const bp = (await get(`Deals/${nuevo}/actions/blueprint`)).blueprint?.process_info?.name || '';
  if (bp !== BP_PT) {
    await zoho('DELETE', `Deals?ids=${nuevo}&wf_trigger=false`);
    throw new Error(`el trato nuevo entro a "${bp || 'ningún blueprint'}" y no a ${BP_PT}; lo borré y el viejo quedó intacto`);
  }

  const tags = (viejo.Tag || []).map((t) => ({ name: t.name }));
  if (tags.length) await zoho('POST', `Deals/${nuevo}/actions/add_tags`, { tags, over_write: false });

  const adj = await get(`Deals/${viejo.id}/Attachments?fields=File_Name,Size`);
  let adjuntos = 0;
  for (const a of adj.data || []) {
    if (!Number(a.Size)) continue; // los de 0 bytes estan vacios en el original
    const bajada = await fetch(`${API}/Deals/${viejo.id}/Attachments/${a.id}`, {
      headers: { Authorization: `Zoho-oauthtoken ${await tokenActual()}` },
    });
    const fd = new FormData();
    fd.append('file', new Blob([await bajada.arrayBuffer()]), a.File_Name);
    const sub = await fetch(`${API}/Deals/${nuevo}/Attachments`, {
      method: 'POST', headers: { Authorization: `Zoho-oauthtoken ${await tokenActual()}` }, body: fd,
    });
    if (!sub.ok) throw new Error(`no se copio el adjunto ${a.File_Name} (${sub.status}); el viejo quedó intacto, revisar a mano`);
    adjuntos++;
  }

  const mapa = JSON.parse((await store.get('reiniciados')) || '{}');
  mapa[nuevo] = viejo.id;
  await store.set('reiniciados', JSON.stringify(mapa));

  const b = await zoho('DELETE', `Deals?ids=${viejo.id}&wf_trigger=false`);
  const borrado = b.j?.data?.[0]?.code === 'SUCCESS';
  return { nuevo, adjuntos, borrado };
}

/** El trabajo, inyectable para probarlo fuera de Netlify. */
export async function correr({ store, seco = false, incluirPruebas = false, soloIds = null, avisar = postear } = {}) {
  {
    if (env.IDIOMA_ARREGLAR === '0' || (await store.get('idioma-arreglar-apagado'))) {
      return 'apagado';
    }
    const desde = new Date(Date.now() - 6 * 3600e3);
    const criterio = encodeURIComponent(`((Created_Time:greater_than:${iso(desde)})and(Stage:equals:${ETAPA_INICIAL}))`);
    const j = await get(`Deals/search?criteria=${criterio}&per_page=50`);
    if (j._error) throw new Error(`Zoho: ${j._error} ${j._mensaje || ''}`);
    const tratos = (j.data || []).filter((t) => t.Type === 'Apertura' && (incluirPruebas || !/PRUEBA/i.test(t.Deal_Name || '')))
      .filter((t) => !soloIds || soloIds.includes(String(t.id))); // soloIds: para probar sobre un trato puntual

    const hechos = [];
    let meta = null;
    for (const t of tratos) {
      const bp = (await get(`Deals/${t.id}/actions/blueprint`)).blueprint?.process_info?.name || '';
      if (bp !== BP_ES) continue;
      const contacto = t.Contact_Name?.id
        ? (await get(`Contacts/${t.Contact_Name.id}?fields=Idioma,Email,Mailing_Country`)).data?.[0] : null;
      let lead = null;
      if (!t.Idioma && !contacto?.Idioma && contacto?.Email) {
        const l = await get(`Leads/search?email=${encodeURIComponent(contacto.Email)}&fields=Idioma`);
        lead = (l.data || []).find((x) => x.Idioma) || null;
      }
      const idioma = idiomaDestino({ trato: t, contacto, lead });
      if (idioma !== PT) continue;

      if (seco) { hechos.push({ t, seco: true }); continue; }
      meta = meta || (await get('settings/fields?module=Deals')).fields || [];
      try {
        const r = await reiniciar(t, meta, idioma, store);
        hechos.push({ t, ...r });
      } catch (e) {
        hechos.push({ t, error: e.message });
      }
    }
    if (!hechos.length) return `ok: ${tratos.length} tratos en ${ETAPA_INICIAL}, ninguno para reiniciar`;
    if (seco) return `seco, reiniciaria: ${hechos.map(({ t }) => `${t.Deal_Name} ${t.id}`).join(' | ')}`;

    await avisar([
      ':arrows_counterclockwise: *Tratos reiniciados en el blueprint en portugués* (nacieron en el de español; todavía no les había salido ningún mensaje)',
      ...hechos.map((h) => (h.error
        ? `• :warning: ${h.t.Deal_Name}: NO se pudo, ${h.error}`
        : `• <${ZOHO_UI}/${h.nuevo}|${h.t.Deal_Name}>: trato nuevo con la misma LLC y el mismo contacto${h.adjuntos ? `, ${h.adjuntos} adjunto(s)` : ''}. ${h.borrado ? 'El viejo se borró.' : ':warning: El viejo NO se pudo borrar: borrarlo a mano (' + h.t.id + ').'}`)),
      '_Se sigue normal con el trato nuevo. El panel lo encuentra por la LLC._',
    ].join('\n'));
    return `reiniciados: ${hechos.filter((h) => h.nuevo).length}, errores: ${hechos.filter((h) => h.error).length}`;
  }
}

export default async () => {
  try {
    const store = getStore({ name: 'venta-meta', consistency: 'strong' });
    return new Response(await correr({ store }));
  } catch (e) {
    await avisarFalla('Agente que reinicia tratos por idioma', e, 'Mirar netlify/functions/idioma-tratos-arreglar.mjs. Se apaga con el blob idioma-arreglar-apagado');
    return new Response('fallo', { status: 500 });
  }
};

export const config = { schedule: '*/5 * * * *' };
