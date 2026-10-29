/*
 * Las reuniones internas se convierten en tareas del tablero, solas.
 *
 * Cada hora mira las llamadas nuevas de Fathom, descarta las de venta, y de las
 * del equipo saca las tareas con responsable y urgencia. Antes de escribir lee
 * lo que ya esta en Notion, asi que no duplica: el tablero es la verdad sobre
 * que esta abierto, no esta funcion.
 *
 * Si en una reunion se dice que algo ya esta hecho, lo cierra.
 *
 * ESTE ES EL WORKER. Lo dispara `agente-tareas.mjs`, que es el que tiene el
 * reloj. Van separados porque una funcion sincronica de Netlify se muere a los
 * 60 segundos y esto tarda mas: entre el 2 y el 5 de septiembre de 2026 el
 * agente quedo en un bucle de tres dias por exactamente eso (ver el comentario
 * del catch de abajo). Una `-background` tiene 15 minutos.
 */
import { reunionesRecientes, duracionMin } from './lib/fathom.js';
import { extraerTareas, TITULOS_DE_CLIENTE } from './lib/tareas.js';
import { tareasRecientes, crearTarea, marcarHecha, crearDecision, decisionesRecientes, fichasRecientes, crearFicha, ampliarFicha } from './lib/notion.js';
import { equipo, sincronizarResponsables } from './lib/equipo.js';
import { MINIMO_LINEAS_TRANSCRIPCION, PROVEEDOR_TAREAS } from './lib/config.js';
import { modeloActual } from './lib/cerebro.js';
import { conReintento, dormir } from './lib/reintentar.js';
import { leer, guardar } from './lib/almacen.js';

// Una funcion no puede correr eternamente y las reuniones largas tardan.
const MAX_POR_CORRIDA = 3;
const MIRAR = 8;

// Cuantas corridas se le insiste a una reunion que falla antes de dejarla ir.
// Sin este tope, una sola reunion que el modelo no puede procesar tapa a todas
// las que vienen atras, para siempre.
const MAX_INTENTOS = 3;

