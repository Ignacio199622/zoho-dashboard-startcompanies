/*
 * El agente de conversaciones, corriendo en la nube.
 *
 * Lee los WhatsApp del CRM, clasifica lo que esta esperando respuesta y avisa
 * al equipo por Slack. Es el mismo agente que vivia en
 * agentes/conversaciones/vigilar.js y dependia de que la notebook estuviera
 * despierta: el 4-sep-2026 sus dos corridas fallaron con "fetch failed" porque
 * la tarea de Windows se disparo en el mismo segundo en que la maquina salia de
 * suspension, sin wifi todavia.
 *
 * SOLO LECTURA sobre Zoho: lee conversaciones y publica en Slack, nunca escribe
 * en el CRM.
 *
 * ESTA es la que hace el trabajo; la dispara conversaciones.mjs, que es la
 * programada. Estan separadas porque cada pasada consulta a Gemini por cada
 * conversacion nueva y puede tardar minutos; una funcion sincronica de Netlify
 * se corta muchisimo antes. El sufijo -background es lo que le dice a Netlify
 * que puede tardar. Si se renombra, se rompe.
 *
 * La memoria (hasta donde se leyo, a quien ya se aviso, los pares aprendidos)
 * vive en blobs y no en disco: en Netlify no hay disco que sobreviva entre
 * corridas. Se carga al empezar y se escribe al terminar, pase lo que pase.
 */
import { getStore } from '@netlify/blobs';
import { unaPasada } from './lib/conversaciones/correr.js';
import { HAY_SLACK, estaAbierto, HORA_INICIO, HORA_FIN } from './lib/conversaciones/config.js';
import * as estadoFs from './lib/conversaciones/estado.js';
import * as aprendizaje from './lib/conversaciones/aprendizaje.js';
import * as salud from './lib/conversaciones/salud.js';
import * as panorama from './lib/conversaciones/panorama.js';

// Los pares que se le muestran al modelo como ejemplos de tono. Se quedan los
// mas nuevos: la lista crecia sin freno en el .jsonl de la maquina y aca hay
// que escribirla entera en cada corrida.
const MAX_PARES = 400;
const MAX_BITACORA = 60;

const sello = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

