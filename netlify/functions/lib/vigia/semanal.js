// El informe SEMANAL de mejoras. Los lunes, por DM de Slack, a Pablo Gijon
// (9:00) y a Ignacio Campo (10:00).
//
// No le pide nada a Zoho: se arma con
//   - las corridas diarias del vigia guardadas en el store `vigia` (`corrida/<ISO>`)
//   - la bitacora de Control CRM (store `control-crm`)
// y UNA llamada a Gemini que junta los temas parecidos de distintos dias y
// propone las 5 mejoras. Las CUENTAS no las hace Gemini: el modelo solo dice
// que temas van juntos y los numeros se suman aca, para que "apareció 7 veces"
// sea verdad y no una estimacion.
import { generar } from '../conversaciones/gemini.js';
import { TITULOS } from './crm.js';
import { corta } from './informe.js';

const MODELO = process.env.MODELO_GEMINI || 'gemini-3.8-flash';
export const DIAS = 7;

// Quien hace que. Gemini elige de esta lista para "quién lo haría". Se puede
// pisar con VIGIA_RESPONSABLES (mismo formato, una persona por linea).
const RESPONSABLES_POR_DEFECTO = `Benja: panel de clientes, portal, API, pagos y firmas dentro del panel
Pablo Gijón: Zoho CRM, flujos, reglas, plantillas de WhatsApp y Matías (el bot SDR)
Ignacio Campo: equipo de atención y ventas, procesos internos y respuestas a clientes
Ignacio (founder): web, landings, marketing y decisiones de producto`;
const responsables = () => process.env.VIGIA_RESPONSABLES || RESPONSABLES_POR_DEFECTO;

/** Las trabas del CRM de la semana, sumando los "nuevos" de cada cierre. */
export function crmDeLaSemana(bitacora, ahora = new Date()) {
  const piso = ahora - DIAS * 864e5;
  const cierres = (bitacora || [])
    .filter((r) => r.agente === 'control-crm' && r.modo === 'cierre' && r.estado === 'ok' && r.totales)
    .filter((r) => new Date(r.id) >= piso);
  if (!cierres.length) return { cierres: 0, reglas: [] };
  const ultimo = cierres[0];
  const primero = cierres[cierres.length - 1];
  const reglas = Object.keys(ultimo.totales)
    .map((clave) => {
      const nuevos = cierres.reduce((s, c) => s + (c.totales[clave]?.nuevos || 0), 0);
      const resueltos = cierres.reduce((s, c) => s + (c.totales[clave]?.resueltos || 0), 0);
      const dias = cierres.filter((c) => (c.totales[clave]?.nuevos || 0) > 0).length;
      return {
        clave, titulo: TITULOS[clave] || clave, nuevos, resueltos, dias,
        abiertos: ultimo.totales[clave].total,
        antes: primero.totales[clave]?.total ?? null,
      };
    })
    .filter((r) => r.nuevos > 0)
    .sort((a, b) => b.nuevos - a.nuevos);
  return { cierres: cierres.length, reglas };
}

const ESQUEMA = {
  type: 'object',
  properties: {
    grupos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['error', 'queja', 'duda'] },
          tema: { type: 'string', description: 'el tema unificado, en pocas palabras' },
          refs: { type: 'array', items: { type: 'string' }, description: 'los ref (p1, p2...) que van en este grupo' },
        },
        required: ['tipo', 'tema', 'refs'],
      },
    },
    mejoras: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          que: { type: 'string', description: 'la mejora, accionable, en una frase' },
          donde: { type: 'string', description: 'el lugar exacto' },
          porque: { type: 'string', description: 'el motivo con el numero que lo respalda, copiado de los datos' },
          quien: { type: 'string', description: 'el nombre de la persona responsable, de la lista' },
        },
        required: ['que', 'donde', 'porque', 'quien'],
      },
    },
  },
  required: ['grupos', 'mejoras'],
};

const instrucciones = () => `Sos el vigía de Start Companies (arma LLCs en Estados Unidos para latinos, cuenta bancaria, renovaciones, declaraciones, panel web para clientes). Te paso lo que detectó el vigía en la última semana:
- PROBLEMAS: temas de WhatsApp (errores, quejas, dudas) de cada informe diario y errores del panel. Cada uno con su ref y cuántas personas.
- CRM: reglas del control del CRM con cuántos casos nuevos aparecieron en la semana.

Devolvé:
1. "grupos": juntá los PROBLEMAS que son el mismo tema aunque estén escritos distinto. Cada ref va en un solo grupo. Si un tema no se parece a ningún otro, va solo.
2. "mejoras": las 5 mejoras más útiles para que esto deje de pasar, ordenadas por impacto. Cada una accionable (qué cambiar exactamente), con "donde" (lugar exacto), "porque" (el dato de la semana que la respalda, con el número tal cual aparece) y "quien" (una persona de esta lista):
${responsables()}
Primero lo que le pega a clientes (PROBLEMAS: errores y quejas antes que dudas), después completá con el CRM. Si hay PROBLEMAS repetidos, al menos 2 de las 5 tienen que salir de ahí. No inventes datos que no estén.
Escribí en español rioplatense, frases cortas y simples, sin guiones largos.`;

/**
 * @param {{corridas: Array, bitacoraCrm: Array, ahora?: Date}} op
 * @returns {Promise<{texto: string, resumen: object}>}
 */
