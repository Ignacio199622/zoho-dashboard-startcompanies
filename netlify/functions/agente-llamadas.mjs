/*
 * El agente de llamadas, corriendo solo.
 *
 * Cada hora busca llamadas nuevas en Fathom, las analiza y carga en Zoho lo que
 * hoy nadie carga: quien atendio, si cerro, la objecion y el proximo paso.
 * Despues deja en Blobs la lista de seguimiento y la bitacora, que es lo que
 * lee el dashboard.
 *
 * Dos limites deliberados:
 *  - Procesa pocas llamadas por corrida. Una funcion no puede correr eternamente,
 *    y con ~20 llamadas por semana alcanza de sobra.
 *  - Si al escribir en un lead el CRM le manda un mensaje al cliente, corta.
 *    Es preferible cargar menos datos que spamear.
 */
import { getStore } from '@netlify/blobs';
import { env } from './lib/entorno.js';
import { reunionesRecientes, transcripcionATexto, mailDelCliente, duracionMin } from './lib/fathom.js';
import { analizarLlamada } from './lib/extraer.js';
import { armarDescripcion, armarNota } from './lib/escribir.js';
import { usuarioDesdeNombre, estadoDelLead, modalidadDeCierre, canalDesdeLanding } from './lib/mapeos.js';
import { TITULOS_DE_VENTA, PATRONES_PRUEBA, MINIMO_LINEAS_TRANSCRIPCION } from './lib/config.js';
import { conReintento, dormir } from './lib/reintentar.js';

const MAX_POR_CORRIDA = 4;
const DIAS_ATRAS = 3;
const MAX_BITACORA = 100;

const vacio = (v) => v === null || v === undefined || String(v).trim() === '';
const norm = (m) => String(m || '').trim().toLowerCase();

