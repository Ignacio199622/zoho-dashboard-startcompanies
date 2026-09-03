/*
 * El Coach de Ventas SC, corriendo solo.
 *
 * Cada hora busca llamadas de venta nuevas en Fathom y publica en
 * #calls-startcompanies el informe del script, como seguir al cliente, y el
 * mensaje post-llamada con botones para aprobarlo.
 *
 * Reemplaza al Zap "Coach de Ventas SC" que dejo de postear el 17-jul-2026.
 *
 * NO ESCRIBE EN ZOHO. Lee (para cruzar el lead y ver la ventana de WhatsApp) y
 * publica en Slack. Zoho se toca unicamente cuando un vendedor aprueba, y eso
 * pasa en slack-interactividad.mjs.
 *
 * ESTA es la que hace el trabajo. La dispara coach-ventas.mjs, que es la
 * programada. Estan separadas porque una funcion sincronica de Netlify se corta
 * a los pocos segundos y aca cada llamada son DOS consultas al modelo, ~80s.
 *
 * Que pasaba sin esto (visto en vivo el 3-sep): la corrida publicaba la tarjeta
 * y la mataban antes de guardar `coach-publicadas`, que se escribe al final.
 * Como esa lista es la que evita repetir, a la hora siguiente volvia a publicar
 * la MISMA llamada. El canal se hubiera llenado de duplicados.
 *
 * El sufijo -background no es decorativo: es lo que le dice a Netlify que puede
 * tardar. Si se renombra, vuelve el problema.
 */
import { getStore } from '@netlify/blobs';
import { reunionesRecientes, transcripcionATexto, mailDelCliente, duracionMin } from './lib/fathom.js';
import { analizarLlamada } from './lib/extraer.js';
import { coachearLlamada } from './lib/coach.js';
import { mapaDeConversaciones, estadoVentana } from './lib/ventana.js';
import { telefonoDelLead } from './lib/telefono.js';
import { resolverVendedor } from './lib/vendedor.js';
import { buscarFicha } from './lib/ficha.js';
import { tokenZoho } from './lib/aprobacion.js';
import { publicar, HAY_SLACK, CANAL } from './lib/slack.js';
import { crear, actualizar } from './lib/casos.js';
import { TITULOS_DE_CLIENTE, PATRONES_PRUEBA, MINIMO_LINEAS_TRANSCRIPCION, MAX_CARACTERES_TRANSCRIPCION } from './lib/config.js';
import { conReintento, dormir } from './lib/reintentar.js';

// Dos llamadas al modelo por cada una: el techo por corrida es bajo a proposito.
// Con ~20 llamadas de venta por semana no se acumula, y una funcion no puede
// correr eternamente.
const MAX_POR_CORRIDA = 3;
const DIAS_ATRAS = 3;
const MAX_BITACORA = 60;