export async function armarSemanal({ corridas, bitacoraCrm, ahora = new Date() }) {
  const piso = ahora - DIAS * 864e5;
  const semana = (corridas || []).filter((c) => new Date(c.id) >= piso);
  const crm = crmDeLaSemana(bitacoraCrm, ahora);

  // Todo lo que aparecio, con un ref para que Gemini lo agrupe.
  const items = [];
  for (const c of semana) {
    for (const p of c.problemas || []) items.push({ ...p, fecha: c.id, origen: 'WhatsApp' });
    for (const x of c.panel || []) {
      items.push({ tipo: 'error', tema: x.mensaje, cantidad: x.cantidad || 1, quienes: [], ejemplo: '', fecha: c.id, origen: x.tipo === 'trabados' ? 'pago/firma trabado' : 'panel' });
    }
  }
  const porRef = new Map(items.map((x, i) => [`p${i + 1}`, x]));

  let grupos = [];
  let mejoras = [];
  if (items.length || crm.reglas.length) {
    const contenido = [
      'PROBLEMAS:',
      ...(items.length
        ? [...porRef.entries()].map(([ref, x]) => `[${ref}] ${x.fecha.slice(0, 10)} ${x.origen} ${x.tipo}: ${x.tema} (${x.cantidad} personas)${x.ejemplo ? ` ej: "${x.ejemplo}"` : ''}`)
        : ['(ninguno)']),
      '',
      'CRM (casos nuevos en la semana):',
      ...crm.reglas.slice(0, 12).map((r) => `- ${r.titulo}: ${r.nuevos} nuevos en ${r.dias} de ${crm.cierres} días, ${r.abiertos} abiertos hoy`),
    ].join('\n');
    const { datos } = await generar({ modelo: MODELO, instrucciones: instrucciones(), contenido, esquema: ESQUEMA, maxTokens: 6000 });
    mejoras = (datos.mejoras || []).slice(0, 5);
    const usados = new Set();
    grupos = (datos.grupos || []).map((g) => {
      const xs = (g.refs || []).filter((r) => porRef.has(r) && !usados.has(r)).map((r) => (usados.add(r), porRef.get(r)));
      return {
        tipo: g.tipo,
        tema: g.tema,
        veces: xs.reduce((s, x) => s + (x.cantidad || 1), 0),
        dias: new Set(xs.map((x) => x.fecha.slice(0, 10))).size,
        quienes: [...new Set(xs.flatMap((x) => x.quienes || []))],
      };
    });
    // Lo que Gemini no agrupo no se pierde: va solo.
    for (const [r, x] of porRef) {
      if (!usados.has(r)) grupos.push({ tipo: x.tipo, tema: x.tema, veces: x.cantidad || 1, dias: 1, quienes: x.quienes || [] });
    }
    grupos = grupos.filter((g) => g.veces > 0).sort((a, b) => b.veces - a.veces);
  }

  const panelApagado = semana.length === 0 || semana.every((c) => c.panelApagado);
  const esperando = semana.reduce((s, c) => s + (c.esperando || 0), 0);
  return {
    texto: texto({ ahora, semana, grupos, mejoras, crm, panelApagado, esperando }),
    resumen: { informes: semana.length, temas: grupos.length, mejoras: mejoras.length, reglasCrm: crm.reglas.length },
  };
}

const fecha = (d) => new Date(d).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: 'numeric', month: 'numeric' });
const veces = (n) => `${n} ${n === 1 ? 'vez' : 'veces'}`;
const ROTULO = { error: 'Error', queja: 'Queja', duda: 'Duda' };

function texto({ ahora, semana, grupos, mejoras, crm, panelApagado, esperando }) {
  const desde = new Date(ahora - DIAS * 864e5);
  const lineas = [`*Vigía semanal* · del ${fecha(desde)} al ${fecha(ahora)} (${semana.length} ${semana.length === 1 ? "informe diario" : "informes diarios"})`];

  lineas.push('', '*Lo que más se repitió*');
  const top = grupos.slice(0, 8);
  if (top.length) {
    for (const g of top) {
      const q = g.quienes.length ? `: ${g.quienes.slice(0, 3).join(', ')}${g.quienes.length > 3 ? ` y ${g.quienes.length - 3} más` : ''}` : '';
      lineas.push(`• ${ROTULO[g.tipo] || g.tipo}: ${corta(g.tema, 120)}. ${veces(g.veces)} en ${g.dias} ${g.dias === 1 ? 'día' : 'días'}${q}`);
    }
  } else {
    lineas.push('• Nada repetido por WhatsApp esta semana.');
  }
  if (esperando) lineas.push(`• Mensajes que esperaron respuesta del equipo, sumando los informes: ${esperando}`);
  if (panelApagado) lineas.push('• Errores del panel: pendiente de acceso');

  lineas.push('', '*CRM trabado en la semana*');
  if (crm.reglas.length) {
    for (const r of crm.reglas.slice(0, 6)) {
      const tend = r.antes !== null && r.antes !== r.abiertos ? ` (pasó de ${r.antes} a ${r.abiertos} abiertos)` : ` (${r.abiertos} abiertos)`;
      lineas.push(`• ${r.titulo}: ${r.nuevos} nuevos en ${r.dias} de ${crm.cierres} días${tend}`);
    }
  } else {
    lineas.push(crm.cierres ? '• Nada nuevo.' : '• ⚠️ Control CRM no cerró ningún día esta semana.');
  }

  lineas.push('', '*Top 5 mejoras*');
  if (mejoras.length) {
    mejoras.forEach((m, i) => {
      lineas.push(`${i + 1}. *${m.que}*`, `      Dónde: ${m.donde}`, `      Por qué: ${m.porque}`, `      Quién: ${m.quien}`);
    });
  } else {
    lineas.push('• Sin base para sugerir mejoras esta semana.');
  }
  return lineas.join('\n');
}
