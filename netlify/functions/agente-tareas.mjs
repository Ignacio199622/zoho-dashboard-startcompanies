/*
 * Las reuniones internas se convierten en tareas del tablero, solas.
 *
 * Cada hora mira las llamadas nuevas de Fathom, descarta las de venta, y de las
 * del equipo saca las tareas con responsable y urgencia. Antes de escribir lee
 * lo que ya esta en Notion, asi que no duplica: el tablero es la verdad sobre
 * que esta abierto, no esta funcion.
 *
 * Si en una reunion se dice que algo ya esta hecho, lo cierra.
 */
import { reunionesRecientes, duracionMin } from './lib/fathom.js';
import { extraerTareas, TITULOS_DE_CLIENTE } from './lib/tareas.js';
import { tareasRecientes, crearTarea, marcarHecha, crearDecision, decisionesRecientes, fichasRecientes, crearFicha, ampliarFicha } from './lib/notion.js';
import { equipo, sincronizarResponsables } from './lib/equipo.js';
import { MINIMO_LINEAS_TRANSCRIPCION } from './lib/config.js';
import { conReintento, dormir } from './lib/reintentar.js';
import { leer, guardar } from './lib/almacen.js';

// Una funcion no puede correr eternamente y las reuniones largas tardan.
const MAX_POR_CORRIDA = 3;
const MIRAR = 8;

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

  try {
    const procesadas = new Set(await leer('tareas_procesadas', []));
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
        errores.push(`${(r.title || '').slice(0, 40)}: ${String(e.message).slice(0, 120)}`);
        continue;
      }
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

    await guardar('tareas_procesadas', [...procesadas]);
  } catch (e) {
    errores.push(String(e.message).slice(0, 200));
  }

  const resumen = {
    cuando: inicio.toISOString(),
    segundos: Math.round((Date.now() - inicio) / 1000),
    personas_en_el_equipo: undefined,
    reuniones_analizadas: analizadas,
    tareas_creadas: creadas,
    decisiones_registradas: registradas,
    fichas_nuevas: fichadas,
    fichas_ampliadas: ampliadas,
    tareas_cerradas: cerradas,
    errores,
  };

  // Bitacora propia, para poder mirar despues si dejo de andar.
  const bitacora = (await leer('bitacora_tareas', [])) || [];
  bitacora.unshift(resumen);
  await guardar('bitacora_tareas', bitacora.slice(0, 60));

  return new Response(JSON.stringify(resumen, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
};

// A los 20 de cada hora, para no pisarse con el agente de llamadas.
export const config = { schedule: '20 * * * *' };
