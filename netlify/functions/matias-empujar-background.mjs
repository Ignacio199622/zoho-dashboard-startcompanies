/*
 * Empujón a mano: Matías retoma leads ofreciendo horarios concretos.
 *
 *   POST /.netlify/functions/matias-empujar-background
 *   x-clave: <CALCOM_SECRET>
 *   { "telefonos": ["+34624392441", ...] }     leads puntuales
 *   { "todos": true }                          todos los que están en stand by
 *   { "retomar": ["+52155..."] }             vuelve a procesar el ÚLTIMO mensaje del lead
 *       como si recién llegara (para cuando Matías falló y el lead quedó esperando)
 *
 * "En stand by" (Ignacio, 14-sep): recibió la apertura, no agendó, no dijo que
 * no, y todavía no le ofrecimos horarios. Dos caminos según la ventana de 24 h
 * de WhatsApp:
 *   - abierta (el lead escribió hace < 24 h): texto libre del cerebro + horarios.
 *   - cerrada: plantilla `sdr_matias_horarios` con los horarios de mañana en su hora.
 * Los horarios ofrecidos quedan en `apertura-<tel>` para que "la de las 10" reserve.
 * Cuenta como un toque más de la cadencia. Lo que pasa con cada uno queda en su
 * hilo de #sdr-virtual-matias.
 */
import { getStore } from '@netlify/blobs';
import { env } from './lib/entorno.js';
import { get } from './lib/conversaciones/zoho.js';
import * as hilo from './lib/hilo.js';
import * as matias from './lib/matias.js';
import { proponer, origenPara, PLANTILLAS, nombreDe, plantillaPara, textoDe } from './lib/matias-cerebro.js';
import { aplicarAccion, contextoDeHoy, ofrecer } from './lib/matias-agenda.js';
import { estadoPlantillas } from './lib/matias-apertura.js';
import { responderComoMatias } from './whatsapp-webhook-background.mjs';

const H = 3600000;
const PLANTILLA = PLANTILLAS.horarios;
const digitos = (t) => String(t || '').replace(/\D/g, '');
const almacen = () => getStore({ name: 'matias', consistency: 'strong' });
const CAMPOS_LEAD = 'id,Lead_Status,Calendario,reserva,First_Name,Full_Name,Tag,Tipo,Email';

// Sale por la línea de la ficha del lead (`mandar` la resuelve).
const enviarPlantilla = (numero, primerNombre, libres, plantilla = PLANTILLA) => matias.mandar(numero, matias.plantilla(plantilla, [primerNombre, libres]));

/** Los que están en stand by: apertura enviada, sin cierre, sin fallo, sin horarios ofrecidos todavía. */
async function enStandBy() {
  const store = almacen();
  const { blobs } = await store.list({ prefix: 'apertura-' });
  const out = [];
  for (const b of blobs) {
    const e = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (!e || typeof e !== 'object' || !e.enviada || e.cerrado || e.frenado || e.fallo || e.espontaneo) continue;
    if (e.ofrecidos?.length || e.reserva || e.confirmacion || e.noshow) continue;
    out.push(b.key.replace('apertura-', ''));
  }
  return out;
}