export default async () => {
  const store = getStore({ name: 'agente-llamadas', consistency: 'strong' });
  const inicio = new Date();
  const errores = [];
  const avisos = [];
  let procesadas = 0;
  let publicadasAhora = 0;

  const cerrar = async (extra = {}) => {
    const fin = new Date();
    const reg = {
      id: inicio.toISOString(),
      agente: 'coach-ventas',
      inicio: inicio.toISOString(),
      fin: fin.toISOString(),
      segundos: Math.round((fin - inicio) / 1000),
      procesadas,
      publicadas: publicadasAhora,
      errores,
      avisos,
      estado: errores.length ? (publicadasAhora ? 'con errores' : 'fallo') : 'ok',
      ...extra,
    };
    try {
      const b = (await store.get('bitacora-coach', { type: 'json' })) || [];
      await store.setJSON('bitacora-coach', [reg, ...b].slice(0, MAX_BITACORA));
    } catch (e) {
      console.error('no se pudo guardar la bitacora', e);
    }
    return new Response(JSON.stringify(reg), { headers: { 'Content-Type': 'application/json' } });
  };

  try {
    if (!HAY_SLACK) {
      avisos.push('sin SLACK_BOT_TOKEN: no hay donde publicar');
      return await cerrar();
    }

    const token = await conReintento(() => tokenZoho(), { etiqueta: 'token Zoho' });
    const zoho = async (path) => {
      const r = await fetch(`https://www.zohoapis.com/crm/v6/${path}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      return r.status === 204 ? {} : r.json();
    };

    // Una sola lectura de WhatsApp para toda la corrida.
    let mapaWA = new Map();
    try {
      mapaWA = await conReintento(() => mapaDeConversaciones(token, 48), { etiqueta: 'WhatsApp' });
    } catch (e) {
      errores.push({ paso: 'whatsapp', mensaje: String(e.message).slice(0, 200) });
      avisos.push('sin el mapa de WhatsApp no se sabe si la ventana esta abierta');
    }

    const yaPublicadas = new Set((await store.get('coach-publicadas', { type: 'json' })) || []);
    const desde = Date.now() - DIAS_ATRAS * 24 * 3600e3;
    // 20 alcanza: son ~20 llamadas de venta por semana y la ventana es de 3 dias.
    // Cada reunion viene con transcripcion completa, asi que pedir de mas cuesta.
    const todas = await conReintento(() => reunionesRecientes(20), { etiqueta: 'Fathom' });

    const nuevas = todas
      .filter((m) => {
        const clave = m.recording_id || m.url;
        if (yaPublicadas.has(clave)) return false;
        const t = m.title || '';
        if (!TITULOS_DE_CLIENTE.test(t) || PATRONES_PRUEBA.test(t)) return false;
        if (!Array.isArray(m.transcript) || m.transcript.length < MINIMO_LINEAS_TRANSCRIPCION) return false;
        return new Date(m.scheduled_start_time || m.created_at).getTime() >= desde;
      })
      .slice(0, MAX_POR_CORRIDA);

    if (!nuevas.length) avisos.push('no habia llamadas nuevas');

    // Se marcan ANTES de procesarlas, no despues. Si la corrida se muere en el
    // medio, se pierde una tarjeta; si se marcaran al final, se republicarian
    // todas en la corrida siguiente. Perder una es molesto, duplicar en el
    // canal del equipo es peor y ademas se paga dos veces el modelo.
    // Para reprocesar algo a mano: borrar su id de este blob.
    if (nuevas.length) {
      for (const m of nuevas) yaPublicadas.add(m.recording_id || m.url);
      await store.setJSON('coach-publicadas', [...yaPublicadas].slice(-400));
    }

    for (const m of nuevas) {
      const clave = m.recording_id || m.url;
      const titulo = String(m.title || '').replace(/[^\x20-\x7EáéíóúüñÁÉÍÓÚÑ]/g, '').trim();
      const mail = mailDelCliente(m);
      procesadas++;

      try {
        const transcripcion = transcripcionATexto(m).slice(0, MAX_CARACTERES_TRANSCRIPCION);
        const llamada = { titulo, fecha: m.scheduled_start_time, minutos: duracionMin(m), url: m.url };

        const { datos: analisis } = await conReintento(
          () =>
            analizarLlamada({
              titulo,
              fecha: llamada.fecha,
              duracionMin: llamada.minutos,
              transcripcion,
              resumenFathom: typeof m.default_summary === 'string' ? m.default_summary : null,
            }),
          { etiqueta: 'analisis' }
        );

        // Posibles clientes y, si no esta, Contactos: una venta que cierra en
        // la llamada ya fue convertida y en Leads no aparece mas.
        const lead = await buscarFicha(mail, token);
        if (!lead) avisos.push(`sin ficha en Zoho: ${mail || titulo.slice(0, 30)}`);

        const telefono = telefonoDelLead(lead);
        const ventana = estadoVentana(mapaWA, telefono);

        const { datos: coach } = await conReintento(
          () => coachearLlamada({ ...llamada, duracionMin: llamada.minutos, transcripcion, analisis, lead, ventana }),
          { etiqueta: 'coach' }
        );

        if (!lead && coach.mensaje) {
          coach.mensaje.por_que = `${coach.mensaje.por_que} (sin lead en Zoho: no se puede aprobar desde acá)`;
        }

        // El vendedor sale de las etiquetas de hablante de Fathom, que traen
        // el nombre completo. El texto de la llamada queda de respaldo.
        const vendedor = { ...resolverVendedor(m, analisis.vendedor), detectado: analisis.vendedor };

        const caso = await crear({ llamada, analisis, coach, lead, ventana, telefono, mail, vendedor });
        const r = await publicar(caso);
        await actualizar(caso.id, { slack: { canal: r.canal, ts: r.ts } });

        publicadasAhora++;
        await dormir(600);
      } catch (e) {
        errores.push({ paso: 'coachear', titulo: titulo.slice(0, 40), mensaje: String(e.message).slice(0, 200) });
      }
    }

    return await cerrar({ canal: CANAL });
  } catch (e) {
    errores.push({ paso: 'corrida', mensaje: String(e.message).slice(0, 300) });
    return await cerrar();
  }
};

// Sin schedule: la dispara coach-ventas.mjs.