export default async () => {
  const store = getStore({ name: 'agente-llamadas', consistency: 'strong' });
  const inicio = new Date();
  const errores = [];
  const avisos = [];
  let procesadas = 0;
  let escritas = 0;

  const cerrar = async (extra = {}) => {
    const fin = new Date();
    const reg = {
      id: inicio.toISOString(),
      disparador: 'programado',
      inicio: inicio.toISOString(),
      fin: fin.toISOString(),
      segundos: Math.round((fin - inicio) / 1000),
      procesadas,
      escritas,
      errores,
      avisos,
      estado: errores.length === 0 ? 'ok' : procesadas > 0 && errores.length >= procesadas ? 'fallo' : 'parcial',
      ...extra,
    };
    const previa = (await store.get('bitacora', { type: 'json' })) || [];
    previa.unshift(reg);
    await store.setJSON('bitacora', previa.slice(0, MAX_BITACORA));
    return reg;
  };

  try {
    for (const k of ['FATHOM_API_KEY', 'ZOHO_REFRESH_TOKEN', 'ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET']) {
      if (!env[k]) throw new Error(`Falta la variable ${k} en el sitio`);
    }

    // --- Zoho ---
    const p = new URLSearchParams({
      refresh_token: env.ZOHO_REFRESH_TOKEN,
      client_id: env.ZOHO_CLIENT_ID,
      client_secret: env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    });
    const tj = await conReintento(async () => {
      const j = await (await fetch(`https://accounts.zoho.com/oauth/v2/token?${p}`, { method: 'POST' })).json();
      if (!j.access_token) throw new Error('Zoho no devolvio token');
      return j;
    });
    const H = { Authorization: `Zoho-oauthtoken ${tj.access_token}` };
    const zoho = async (path, opts = {}) => {
      const r = await fetch(`https://www.zohoapis.com/crm/v6/${path}`, {
        ...opts,
        headers: { ...H, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      });
      if (r.status === 204) return {};
      return r.json();
    };

    // --- Cal.com, para la landing. Si falla, se sigue sin ese campo ---
    const landingPorMail = new Map();
    if (env.CALCOM_API_KEY) {
      try {
        const r = await conReintento(() =>
          fetch('https://api.cal.com/v2/bookings?take=100&sortStart=desc', {
            headers: { Authorization: `Bearer ${env.CALCOM_API_KEY}`, 'cal-api-version': '2024-08-13' },
          }).then((x) => x.json())
        );
        for (const b of r.data || []) {
          const f = b.bookingFieldsResponses || {};
          if (f.email && f.lp && !landingPorMail.has(norm(f.email))) landingPorMail.set(norm(f.email), f.lp);
        }
      } catch (e) {
        errores.push({ donde: 'cal.com', mensaje: String(e.message).slice(0, 200), contexto: {} });
        avisos.push({ texto: 'sin Cal.com no se completa la landing de origen' });
      }
    }

    // --- Fathom ---
    const yaProcesadas = new Set((await store.get('procesadas', { type: 'json' })) || []);
    const todas = await conReintento(() => reunionesRecientes(40));
    const desde = Date.now() - DIAS_ATRAS * 24 * 3600e3;

    const nuevas = todas
      .filter((m) => {
        const clave = m.recording_id || m.url;
        if (yaProcesadas.has(clave)) return false;
        const t = m.title || '';
        if (!TITULOS_DE_VENTA.test(t) || PATRONES_PRUEBA.test(t)) return false;
        if (!Array.isArray(m.transcript) || m.transcript.length < MINIMO_LINEAS_TRANSCRIPCION) return false;
        return new Date(m.scheduled_start_time || m.created_at).getTime() >= desde;
      })
      .slice(0, MAX_POR_CORRIDA);

    if (!nuevas.length) avisos.push({ texto: 'no habia llamadas nuevas' });

    // --- procesar ---
    const F = 'id,Full_Name,Email,Lead_Status,Landing_Origen,Modalidad_de_Cierre,Description,Owner';
    const analisisNuevos = [];

    for (const m of nuevas) {
      const clave = m.recording_id || m.url;
      const titulo = String(m.title || '').replace(/[^\x20-\x7EáéíóúüñÁÉÍÓÚÑ]/g, '').trim();
      const mail = mailDelCliente(m);
      try {
        if (!mail) {
          avisos.push({ texto: 'llamada sin mail de cliente', contexto: { titulo: titulo.slice(0, 40) } });
          yaProcesadas.add(clave);
          continue;
        }

        const { datos } = await conReintento(() =>
          analizarLlamada({
            titulo,
            fecha: m.scheduled_start_time,
            duracionMin: duracionMin(m),
            transcripcion: transcripcionATexto(m),
            resumenFathom: typeof m.default_summary === 'string' ? m.default_summary : null,
          })
        );
        analisisNuevos.push({ titulo, fecha: m.scheduled_start_time, minutos: duracionMin(m), url: m.url, mail, extraido: datos });

        const j = await zoho(`Leads/search?criteria=(Email:equals:${encodeURIComponent(mail)})&fields=${F}`);
        const lead = (j.data || [])[0];
        if (!lead) {
          avisos.push({ texto: 'la llamada no tiene lead en Zoho', contexto: { mail } });
          yaProcesadas.add(clave);
          procesadas++;
          continue;
        }

        const campos = {};
        if (vacio(lead.Description)) campos.Description = armarDescripcion(datos);
        const mc = modalidadDeCierre(datos.resultado);
        if (mc.valor && vacio(lead.Modalidad_de_Cierre)) campos.Modalidad_de_Cierre = mc.valor;
        const cn = canalDesdeLanding(landingPorMail.get(norm(mail)));
        if (cn.valor && vacio(lead.Landing_Origen)) campos.Landing_Origen = cn.valor;
        const es = estadoDelLead(datos.resultado);
        if (es.valor && !/no calificado/i.test(lead.Lead_Status || '')) campos.Lead_Status = es.valor;

        const u = usuarioDesdeNombre(datos.vendedor);
        if (!u.id) avisos.push({ texto: 'no se identifico al vendedor', contexto: { motivo: u.motivo } });

        const t0 = Date.now();
        const nota = {
          data: [
            {
              Note_Title: 'Analisis de llamada',
              Note_Content: armarNota(datos, { fecha: m.scheduled_start_time, minutos: duracionMin(m), url: m.url }).slice(0, 32000),
              Parent_Id: { module: { api_name: 'Leads' }, id: lead.id },
            },
          ],
        };
        const rn = await zoho('Notes', { method: 'POST', body: JSON.stringify(nota) });
        if ((rn.data || [])[0]?.code !== 'SUCCESS') throw new Error(`nota: ${(rn.data || [])[0]?.code}`);

        if (Object.keys(campos).length) {
          const r = await zoho('Leads', { method: 'PUT', body: JSON.stringify({ data: [{ id: lead.id, ...campos }] }) });
          const r0 = (r.data || [])[0];
          if (r0?.code !== 'SUCCESS') throw new Error(`campos: ${r0?.code} ${r0?.message}`);
        }
        escritas++;
        procesadas++;
        yaProcesadas.add(clave);

        // Corte de seguridad.
        const tl = (await zoho(`Leads/${lead.id}/__timeline?per_page=20`)).__timeline || [];
        const envios = tl.filter(
          (t) => new Date(t.audited_time).getTime() >= t0 - 5000 && /notification/i.test(t.action || '')
        );
        if (envios.length) {
          errores.push({ donde: 'disparo mensajes', mensaje: `${envios.length} envios al cliente`, contexto: { lead: lead.Full_Name } });
          avisos.push({ texto: 'CORTADO: el CRM disparo mensajes al editar' });
          break;
        }
        await dormir(500);
      } catch (e) {
        procesadas++;
        errores.push({ donde: 'procesar llamada', mensaje: String(e.message).slice(0, 200), contexto: { titulo: titulo.slice(0, 40) } });
      }
    }

    await store.setJSON('procesadas', [...yaProcesadas].slice(-2000));

    // --- la lista de seguimiento, acumulada ---
    if (analisisNuevos.length) {
      const previos = (await store.get('analisis', { type: 'json' })) || [];
      const todos = [...analisisNuevos, ...previos].slice(0, 500);
      await store.setJSON('analisis', todos);

      const dias = (f) => Math.floor((Date.now() - new Date(f).getTime()) / 864e5);
      const NOSOTROS = /santiago|ignacio|camila|belen|vendedor|start companies|ambos|equipo/i;
      const pendientes = todos
        .filter((x) => x.extraido?.resultado === 'no_cerro_quedo_pendiente')
        .map((x) => {
          const d = x.extraido;
          const r = String(d.responsable_proximo_paso || '');
          return {
            cliente: d.cliente || '(sin nombre)',
            mail: x.mail,
            dias: dias(x.fecha),
            interes: d.nivel_de_interes,
            queFalta: d.proximo_paso,
            lado: /^cliente$/i.test(r) ? 'cliente' : NOSOTROS.test(r) ? 'nosotros' : 'cliente',
            quien: NOSOTROS.test(r) ? r : null,
            riesgo: (d.riesgos || [])[0] || null,
            url: x.url,
          };
        })
        .sort((a, b) => {
          if (a.lado !== b.lado) return a.lado === 'nosotros' ? -1 : 1;
          const o = { alto: 0, medio: 1, bajo: 2 };
          return o[a.interes] - o[b.interes] || b.dias - a.dias;
        });
      await store.setJSON('pendientes', pendientes);
    }

    const reg = await cerrar();
    return new Response(JSON.stringify(reg), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    errores.push({ donde: 'corrida', mensaje: String(e.message).slice(0, 300), contexto: {} });
    const reg = await cerrar();
    return new Response(JSON.stringify(reg), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// Cada hora en punto. Con ~20 llamadas por semana sobra de lejos.
export const config = { schedule: '0 * * * *' };
