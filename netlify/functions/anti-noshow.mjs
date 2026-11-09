/*
 * Agente anti no-show · Fase 0 (modo sombra), corriendo solo.
 *
 * NO MANDA NADA AL CLIENTE Y NO ESCRIBE EN EL CRM. Lee las reuniones de Zoho,
 * decide a quien le escribiria y que le diria, y lo deja asentado. Es el mismo
 * `sombra.js` que se corria a mano, ahora con reloj propio: hasta el 5-sep-2026
 * habia corrido UNA sola vez (10-ago), asi que la Fase 0 nunca junto la
 * evidencia que el README pide antes de pasar a la Fase 1.
 *
 * QUE VA A SLACK Y QUE NO. A Slack van SOLO las alertas nuevas, que son
 * problemas del CRM accionables hoy (una reunion a futuro con la cadencia de
 * retargeting prendida, una reunion sin nadie vinculado). Lo que "habria
 * mandado" queda en la bitacora para leerlo cuando se evalue soltar la Fase 1:
 * si eso fuera al canal, serian decenas de mensajes por dia sobre algo que no
 * paso, y el canal se silencia en una semana.
 *
 * Se avisa una sola vez por alerta (`avisadas`, en Blobs). Sin eso, la misma
 * reunion con el mismo problema se reporta cada hora hasta que sucede.
 *
 * No hace falta partirlo en -background: una corrida son ~3 segundos, muy lejos
 * de los 60 que mata Netlify.
 */
import { getStore } from '@netlify/blobs';
import { reunionesEnVentana, leadsPorId, contactosPorId } from './lib/anti-noshow/zoho.js';
import { decidir } from './lib/anti-noshow/reglas.js';
import { VENTANAS } from './lib/anti-noshow/config.js';

const H = 3600000;
const MAX_BITACORA = 60;
const MAX_POR_MENSAJE = 6;
const ZOHO_UI = 'https://crm.zoho.com/crm/org881745849/tab';

// Solo estas llegan al canal. `rescate_omitido` y `reuniones_duplicadas` quedan
// en la bitacora: son ruido comparadas con las otras dos.
const ALERTAS_QUE_AVISAN = new Set(['colision_retargeting', 'sin_vinculo', 'status_incoherente']);

const TITULO = {
  colision_retargeting: 'Reunion agendada CON la cadencia de retargeting prendida',
  sin_vinculo: 'Reunion sin ningun Lead ni Contacto vinculado',
  status_incoherente: 'Reunion a futuro ya marcada como cerrada',
};

async function aSlack(texto) {
  const url = process.env.SLACK_WEBHOOK_CONTROL_CRM;
  if (!url) return false;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texto }),
  });
  return r.ok;
}

// En hora de Argentina: Netlify corre en UTC y la reunion de las 13 salia "16:00".
const fecha = (iso) => new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(iso)) + ' AR';

