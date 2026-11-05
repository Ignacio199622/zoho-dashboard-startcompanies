/*
 * CADENCIAS TRABADAS (Ignacio, 4-nov-2026: "arreglelo", "siempre respetando idiomas").
 *
 * Dos veces por día busca leads que quedaron en "Nuevo MQL" sin cadencia que siga y los pone en la
 * etapa que corresponde POR LA API CON WORKFLOWS: así arrancan las reglas de esa etapa (las field
 * updates hechas por otra regla no despiertan reglas tipo field_update, por eso se trababan).
 *
 *   Form Apertura Brasil      -> Captación (500 = Sim) o Nurturing (Não). Idioma = Português.
 *   Sin clasificar (sin Tipo) -> Agendamiento (lo que hace "Activar flujo Agendamiento").
 *   Socios día 10 (Activar_Reglas = ruteo_nurturing_captacion) -> Retargeting.
 *
 * Idiomas: las reglas en español excluyen Português/English y cada etapa tiene su espejo PT/EN.
 * Al que no tiene Idioma y tiene teléfono de Brasil (+55) se le pone Português antes de moverlo.
 * Solo toca leads con más de 2 horas (las reglas de alta ya tuvieron su chance) y sin reserva.
 * Los "Marca Personal" sin estado NO se mueven solos (Ignacio: orgánico solo si es por LLC):
 * se listan en el resumen para que alguien los mire.
 * Resumen en #control-crm. CADENCIAS_TRABADAS_APLICAR=0 lo deja en modo vista.
 */
import { env } from './lib/entorno.js';
import { tokenActual } from './lib/control-crm/zoho.js';
import { avisarFalla } from './lib/aviso-falla.js';

const API = 'https://www.zohoapis.com/crm/v6';
const CANAL = env.CADENCIAS_TRABADAS_CANAL || 'C0BUSC1K8TY'; // #control-crm
const APLICAR = env.CADENCIAS_TRABADAS_APLICAR !== '0';
const ESPERA_MS = 2 * 3600e3;
const CAMPOS = 'Full_Name,Estado_pendiente,Lead_Status,Idioma,Cuentas_con_500_USD_para_invertir,reserva,Tipo,Tag,Activar_Reglas_del_flujo_de_trabajo,Mobile,Phone,Created_Time,Lead_Source';

const esBrasil = (l) => /^\+?55\d{10,11}$/.test(String(l.Mobile || l.Phone || '').replace(/[^\d+]/g, ''));
const tiene = (l, n) => (l.Tag || []).some((t) => t.name === n);
const idiomaPara = (l) => (!l.Idioma && esBrasil(l) ? { Idioma: 'Português' } : {});

async function buscar(H, criterio) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`${API}/Leads/search?criteria=${encodeURIComponent(criterio)}&fields=${CAMPOS}&per_page=200&page=${page}`, { headers: H });
    if (r.status === 204) break;
    const j = await r.json();
    if (!j.data) throw new Error(`búsqueda Zoho: ${JSON.stringify(j).slice(0, 160)}`);
    out.push(...j.data);
    if (!j.info?.more_records) break;
  }
  return out;
}

export function clasificar(leads, ahora = Date.now()) {
  const cambios = [];
  for (const l of leads) {
    // Estado_pendiente = lo está esperando ruteo-horario para la hora buena de su país: no tocarlo.
    if (l.reserva || l.Estado_pendiente || ahora - new Date(l.Created_Time).getTime() < ESPERA_MS) continue;
    if (tiene(l, 'Form Apertura Brasil')) {
      const no = /^n/i.test(String(l.Cuentas_con_500_USD_para_invertir || ''));
      cambios.push({ l, grupo: 'Brasil', set: { Idioma: 'Português', Lead_Status: no ? 'Nurturing' : 'Captación', ...(no ? {} : { flujo_normal: true }) } });
    } else if ([].concat(l.Activar_Reglas_del_flujo_de_trabajo || []).includes('ruteo_nurturing_captacion')) {
      cambios.push({ l, grupo: 'Socios día 10', set: { ...idiomaPara(l), Lead_Status: 'Retargeting', Activar_Reglas_del_flujo_de_trabajo: ['Ninguno'] } });
    } else if (tiene(l, 'Sin clasificar') && !l.Tipo) {
      cambios.push({ l, grupo: 'Sin clasificar', set: { ...idiomaPara(l), Lead_Status: 'Agendamiento' } });
    }
  }
  return cambios;
}

async function postear(text) {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel: CANAL, text, unfurl_links: false }),
  });
  const j = await r.json();
  if (!j.ok) console.log('slack', j.error);
}

export default async () => {
  try {
    const H = { Authorization: `Zoho-oauthtoken ${await tokenActual()}`, 'Content-Type': 'application/json' };
    const leads = await buscar(H, '(Lead_Status:equals:Nuevo MQL)');
    const cambios = clasificar(leads);
    const marca = (await buscar(H, '(Lead_Source:equals:Marca Personal)')).filter((l) => !l.Lead_Status && Date.now() - new Date(l.Created_Time).getTime() > ESPERA_MS);

    let ok = 0;
    if (APLICAR) {
      for (let i = 0; i < cambios.length; i += 20) {
        const lote = cambios.slice(i, i + 20).map((c) => ({ id: c.l.id, ...c.set }));
        const j = await (await fetch(`${API}/Leads`, { method: 'PUT', headers: H, body: JSON.stringify({ data: lote, trigger: ['workflow', 'blueprint'] }) })).json();
        for (const d of j.data || []) if (d.code === 'SUCCESS') ok++; else console.log('falla', JSON.stringify(d).slice(0, 200));
      }
    }
    if (!cambios.length && !marca.length) return new Response('nada trabado');

    const porGrupo = ['Brasil', 'Sin clasificar', 'Socios día 10']
      .map((g) => [g, cambios.filter((c) => c.grupo === g)]).filter(([, cs]) => cs.length)
      .map(([g, cs]) => `• *${g}* (${cs.length}): ${cs.slice(0, 8).map((c) => `${c.l.Full_Name} → ${c.set.Lead_Status}${c.set.Idioma ? ' (PT)' : ''}`).join(', ')}${cs.length > 8 ? '…' : ''}`);
    const texto = [
      `:wrench: *Cadencias trabadas* ${APLICAR ? `: moví ${ok}/${cambios.length} leads que estaban en Nuevo MQL sin cadencia` : `(modo vista, no moví nada): ${cambios.length} para mover`}`,
      ...porGrupo,
      marca.length ? `• *Marca Personal sin estado* (${marca.length}, no se mueven solos: mirar si preguntaron por LLC y pasar a Nurturing): ${marca.slice(0, 10).map((l) => l.Full_Name).join(', ')}` : '',
    ].filter(Boolean).join('\n');
    await postear(texto);
    return new Response(texto);
  } catch (e) {
    await avisarFalla('Cadencias trabadas', e, 'Mirar netlify/functions/cadencias-trabadas.mjs y el token de Zoho');
    return new Response('fallo', { status: 500 });
  }
};

// 10 y 16 h de Argentina.
export const config = { schedule: '0 13,19 * * *' };