export default async (req) => {
  if (req.method !== 'POST' || req.headers.get('x-clave') !== env.CALCOM_SECRET) return new Response('no', { status: 401 });
  const cuerpo = await req.json().catch(() => ({}));
  const ahora = new Date();
  if (Array.isArray(cuerpo.retomar) && cuerpo.retomar.length) {
    const hecho = [];
    for (const tel of cuerpo.retomar.map(digitos)) {
      const conversacion = await hilo.leer(tel, ahora);
      const ultimo = [...conversacion].reverse().find((h) => h.de === 'cliente');
      if (!ultimo) { hecho.push(`${tel}: sin mensaje del lead en las últimas 12 h`); continue; }
      const estado = await matias.estadoDe(tel);
      const lead = estado.lead ? ((await get(`Leads/${estado.lead}?fields=${CAMPOS_LEAD}`)).data || [])[0] || null : null;
      await matias.enHilo(tel, `🔁 Retomando el último mensaje del lead ("${String(ultimo.texto).slice(0, 60)}").`).catch(() => {});
      await responderComoMatias({ de: tel, texto: ultimo.texto, cuando: new Date(ultimo.cuando) }, lead, ahora);
      hecho.push(`${tel}: retomado`);
    }
    return new Response(JSON.stringify({ retomar: hecho }), { headers: { 'Content-Type': 'application/json' } });
  }
  const enviar = env.MATIAS_ENVIAR === '1';
  // Fusible y plantillas por línea: cada lead sale por la línea de su ficha.
  const sano = matias.fusible(ahora);
  const plantillasPor = {};
  const plantillasDe = async (linea) => (plantillasPor[linea] ||= await estadoPlantillas(matias.LINEAS[linea].waba));
  const telefonos = cuerpo.todos ? await enStandBy() : (cuerpo.telefonos || []).map(digitos);
  console.log(`empujón: ${telefonos.length} leads`);
  const resumen = { empujados: 0, salteados: [] };

  for (const tel of telefonos) {
    const decir = (x) => matias.enHilo(tel, x).catch(() => {});
    try {
      const estado = await matias.estadoDe(tel);
      if (estado.cerrado) { resumen.salteados.push(`${tel}: cerrado`); continue; }
      const linea = await matias.lineaDe(tel, estado);
      const salud = await sano(linea);
      if (!salud.ok) { resumen.salteados.push(`${tel}: fusible`); await decir(`🛑 Empujón: fusible, ${salud.motivo}.`); continue; }
      const plantillas = await plantillasDe(linea);
      const j = estado.lead ? await get(`Leads/${estado.lead}?fields=${CAMPOS_LEAD}`) : { data: [] };
      const lead = (j.data || [])[0] || null;
      if (lead && (/agendad/i.test(String(lead.Lead_Status || '')) || lead.Calendario || lead.reserva === true)) {
        await matias.cerrarApertura(tel, 'agendó', ahora);
        await decir('🎯 Ya agendó. Matías se calla.');
        continue;
      }
      const conversacion = await hilo.leer(tel, ahora);
      const ultimoDelLead = [...conversacion].reverse().find((h) => h.de === 'cliente');
      const ventanaAbierta = ultimoDelLead && ahora - new Date(ultimoDelLead.cuando) < 24 * H;
      const nombre = nombreDe(lead, estado);

      let texto, ofrecidos;
      if (ventanaAbierta) {
        const p = await proponer({
          lead, numero: tel, hilo: conversacion, hoy: contextoDeHoy(tel, ahora), estado,
          ultimo: '(instrucción del equipo: retomá vos la conversación. No le pidas que reserve ni le mandes el link: ofrecele horarios concretos con accion ofrecer_horarios, con el día y la franja que el lead ya dijo, o mañana si no dijo nada. En "texto" una sola línea previa, natural, sin repetir lo que ya le dijiste.)',
        });
        if (!p.responde) { await decir(`🛑 Empujón: Matías no contesta: _${p.motivo}_`); continue; }
        if (p.accion?.tipo === 'descartar') { await matias.cerrarApertura(tel, `no califica (${p.motivo || 'no busca una LLC'})`, ahora); await decir(`🚫 Empujón: no califica, _${p.motivo || 'no busca una LLC'}_. Ficha cerrada.`); continue; }
        if (p.accion?.tipo !== 'ofrecer_horarios') p.accion = { tipo: 'ofrecer_horarios', dia: '', franja: '' };
        const ag = await aplicarAccion({ p, origen: origenPara(lead, estado), lead, numero: tel, estado, ahora });
        texto = ag.texto; ofrecidos = ag.ofrecidos || [];
        if (!texto || !ofrecidos.length) { await decir('🛑 Empujón: sin horarios para ofrecer.'); continue; }
        if (!enviar) { await decir(`💡 *Empujón propuesto (no se mandó):*\n> ${texto.split('\n').join('\n> ')}`); continue; }
        await matias.enviarTexto(tel, texto);
      } else {
        const of = await ofrecer({ origen: estado.origen || 'meta', numero: `+${tel}`, dia: '', franja: '', ahora });
        if (!of.opciones.length) { await decir('🛑 Empujón: sin horarios para ofrecer.'); continue; }
        const plantilla = plantillaPara('horarios', tel, plantillas);
        const aprobada = plantillas[plantilla] === 'APPROVED';
        texto = textoDe('horarios', plantilla, nombre, of.frase);
        ofrecidos = of.opciones;
        if (!enviar || !aprobada) { await decir(`💡 *Empujón propuesto (no se mandó: ${!enviar ? 'MATIAS_ENVIAR apagado' : `plantilla ${plantilla} ${plantillas[plantilla] || 'inexistente'}`}):*\n> ${texto}`); continue; }
        await enviarPlantilla(tel, nombre, of.frase, plantilla);
      }
      await hilo.agregar(tel, 'nosotros', texto, ahora);
      await matias.registrar({ numero: tel, de: 'matias', texto, cuando: ahora });
      await matias.marcarEvento(tel, { ofrecidos, ultimoToque: ahora.toISOString(), toques: (estado.toques || 1) + 1, respondioMatias: ahora.toISOString() }, ahora);
      resumen.empujados++;
      console.log(`empujado ${tel} (${ventanaAbierta ? 'texto' : 'plantilla'})`);
    } catch (e) {
      console.error(`empujón ${tel}: ${e.message}`);
      await decir(`⚠️ El empujón falló: ${e.message}`);
    }
  }
  console.log(`empujón: ${resumen.empujados} empujados, ${resumen.salteados.length} salteados`);
  return new Response('ok', { status: 200 });
};