export default async (req) => {
  const store = getStore({ name: 'conversaciones', consistency: 'strong' });
  const url = new URL(req.url);
  let seco = url.searchParams.get('seco') === '1';
  let forzar = url.searchParams.get('forzar') === '1';
  try {
    const cuerpo = await req.json();
    seco = cuerpo.seco ?? seco;
    forzar = cuerpo.forzar ?? forzar;
  } catch {
    /* sin cuerpo: quedan los de la query */
  }

  if (!HAY_SLACK && !seco) {
    console.error('Falta SLACK_WEBHOOK_URL en el entorno del sitio.');
    return new Response('sin webhook', { status: 500 });
  }

  // Fuera de horario se sale sin hacer nada, y sobre todo SIN mover el corte de
  // lectura. Lo que entra de noche queda esperando y sale entero en la primera
  // pasada de la mañana: no se pierde, se acumula.
  const abierto = estaAbierto();
  if (!abierto.abierto && !forzar) {
    console.log(`${sello()}  cerrado (${abierto.motivo}). Se avisa de ${HORA_INICIO} a ${HORA_FIN}, lun a vie.`);
    return new Response('cerrado');
  }

  // La memoria entra ANTES de cualquier otra cosa: el camino de error tambien
  // lee y escribe el estado, para no repetir el mismo aviso de fallo cada hora.
  estadoFs.usarMemoria(await store.get('estado', { type: 'json' }));
  aprendizaje.usarMemoria(await store.get('pares', { type: 'json' }));

  const volcar = async () => {
    if (seco) return;
    await store.setJSON('estado', estadoFs.contenido());
    await store.setJSON('pares', (aprendizaje.contenido() || []).slice(-MAX_PARES));
  };

  // La clave NO es 'bitacora' pelado: ese nombre ya lo reclama bajas-background,
  // que comparte este mismo store a proposito (las bajas son parte del mundo de
  // las conversaciones, solo que corren tambien de noche y los fines de semana).
  // Con el nombre repetido, cada uno pisaba la bitacora del otro y quedaba una
  // sola lista mezclada donde ninguno de los dos podia ver su propia historia.
  const anotar = async (reg) => {
    const previa = (await store.get('bitacora-conversaciones', { type: 'json' })) || [];
    await store.setJSON('bitacora-conversaciones', [reg, ...previa].slice(0, MAX_BITACORA));
  };

  const ahora = new Date();
  const inicio = Date.now();

  try {
    const r = await unaPasada({ avisar: !seco });

    // La salud se guarda aparte de la pasada: interesa igual si no hubo alertas.
    if (!seco) {
      const estado = estadoFs.leer();
      const avisos = await salud.avisarRecuperacion(estado, ahora);
      salud.acumular(estado, r, ahora);
      await salud.vigilarMudez(estado, r, ahora);

      // Las alertas salen todas las horas, una por caso. El panorama de lo que
      // sigue abierto sale cada 2 horas, para que lo que nadie tomo no se hunda
      // en el canal.
      if (panorama.toca(ahora) || forzar) {
        const p = await panorama.enviar(estadoFs.leer(), ahora);
        if (p?.enviado) console.log(`   panorama: ${p.pendientes} sin contestar, ${p.ventas} sin cerrar`);
      }

      await salud.resumenDelDia(estado, r, ahora);
      estadoFs.guardar(estado);
      for (const a of avisos) console.log(`   ${a}`);
    }

    console.log(
      `${sello()}  leidas=${r.leidas} esperando=${r.pendientes} alertas=${r.alertas.length} ` +
        `ventas=${r.ventasAbiertas} aprendidos=${r.aprendidos} costo=USD${r.costo.toFixed(4)}${seco ? ' (seco)' : ''}`
    );
    for (const a of r.alertas) {
      const rec = a.seguimiento?.accion === 'recordar' ? `[recordatorio ${a.seguimiento.numero}] ` : '';
      console.log(`   ${rec}${a.clase?.categoria} · ${a.ficha?.Full_Name || a.mobile_number__s} · ${a.clase?.resumen}`);
    }

    await volcar();
    await anotar({
      id: ahora.toISOString(),
      agente: 'conversaciones',
      segundos: Math.round((Date.now() - inicio) / 1000),
      leidas: r.leidas,
      pendientes: r.pendientes,
      alertas: r.alertas.length,
      ventasAbiertas: r.ventasAbiertas,
      aprendidos: r.aprendidos,
      costo: Number(r.costo.toFixed(4)),
      estado: 'ok',
    });
    return new Response('ok');
  } catch (e) {
    console.error(`${sello()}  FALLO: ${e.message}`);
    if (!seco) {
      // Que el fallo llegue a Slack. Si esto tambien falla, queda solo en el
      // log, pero no hay nada mas que se pueda hacer desde adentro.
      try {
        const estado = estadoFs.leer();
        const aviso = await salud.avisarFallo(estado, e, ahora);
        estadoFs.guardar(estado);
        console.error(`   aviso a Slack: ${aviso ? 'enviado' : 'omitido (ya se aviso hace poco)'}`);
      } catch (e2) {
        console.error(`   no se pudo avisar del fallo: ${e2.message}`);
      }
    }
    // El estado se escribe igual: adentro esta la marca de "ya avise de este
    // fallo", que es lo que evita repetir el mismo aviso cada hora.
    try {
      await volcar();
      await anotar({
        id: ahora.toISOString(),
        agente: 'conversaciones',
        segundos: Math.round((Date.now() - inicio) / 1000),
        estado: 'error',
        detalle: String(e?.message || e).slice(0, 500),
      });
    } catch { /* si tampoco se puede escribir el blob, queda el log */ }
    return new Response('error', { status: 500 });
  }
};
