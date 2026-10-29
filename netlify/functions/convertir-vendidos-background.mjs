/*
 * Convierte (fusiona) el posible cliente activo de cada venta nueva DENTRO de su contacto, cada hora.
 *
 * POR QUE EXISTE (19-sep-2026). El portal crea el trato y el contacto sin tocar el lead: el lead sigue
 * vivo, la cadencia le sigue subiendo el contador después de la venta y la conversación de WhatsApp
 * queda del lado del "posible cliente". Al convertirlo al vender, el contador queda congelado (es el
 * dato "cerró en el mensaje N"), la conversación pasa al contacto y el origen viaja a la ficha.
 *
 * Misma receta que crm/auditoria/_convertir_vendidos.mjs (probada a mano sobre 26 casos):
 *   1) copiar el ORIGEN del lead a la ficha, solo donde esté vacía (trigger: [])
 *   2) alinear nombre y mail del lead con el contacto (Zoho exige que "coincidan perfectamente")
 *   3) convertir con overwrite:false, sin Deals, Contacts = el contacto, Accounts = la LLC del CONTACTO
 * Identidad: mail exacto o móvil exacto (últimos 9 dígitos). Por móvil solo si los nombres comparten
 * una palabra o el lead es un nombre de relleno ("WhatsApp", "Chat web"). Lo dudoso no se toca y se
 * deja en la bitácora. Interruptor: el blob `convertir-apagado`.
 */
import { getStore } from '@netlify/blobs';
import { tokenZoho } from './lib/aprobacion.js';