const clave = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export default async () => {
  const inicio = new Date();
  const errores = [];
  let creadas = 0;
  let cerradas = 0;
  let registradas = 0;
  let fichadas = 0;
  let ampliadas = 0;
  let analizadas = 0;

  // Fuera del try para que el `finally` pueda guardarlos aunque la corrida se
  // corte por la mitad.
  let procesadas = null;
  let intentos = null;
  const rendidas = [];

  try {
    procesadas = new Set(await leer('tareas_procesadas', []));
    intentos = (await leer('tareas_intentos', {})) || {};
    const reuniones = await reunionesRecientes(MIRAR);
    // El roster sale de la tabla "Equipo y roles" de Notion, no del codigo.
    const gente = await equipo();
    await sincronizarResponsables(gente.map((p) => p.nombre));
    const conocidas = await tareasRecientes(60);
    const decisiones = await decisionesRecientes(90);
    const fichas = await fichasRecientes();
    const abiertas = conocidas.filter((t) => t.estado !== 'Hecha');
    const yaEnTablero = new Set(conocidas.map((t) => clave(t.tarea)));

    for (const r of reuniones) {
      if (analizadas >= MAX_POR_CORRIDA) break;
      const id = String(r.recording_id || r.url);
      if (procesadas.has(id)) continue;

      const descartar =
        TITULOS_DE_CLIENTE.test(r.title || '') ||
        (r.transcript || []).length < MINIMO_LINEAS_TRANSCRIPCION;
      if (descartar) {
        procesadas.add(id);
        continue;
      }

      let res;
      try {
        res = await conReintento(() => extraerTareas(r, conocidas, gente, decisiones, fichas), { etiqueta: r.title });
      } catch (e) {
        // Un fallo tiene que contar como intento de la corrida. Cuando no
        // contaba, con las 8 reuniones fallando el agente se comia los cuatro
        // reintentos de cada una (10,5s de espera sola por reunion), se pasaba
        // de los 60s de la funcion y lo mataban antes de guardar nada. A la
        // hora siguiente volvia a empezar por las mismas ocho. Estuvo tres dias
        // asi, del 2 al 5 de septiembre de 2026, sin escribir una sola tarea.
        analizadas++;
        const veces = (intentos[id] || 0) + 1;
        intentos[id] = veces;
        errores.push(`${(r.title || '').slice(0, 40)}: intento ${veces}/${MAX_INTENTOS}: ${String(e.message).slice(0, 120)}`);
        if (veces >= MAX_INTENTOS) {
          // Se la deja ir: queda marcada como procesada para que no tape a las
          // que vienen atras, y queda dicho en la bitacora que se abandono.
          procesadas.add(id);
          delete intentos[id];
          rendidas.push({ titulo: (r.title || '').slice(0, 60), intentos: veces });
        }
        continue;
      }
      delete intentos[id];
      analizadas++;

      const d = res.datos;
      if (!d.es_reunion_interna) {
        procesadas.add(id);
        continue;
      }

      const link = r.share_url || r.url;
      const fecha = r.recording_start_time?.slice(0, 10);

      for (const t of d.tareas) {
        if (yaEnTablero.has(clave(t.tarea))) continue;
        try {
          await crearTarea({ ...t, reunion: link, fecha });
          yaEnTablero.add(clave(t.tarea));
          creadas++;
        } catch (e) {
          errores.push(`crear "${t.tarea.slice(0, 30)}": ${String(e.message).slice(0, 100)}`);
        }
        await dormir(350);
      }

      for (const dec of d.decisiones || []) {
        if (decisiones.some((x) => clave(x) === clave(dec.decision))) continue;
        try {
          await crearDecision({ decision: dec.decision, tema: dec.tema, porQue: dec.por_que, quien: dec.quien, reunion: link, fecha });
          decisiones.push(dec.decision);
          registradas++;
        } catch (e) {
          errores.push(`decision: ${String(e.message).slice(0, 100)}`);
        }
        await dormir(350);
      }

      // Biblioteca: lo que alguien explico. Una ficha no se cierra, se acumula;
      // si el tema ya existe se le suma una version en vez de duplicarla.
      for (const e of d.explicaciones || []) {
        const previa = e.amplia
          ? fichas.find((x) => clave(x.tema) === clave(e.amplia))
          : fichas.find((x) => clave(x.tema) === clave(e.tema));
        try {
          if (previa && previa.id) {
            await ampliarFicha(previa, { como: e.como_se_hace, quien: e.quien, reunion: link, fecha });
            previa.veces = (previa.veces || 1) + 1;
            ampliadas++;
          } else if (!previa) {
            const creada = await crearFicha({ tema: e.tema, area: e.area, como: e.como_se_hace, cuando: e.cuando_aplica, quien: e.quien, reunion: link, fecha });
            fichas.push({ id: creada?.id || null, tema: e.tema, cuando: e.cuando_aplica, veces: 1 });
            fichadas++;
          }
        } catch (err) {
          errores.push(`ficha "${String(e.tema).slice(0, 30)}": ${String(err.message).slice(0, 100)}`);
        }
        await dormir(350);
      }

      for (const h of d.ya_hechas) {
        const fila = abiertas.find((a) => clave(a.tarea) === clave(h.tarea_abierta));
        if (!fila) continue;
        try {
          await marcarHecha(fila.id, `Cerrada desde la reunión del ${fecha}: ${h.por_que}`);
          cerradas++;
        } catch (e) {
          errores.push(`cerrar: ${String(e.message).slice(0, 100)}`);
        }
        await dormir(350);
      }

      procesadas.add(id);
    }
  } catch (e) {
    errores.push(String(e.message).slice(0, 200));
  } finally {
    // El guardado va aca y no al final del try: si la corrida se corta a la
    // mitad, lo que ya se hizo tiene que quedar asentado igual. Antes se
    // guardaba recien despues del loop, asi que una corrida cortada perdia
    // todo el avance y la siguiente repetia el mismo trabajo.
    try {
      if (procesadas) await guardar('tareas_procesadas', [...procesadas]);
      if (intentos) await guardar('tareas_intentos', intentos);
    } catch (e) {
      errores.push(`guardar estado: ${String(e.message).slice(0, 100)}`);
    }
  }

  const resumen = {
    cuando: inicio.toISOString(),
    segundos: Math.round((Date.now() - inicio) / 1000),
    // Queda anotado con que modelo corrio. Sin esto no habia forma de saber si
    // produccion estaba usando el mismo proveedor que la maquina: el .env local
    // decia openai (sin credito) y el sitio decia gemini, y los errores de la
    // bitacora se leian como si fueran del mismo lado.
    modelo: `${PROVEEDOR_TAREAS}/${modeloActual()}`,
    personas_en_el_equipo: undefined,
    reuniones_analizadas: analizadas,
    tareas_creadas: creadas,
    decisiones_registradas: registradas,
    fichas_nuevas: fichadas,
    fichas_ampliadas: ampliadas,
    tareas_cerradas: cerradas,
    abandonadas: rendidas,
    errores,
  };

  // Bitacora propia, para poder mirar despues si dejo de andar. Que esta linea
  // no se escriba es la senal de que la corrida murio antes de terminar.
  const bitacora = (await leer('bitacora_tareas', [])) || [];
  bitacora.unshift(resumen);
  await guardar('bitacora_tareas', bitacora.slice(0, 60));

  console.log(
    `${inicio.toISOString().slice(0, 16).replace('T', ' ')}  analizadas=${analizadas} tareas=${creadas} decisiones=${registradas} fichas=${fichadas}+${ampliadas} cerradas=${cerradas} abandonadas=${rendidas.length} errores=${errores.length}`
  );

  return new Response(JSON.stringify(resumen, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
};

// Sin schedule: el reloj vive en agente-tareas.mjs.
