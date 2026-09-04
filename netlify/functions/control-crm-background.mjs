/*
 * Control CRM, corriendo en la nube.
 *
 * Es el mismo agente que vivia en crm/alertas/control.js y dependia de que la
 * notebook de Ignacio estuviera despierta. El 4-sep-2026 fallaron dos corridas
 * seguidas por eso: la tarea de Windows se disparo en el mismo segundo en que
 * la maquina salia de suspension, sin wifi todavia, y el primer fetch a Zoho
 * murio. Aca eso no puede pasar.
 *
 * Dos mensajes distintos a proposito:
 *   arranque  09:00 lun a vie  lo que tiene que hacer cada uno, repartido por persona
 *   cierre    16:30 todos los dias  solo lo que se desvio HOY, para arreglarlo antes de irse
 *
 * Si los dos contaran el stock acumulado, el canal se silencia en una semana.
 *
 * SOLO LECTURA sobre Zoho. Nunca escribe en el CRM.
 *
 * ESTA es la que hace el trabajo; la disparan control-crm-arranque.mjs y
 * control-crm-cierre.mjs, que son las programadas. Estan separadas porque la
 * corrida baja ~16.000 registros (8.400 leads, 3.500 eventos, y sigue) y tarda
 * varios minutos: una funcion sincronica de Netlify se corta muchisimo antes.
 * El sufijo -background no es decorativo, es lo que le dice a Netlify que puede
 * tardar. Si se renombra, se rompe.
 */
import { getStore } from '@netlify/blobs';
import { leerCrm, evaluar, comparar, fotoDe, mapaCadencias } from './lib/control-crm/reglas.js';
import { cierre, arranque } from './lib/control-crm/mensajes.js';

const INFORME = 'https://claude.ai/code/artifact/7ecf3afe-65d7-4bab-8eec-92ee5b3adea6';
const MAX_BITACORA = 60;

export default async (req) => {
  const store = getStore({ name: 'control-crm', consistency: 'strong' });
  const inicio = new Date();

  // El modo llega del disparador. Se acepta tambien por query para poder
  // probar a mano sin esperar al cron.
  const url = new URL(req.url);
  let modo = url.searchParams.get('modo');
  let seco = url.searchParams.get('seco') === '1';
  try {
    const cuerpo = await req.json();
    modo = cuerpo.modo || modo;
    seco = cuerpo.seco ?? seco;
  } catch {
    /* sin cuerpo: quedan los de la query */
  }
  if (modo !== 'arranque' && modo !== 'cierre') modo = 'cierre';

  const anotar = async (reg) => {
    const previa = (await store.get('bitacora', { type: 'json' })) || [];
    await store.setJSON('bitacora', [reg, ...previa].slice(0, MAX_BITACORA));
  };

  try {
    const datos = await leerCrm();
    const reglas = evaluar(datos);

    const anterior = await store.get('ultima-foto', { type: 'json' });
    const evaluadas = comparar(reglas, anterior?.foto);

    const texto =
      modo === 'arranque'
        ? arranque(evaluadas, { informe: INFORME, cadencias: mapaCadencias(datos.leads) })
        : cierre(evaluadas, { informe: INFORME });

    // El cierre es el que fija la foto: el arranque solo reparte trabajo y no
    // tiene por que pisar la comparacion del dia.
    if (modo === 'cierre' && !seco) {
      await store.setJSON('ultima-foto', { fecha: inicio.toISOString(), foto: fotoDe(reglas) });
    }

    const webhook = process.env.SLACK_WEBHOOK_CONTROL_CRM;
    let enviado = false;
    let detalle = null;

    if (!texto) {
      detalle = 'sin novedades, no se manda nada';
    } else if (seco) {
      detalle = 'seco: no se envio';
    } else if (!webhook) {
      // Modo sombra. Calcula todo y no le escribe a nadie, igual que los otros
      // agentes en su Fase 0.
      detalle = 'MODO SOMBRA: falta SLACK_WEBHOOK_CONTROL_CRM';
    } else {
      const r = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: texto }),
      });
      enviado = r.ok;
      if (!r.ok) detalle = `Slack respondio ${r.status}: ${(await r.text()).slice(0, 200)}`;
    }

    const fin = new Date();
    await anotar({
      id: inicio.toISOString(),
      agente: 'control-crm',
      modo,
      inicio: inicio.toISOString(),
      fin: fin.toISOString(),
      segundos: Math.round((fin - inicio) / 1000),
      enviado,
      detalle,
      estado: 'ok',
      totales: Object.fromEntries(
        evaluadas.map((r) => [r.clave, { total: r.total, nuevos: r.nuevos.length, resueltos: r.resueltos }])
      ),
    });

    console.log(`control-crm ${modo}: ${enviado ? 'enviado' : detalle || 'sin enviar'}`);
    return new Response('ok');
  } catch (e) {
    // Un fallo tiene que quedar escrito. Un agente que se muere en silencio es
    // peor que uno que no existe: nadie se entera de que dejo de avisar.
    console.error('control-crm fallo', e);
    await anotar({
      id: inicio.toISOString(),
      agente: 'control-crm',
      modo,
      inicio: inicio.toISOString(),
      fin: new Date().toISOString(),
      enviado: false,
      estado: 'error',
      detalle: String(e?.message || e).slice(0, 500),
    });
    return new Response('error', { status: 500 });
  }
};
