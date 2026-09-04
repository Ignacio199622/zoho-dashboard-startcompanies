// Los dos mensajes de #control-crm.
//
//   arranque  09:00 lunes a viernes: la auditoría repartida POR PERSONA.
//             Cada uno abre lo suyo y lo cierra.
//   cierre    16:30 todos los días: lo que se desvió HOY, para arreglarlo en la
//             hora y media que queda antes de irse.
//
// La diferencia importa. El de la mañana reparte trabajo de fondo; el de la
// tarde es corto y urgente. Si los dos contaran el stock acumulado, el canal se
// silencia en una semana.
import { porPersona, responsableDe } from './responsables.js';

const SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function fechaLarga(d = new Date()) {
  return `${SEMANA[d.getDay()]} ${d.getDate()}-${MES[d.getMonth()]}`;
}

const punto = (nivel) => (nivel === 'alto' ? '🔴' : '🟠');
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

/**
 * 09:00 · qué tiene que hacer cada uno.
 *
 * Reparte por persona y le da a cada una una tanda corta, lo más viejo primero,
 * que es lo que más tiempo lleva roto. Mañana salen los que sigan abiertos.
 */
export function arranque(evaluadas, { porTanda = 4, informe, cadencias } = {}) {
  const conDeuda = evaluadas.filter((r) => r.total > 0);
  if (!conDeuda.length) {
    return `*🩺 Control CRM · ${fechaLarga()}*\n\n🎉 No quedó nada pendiente. Primera vez.`;
  }

  const total = conDeuda.reduce((n, r) => n + r.total, 0);
  const l = [
    `*🩺 Control CRM · ${fechaLarga()}*`,
    `*Lo de hoy.* Quedan ${total} pendientes en total; abajo va lo que le toca a cada uno.`,
    '',
  ];

  // Primero el que más deuda tiene: es donde más rinde el rato de trabajo.
  const equipos = [...porPersona(conDeuda).entries()]
    .map(([quien, reglas]) => ({ quien, reglas, deuda: reglas.reduce((n, r) => n + r.total, 0) }))
    .sort((a, b) => b.deuda - a.deuda);

  for (const { quien, reglas, deuda } of equipos) {
    l.push(`*${quien}* — ${deuda} pendientes`);
    // Solo el tema más grande de cada persona: una tanda que entre en una mañana.
    const orden = [...reglas].sort((a, b) =>
      (a.nivel === b.nivel ? b.total - a.total : a.nivel === 'alto' ? -1 : 1));
    for (const r of orden.slice(0, 2)) {
      l.push(`${punto(r.nivel)} ${r.titulo} · quedan ${r.total}`);
      const cola = [...r.casos].sort((a, b) => new Date(a.creado || 0) - new Date(b.creado || 0));
      for (const c of cola.slice(0, porTanda)) l.push(`   · <${c.link}|${c.texto}>`);
    }
    const resto = orden.slice(2);
    if (resto.length) {
      l.push(`   _y además: ${resto.map((r) => `${r.titulo} (${r.total})`).join(' · ')}_`);
    }
    l.push('');
  }

  l.push('_Cada uno abre los suyos y los cierra. Mañana vuelven a salir los que sigan abiertos._');
  if (cadencias) l.push('', ...mapa(cadencias));
  if (informe) l.push('', `Todo el detalle → ${informe}`);
  return l.join('\n');
}

/**
 * El pie del aviso de las 9:00: en qué fase está cada retargeting.
 *
 * No lleva links ni responsable porque no es una tarea, es el estado del motor.
 * Van los dos mensajes donde se amontona la gente, que es donde una cadencia se
 * traba, y los envíos que vencieron esta semana.
 */
function mapa({ activos, filas }) {
  const l = [`*En qué fase está cada retargeting* · ${activos} leads con el flag prendido`];
  for (const f of filas) {
    const picos = f.picos.map((p) => `mensaje ${p.mensaje}: ${p.cuantos}`).join(' · ');
    const venc = f.vencidos ? ` · ⚠️ ${f.vencidos} vencidos esta semana` : '';
    l.push(`• *${f.cadencia}* — ${f.total} · ${picos}${venc}`);
  }
  return l;
}

/**
 * 16:30 · lo que se desvió hoy.
 *
 * Es el mensaje corto: lo que apareció en el día y todavía se puede arreglar
 * antes de irse. Si no apareció nada y no se resolvió nada, no se manda.
 */
export function cierre(evaluadas, { informe } = {}) {
  const conNovedad = evaluadas.filter((r) => r.nuevos.length > 0);
  const limpias = evaluadas.filter((r) => r.nuevos.length === 0 && !r.primeraVez);
  const resueltos = evaluadas.reduce((n, r) => n + r.resueltos, 0);

  if (!conNovedad.length && !resueltos) return null;

  const nuevosTotal = conNovedad.reduce((n, r) => n + r.nuevos.length, 0);
  const l = [`*🩺 Control CRM · ${fechaLarga()}*`];

  if (nuevosTotal) {
    l.push(`*Se desviaron ${plural(nuevosTotal, 'cosa hoy', 'cosas hoy')}.* Se pueden arreglar antes de irse:`, '');
    for (const r of conNovedad) {
      l.push(`${punto(r.nivel)} *${r.titulo}* · ${r.nuevos.length} — ${responsableDe(r.clave)}`);
      for (const c of r.nuevos.slice(0, 5)) l.push(`   · <${c.link}|${c.texto}>`);
      if (r.nuevos.length > 5) l.push(`   · y ${r.nuevos.length - 5} más`);
      l.push('');
    }
  }

  if (resueltos) l.push(`✅ Hoy se resolvieron *${resueltos}* casos.`, '');
  if (limpias.length) l.push(`🟢 Sin novedades en: ${limpias.map((r) => r.titulo).join(' · ')}`);
  if (informe) l.push('', `Detalle completo → ${informe}`);
  return l.join('\n');
}
