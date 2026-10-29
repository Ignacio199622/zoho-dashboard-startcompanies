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
 * CASI TODO ES LECTURA. La unica excepcion es el freno (lib/control-crm/frenar.js):
 * saca de la cadencia a los leads que en realidad ya son clientes, para que no
 * les llegue el pitch de apertura de LLC. Arranca en modo seco: mientras
 * FRENAR_CLIENTES no valga "1", calcula y lo cuenta en Slack sin tocar nada.
 * Con FRENAR_CLIENTES=0 no corre ni el calculo.
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
import { reglasPuente } from './lib/control-crm/puente.js';
import { cierre, arranque } from './lib/control-crm/mensajes.js';
import { frenar, textoFreno } from './lib/control-crm/frenar.js';
import { tokenActual } from './lib/control-crm/zoho.js';

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

    /*
     * Las del puente CRM -> pixel de Meta viven aparte (lib/control-crm/puente.js)
     * pero devuelven la misma forma, asi que se concatenan y el resto del flujo
     * no se entera.
     *
     * Esto faltaba: `control.js`, la version que se corre a mano, ya las
     * mergeaba desde el 5-sep-2026, pero esta funcion seguia llamando solo a
     * `evaluar()`. Resultado: en la maquina se veian 15 reglas y en produccion
     * corrian 11, sin que nada avisara de la diferencia.
     *
     * `?sin_puente=1` las apaga en una corrida suelta, por si hacen ruido.
     */
    const sinPuente = url.searchParams.get('sin_puente') === '1';
    const reglas = sinPuente ? evaluar(datos) : [...evaluar(datos), ...reglasPuente(datos)];

    const anterior = await store.get('ultima-foto', { type: 'json' });
    const evaluadas = comparar(reglas, anterior?.foto);

    /*
     * El freno corre ANTES de armar el mensaje, asi lo que frena se cuenta en la
     * misma corrida. Nunca puede tumbar el aviso: si falla, se anota y sigue,
     * porque un agente mudo es peor que uno que no frenó.
     */
    let resFreno = null;
    try {
      const modoFreno = process.env.FRENAR_CLIENTES ?? 'seco';
      if (modoFreno !== '0') {
        resFreno = await frenar(datos, { token: await tokenActual(), seco: seco || modoFreno !== '1' });
      }
    } catch (e) {
      console.log('freno: fallo y se sigue igual -', e.message);
    }

    const texto =
      modo === 'arranque'
        ? arranque(evaluadas, { informe: INFORME, cadencias: mapaCadencias(datos.leads) })
        // `desde` es la fecha de la foto anterior, y sirve para que el texto
        // diga "desde el viernes" en vez de "hoy" cuando el cierre arrastra un
        // fin de semana entero.
        : cierre(evaluadas, { informe: INFORME, desde: anterior?.fecha });

    // El cierre es el que fija la foto: el arranque solo reparte trabajo y no
    // tiene por que pisar la comparacion del dia.
    if (modo === 'cierre' && !seco) {
      await store.setJSON('ultima-foto', { fecha: inicio.toISOString(), foto: fotoDe(reglas) });
    }

    // Lo que frenó va pegado al aviso del dia, no en un mensaje aparte: es
    // parte de lo que paso hoy y separarlo duplica pings en el canal.
    const parrafoFreno = textoFreno(resFreno);
    const textoFinal = [texto, parrafoFreno].filter(Boolean).join('\n\n');

    const webhook = process.env.SLACK_WEBHOOK_CONTROL_CRM;
    let enviado = false;
    let detalle = null;

    if (!textoFinal) {
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
        body: JSON.stringify({ text: textoFinal }),
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
      // Queda en la bitacora para poder auditar despues a quien se frenó y
      // cuando: es el unico paso que escribe en Zoho.
      freno: resFreno && {
        candidatos: resFreno.candidatos,
        frenados: resFreno.frenados.map((f) => f.id),
        fallos: resFreno.fallos.length,
        seco: process.env.FRENAR_CLIENTES !== '1',
      },
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