export default async () => {
  const store = getStore({ name: 'anti-noshow', consistency: 'strong' });
  const inicio = new Date();
  const errores = [];

  try {
    const ahora = new Date();
    const desde = new Date(ahora.getTime() - (VENTANAS.rescate.hastaH + 1) * H);
    const hasta = new Date(ahora.getTime() + (VENTANAS.recordatorio.hastaH + 2) * H);

    const reuniones = await reunionesEnVentana({ desde, hasta });

    // Las reuniones apuntan a Leads (What_Id) o a Contactos (Who_Id).
    const idsLead = reuniones.filter((e) => e.What_Id?.id).map((e) => e.What_Id.id);
    const idsContacto = reuniones.filter((e) => !e.What_Id?.id && e.Who_Id?.id).map((e) => e.Who_Id.id);
    const [leads, contactos] = await Promise.all([
      idsLead.length ? leadsPorId(idsLead) : {},
      idsContacto.length ? contactosPorId(idsContacto) : {},
    ]);

    const r = decidir(reuniones, { ...leads, ...contactos }, ahora);

    // --- lo que se avisa, una sola vez por alerta ---
    const avisadas = new Set((await store.get('avisadas', { type: 'json' })) || []);
    const nuevas = r.alertas.filter(
      (a) => ALERTAS_QUE_AVISAN.has(a.tipo) && !avisadas.has(`${a.tipo}:${a.idEvento}`)
    );

    // 8-nov-2026, Ignacio: menos ruido. Antes salia un mensaje por corrida
    // (cada hora, 35 en dos semanas). Ahora lo nuevo se junta en una cola y
    // sale UNA vez por dia, en la corrida de las 9:45 de Argentina.
    const cola = (await store.get('cola', { type: 'json' })) || [];
    const enCola = new Set(cola.map((a) => `${a.tipo}:${a.idEvento}`));
    for (const a of nuevas) {
      const k = `${a.tipo}:${a.idEvento}`;
      if (!enCola.has(k)) cola.push({ tipo: a.tipo, idEvento: a.idEvento, nombre: a.nombre, inicio: a.inicio, detalle: a.detalle });
      avisadas.add(k);
    }
    if (nuevas.length) await store.setJSON('avisadas', [...avisadas].slice(-2000));

    const horaAR = Number(new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false }).format(ahora));
    const horaResumen = Number(process.env.ANTI_NOSHOW_HORA || 9);
    // 9-nov: una reunion que pasa ANTES del proximo resumen no puede esperar a
    // mañana (llegaba con la reunion ya hecha). Esas salen en esta corrida.
    // Y las que ya pasaron se descartan: avisarlas no sirve para nada.
    const proximoResumen = ahora.getTime() + (((horaResumen - horaAR + 24) % 24) || 24) * H;
    for (let i = cola.length - 1; i >= 0; i--) if (new Date(cola[i].inicio).getTime() < ahora.getTime()) cola.splice(i, 1);
    const urgentes = cola.filter((a) => new Date(a.inicio).getTime() < proximoResumen);
    const tocaResumen = horaAR === horaResumen || urgentes.length > 0;
    let enviado = false;
    if (tocaResumen && cola.length) {
      const porTipo = new Map();
      for (const a of cola) porTipo.set(a.tipo, [...(porTipo.get(a.tipo) || []), a]);

      const partes = [horaAR === horaResumen ? '*Anti no-show* · resumen del día (el agente no le escribió a nadie)' : '*Anti no-show* · reunión de hoy para revisar ya'];
      for (const [tipo, lista] of porTipo) {
        partes.push(`\n*${TITULO[tipo] || tipo}* · ${lista.length}`);
        for (const a of lista.slice(0, MAX_POR_MENSAJE)) {
          partes.push(`• ${a.nombre || 'sin nombre'} · ${fecha(a.inicio)} · <${ZOHO_UI}/Events/${a.idEvento}|ver reunión>`);
          if (tipo === 'colision_retargeting' && a.detalle) partes.push(`   ${a.detalle}`);
        }
        if (lista.length > MAX_POR_MENSAJE) partes.push(`   …y ${lista.length - MAX_POR_MENSAJE} más`);
      }
      enviado = await aSlack(partes.join('\n'));
      // Se vacia aunque Slack falle: si no, el mismo resumen se repetiria.
      await store.setJSON('cola', []);
    } else {
      await store.setJSON('cola', cola.slice(-300));
    }

    const reg = {
      id: inicio.toISOString(),
      agente: 'anti-noshow',
      fase: 0,
      segundos: Math.round((Date.now() - inicio) / 1000),
      reuniones: reuniones.length,
      habria_mandado: r.acciones.length,
      descartes: r.descartes.length,
      alertas: r.alertas.length,
      alertas_nuevas: nuevas.length,
      avisado: enviado,
      // El detalle de lo que habria mandado: esto es la evidencia de la Fase 0.
      acciones: r.acciones.map((a) => ({ tipo: a.tipo, nombre: a.nombre, inicio: a.inicio, faltanH: a.faltanH })),
      estado: 'ok',
    };

    const previa = (await store.get('bitacora', { type: 'json' })) || [];
    previa.unshift(reg);
    await store.setJSON('bitacora', previa.slice(0, MAX_BITACORA));

    console.log(
      `${reg.id.slice(0, 16).replace('T', ' ')}  reuniones=${reg.reuniones} habria_mandado=${reg.habria_mandado} alertas=${reg.alertas} nuevas=${reg.alertas_nuevas} (${reg.segundos}s)`
    );
    return new Response(JSON.stringify(reg), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    errores.push(String(e.message).slice(0, 300));
    const reg = { id: inicio.toISOString(), agente: 'anti-noshow', estado: 'fallo', errores };
    const previa = (await store.get('bitacora', { type: 'json' })) || [];
    previa.unshift(reg);
    await store.setJSON('bitacora', previa.slice(0, MAX_BITACORA));
    console.error('anti-noshow fallo:', String(e.message).slice(0, 300));
    return new Response(JSON.stringify(reg), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// A y 45, de 8:45 a 20:45 hora de Argentina. Los otros agentes corren en punto,
// y 15, y 20, y 30 y a y 5/20/35/50: este no se pisa con ninguno.
export const config = { schedule: '45 11-23 * * *' };