const API = 'https://www.zohoapis.com/crm/v6';
const DIAS = 3;
const MAX_POR_CORRIDA = 10;
const COPIAR = ['Lead_Source','Landing_Origen','Calendario','Canal_de_contacto','Referido','utm_source','utm_medium','utm_campaign','utm_content','utm_term','utm_id','Anuncio','Campa_a_Meta','Conjunto_de_anuncios','creativeId','Url_del_anuncio','Preview_del_anuncio','fbclid','fbc','fbp','leadchain0__Social_Lead_ID','Ultima_plantilla_enviada','Fecha_ultimo_mensaje','Version_de_cadencia'];
const hay = (v) => v !== null && v !== undefined && String(v).trim() !== '' && !(Array.isArray(v) && !v.length);
const tel9 = (t) => String(t || '').replace(/\D/g, '').slice(-9);
const transitoria = (v) => !v || /^WHATSAPP|^WhatsApp - |wwebjs|^Chatbot|Bot$|^TimelinesAI|^Sin dato|^Landing Page$|^Web Organic$/.test(String(v));
const pal = (t) => new Set(String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z]+/).filter((w) => w.length > 2));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export default async () => {
  const store = getStore({ name: 'agente-llamadas', consistency: 'strong' });
  const inicio = new Date();
  const reg = { agente: 'convertir-vendidos', inicio: inicio.toISOString(), candidatos: 0, fusionados: [], dudosos: [], errores: [], avisos: [] };
  const cerrar = async () => {
    reg.segundos = Math.round((Date.now() - inicio) / 1000);
    try { const b = (await store.get('bitacora-convertir', { type: 'json' })) || []; await store.setJSON('bitacora-convertir', [reg, ...b].slice(0, 60)); } catch (e) { console.error('bitacora', e); }
    console.log(JSON.stringify(reg));
    return new Response(JSON.stringify(reg), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    if (await store.get('convertir-apagado', { type: 'json' })) { reg.avisos.push('apagado por el blob convertir-apagado'); return await cerrar(); }
    const t = await tokenZoho();
    const H = { Authorization: `Zoho-oauthtoken ${t}`, 'Content-Type': 'application/json' };
    const zget = async (p) => { const r = await fetch(`${API}/${p}`, { headers: H }); return r.status === 204 ? {} : r.json(); };
    const zput = async (mod, data) => (((await (await fetch(`${API}/${mod}`, { method: 'PUT', headers: H, body: JSON.stringify({ data, trigger: [] }) })).json()).data) || [])[0] || {};

    const desde = new Date(Date.now() - DIAS * 86400e3).toISOString().slice(0, 10);
    const deals = (await zget(`Deals?fields=id,Deal_Name,Contact_Name,Created_Time&sort_by=Created_Time&sort_order=desc&per_page=100`)).data || [];
    const recientes = deals.filter((d) => (d.Created_Time || '') >= desde && d.Contact_Name?.id);
    const vistos = new Set();
    let hechos = 0;
    for (const d of recientes) {
      if (hechos >= MAX_POR_CORRIDA) { reg.avisos.push('tope por corrida'); break; }
      if (vistos.has(d.Contact_Name.id)) continue; vistos.add(d.Contact_Name.id);
      const c = (await zget(`Contacts/${d.Contact_Name.id}?fields=id,First_Name,Last_Name,Full_Name,Email,Mobile,Phone,Account_Name,${COPIAR.join(',')}`)).data?.[0];
      if (!c) continue;
      // el lead activo: por mail, si no por móvil
      let lead = null, via = '';
      const LF = `id,First_Name,Last_Name,Full_Name,Email,Mobile,Phone,Lead_Status,${COPIAR.join(',')}`;
      if (c.Email) { const j = await zget(`Leads/search?email=${encodeURIComponent(c.Email)}&fields=${LF}`); lead = (j.data || [])[0]; if (lead) via = 'mail'; }
      if (!lead && tel9(c.Mobile).length === 9) { const j = await zget(`Leads/search?phone=${encodeURIComponent(c.Mobile)}&fields=${LF}`); lead = (j.data || []).find((l) => tel9(l.Mobile) === tel9(c.Mobile) || tel9(l.Phone) === tel9(c.Mobile)); if (lead) via = 'móvil'; }
      if (!lead) continue;
      reg.candidatos++;
      if (via === 'móvil') {
        const relleno = /^(whatsapp|chat web|lead)/i.test(lead.Full_Name || '');
        const comparte = [...pal(lead.Full_Name)].some((w) => pal(c.Full_Name).has(w));
        if (!relleno && !comparte) { reg.dudosos.push(`${lead.Full_Name} -> ${c.Full_Name} (${d.Deal_Name})`); continue; }
      }
      try {
        const copiar = {};
        for (const k of COPIAR) { const v = lead[k]; if (!hay(v)) continue; if (k === 'Lead_Source' ? transitoria(c.Lead_Source) && !transitoria(v) : !hay(c[k])) copiar[k] = v; }
        if (Object.keys(copiar).length) { const r = await zput('Contacts', [{ id: c.id, ...copiar }]); if (r.code !== 'SUCCESS') throw new Error('copiar origen: ' + r.code); }
        await dormir(800);
        const r2 = await zput('Leads', [{ id: lead.id, First_Name: c.First_Name, Last_Name: c.Last_Name || c.Full_Name, Email: c.Email || null }]);
        if (r2.code !== 'SUCCESS') throw new Error('alinear: ' + r2.code);
        await dormir(800);
        const cuerpo = { overwrite: false, notify_lead_owner: false, notify_new_entity_owner: false, Contacts: { id: c.id } };
        if (c.Account_Name?.id) cuerpo.Accounts = { id: c.Account_Name.id };
        const r3 = (((await (await fetch(`${API}/Leads/${lead.id}/actions/convert`, { method: 'POST', headers: H, body: JSON.stringify({ data: [cuerpo] }) })).json()).data) || [])[0] || {};
        if (r3.code !== 'SUCCESS') throw new Error('fusionar: ' + (r3.code || '') + ' ' + (r3.message || ''));
        reg.fusionados.push(`${lead.Full_Name} -> ${c.Full_Name} (${d.Deal_Name}, por ${via}, ${Object.keys(copiar).length} campos)`);
        hechos++;
        await dormir(1200);
      } catch (e) {
        reg.errores.push({ lead: lead.id, contacto: c.id, mensaje: String(e.message).slice(0, 200) });
      }
    }
    return await cerrar();
  } catch (e) {
    reg.errores.push({ paso: 'corrida', mensaje: String(e.message).slice(0, 300) });
    return await cerrar();
  }
};

// A menos diez: después de canal-leads (a y cuarto) y de origen-tratos (menos cuarto).
export const config = { schedule: '50 * * * *' };
