/*
 * RETOMAR LO QUE QUEDÓ SIN CONTESTAR.
 *
 * El 17-sep Zoho cortó el token 5 horas y Matías no contestó a nadie en ese rato (para un
 * número nuevo primero crea el lead en Zoho; sin Zoho, se calla). Esta función recorre los
 * hilos del +52 de las últimas horas y, para cada uno cuyo ÚLTIMO mensaje es del lead y
 * quedó sin respuesta, hace lo que el webhook hubiera hecho: crea el lead si falta y
 * contesta como Matías. También respeta a quien pidió que no le escriban.
 *
 * POST /.netlify/functions/matias-retomar-background con x-matias-key.
 *   { desde?: ISO, horas?: 8, noContactar?: ['5731...'], soloListar?: true }
 * Corre en background (hasta 15 min). Lo que hace queda en el hilo de Slack de cada lead.
 */
import { env } from './lib/entorno.js';
import { getStore } from '@netlify/blobs';
import * as hilo from './lib/hilo.js';
import * as matias from './lib/matias.js';
import { leadsConTelefono } from './lib/conversaciones/escritura.js';
import { responderComoMatias } from './whatsapp-webhook-background.mjs';

const digitos = (n) => String(n || '').replace(/\D/g, '');

export default async (req) => {
  if (!env.MATIAS_INGEST_KEY || req.headers.get('x-matias-key') !== env.MATIAS_INGEST_KEY) {
    return new Response('no', { status: 401 });
  }
  const cuerpo = await req.json().catch(() => ({}));
  const ahora = new Date();
  const horas = Number(cuerpo.horas || 8);
  const desde = cuerpo.desde ? new Date(cuerpo.desde) : new Date(ahora.getTime() - horas * 3600e3);
  const noContactar = new Set((cuerpo.noContactar || []).map(digitos));
  const soloListar = Boolean(cuerpo.soloListar);

  // Los hilos viven en el store "autorespuesta" como hilo-<numero>.
  const store = getStore({ name: 'autorespuesta', consistency: 'strong' });
  const { blobs } = await store.list({ prefix: 'hilo-' });
  const resumen = { revisados: 0, pendientes: [], contestados: [], cerrados: [], errores: [] };

  for (const b of blobs) {
    const numero = b.key.replace(/^hilo-/, '');
    if (!/^\d{8,15}$/.test(numero)) continue;
    const mensajes = await hilo.leer(numero, ahora);
    if (!mensajes.length) continue;
    const ultimo = mensajes[mensajes.length - 1];
    if (ultimo.de !== 'cliente') continue;
    if (new Date(ultimo.cuando) < desde) continue;
    resumen.revisados++;

    if (noContactar.has(numero)) {
      resumen.cerrados.push(numero);
      if (!soloListar) {
        await matias.cerrarApertura(numero, 'pidió que no le escriban', ahora);
        await matias.enHilo(numero, '🛑 Cerrado a mano: pidió que no le escriban más. Matías no le escribe.').catch(() => {});
      }
      continue;
    }
    const estado = await matias.estadoDe(numero);
    // El store de hilos es compartido con el 786 (Marcos). Solo son de Matías los números
    // que tienen ficha `apertura-<num>` (la crea la apertura o el primer mensaje al +52).
    // Sin eso, es una conversación del 786 y Matías NO tiene que meterse.
    if (!Object.keys(estado).length) continue;
    if (estado.cerrado) continue;
    resumen.pendientes.push({ numero, texto: String(ultimo.texto).slice(0, 80), cuando: ultimo.cuando });
    if (soloListar) continue;

    try {
      // 1. El lead en Zoho, como en el webhook.
      let lead = null;
      // Se busca con las variantes del 9 argentino y el 1 mexicano (Zoho guarda sin ellos).
      // Si la búsqueda falla, NO se crea: antes duplicar, mejor no contestar.
      const variantes = [numero];
      if (/^549\d{10}$/.test(numero)) variantes.push('54' + numero.slice(3));
      if (/^521\d{10}$/.test(numero)) variantes.push('52' + numero.slice(3));
      let busquedaOk = true;
      for (const v of variantes) {
        try { const enc = await leadsConTelefono(v); if (enc.length) { lead = enc[0]; break; } }
        catch { busquedaOk = false; }
      }
      if (!lead && !busquedaOk) throw new Error('Zoho no respondió la búsqueda por teléfono; no se crea el lead para no duplicar');
      if (!lead && estado.lead) lead = { id: estado.lead };
      if (!lead && !estado.lead) {
        const nuevo = await matias.crearLead({ numero, nombre: estado.nombre, referral: null });
        await matias.marcarEvento(numero, { enviada: ahora.toISOString(), origen: 'ctwa', lead: nuevo.id, toques: 1, ultimoToque: ahora.toISOString() }, ahora);
        await matias.enHilo(numero, `🆕 Lead creado en Zoho (retomado) · <https://crm.zoho.com/crm/org881745849/tab/Leads/${nuevo.id}|ver ficha>`).catch(() => {});
        lead = (await leadsConTelefono(numero).catch(() => []))[0] || { id: nuevo.id };
      }
      // 2. Contestar como Matías al último mensaje del lead.
      const m = { de: numero, texto: ultimo.texto, cuando: new Date(ultimo.cuando), nombre: estado.nombre || '' };
      await matias.enHilo(numero, '⏪ Retomado: Zoho estuvo cortado y este mensaje quedó sin contestar.').catch(() => {});
      await responderComoMatias(m, lead, ahora);
      resumen.contestados.push(numero);
    } catch (e) {
      resumen.errores.push({ numero, error: e.message.slice(0, 160) });
    }
  }
  console.log('retomar:', JSON.stringify(resumen));
  // El resumen va a #sdr (la función corre en background y no devuelve cuerpo).
  const NL = String.fromCharCode(10);
  const lista = (arr) => (arr.length ? arr.map((x) => (typeof x === 'string' ? x : x.numero + ' · "' + x.texto + '"')).join(NL + '• ') : 'ninguno');
  const partes = [
    '⏪ *Retomar' + (soloListar ? ' (solo listado)' : '') + '* · revisados ' + resumen.revisados,
    '*Pendientes (' + resumen.pendientes.length + '):*' + NL + '• ' + lista(resumen.pendientes),
  ];
  if (!soloListar) partes.push('*Contestados (' + resumen.contestados.length + '):*' + NL + '• ' + lista(resumen.contestados));
  partes.push('*Cerrados (' + resumen.cerrados.length + '):*' + NL + '• ' + lista(resumen.cerrados));
  if (resumen.errores.length) partes.push('*Errores (' + resumen.errores.length + '):*' + NL + '• ' + resumen.errores.map((e) => e.numero + ': ' + e.error).join(NL + '• '));
  await matias.enCanal(partes.join(NL)).catch(() => {});
  return new Response(JSON.stringify(resumen), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
