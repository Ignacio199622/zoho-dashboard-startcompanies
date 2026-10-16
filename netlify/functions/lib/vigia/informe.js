// Arma el informe del vigia: un solo mensaje de Slack con cuatro bloques.
//
//   🔴 errores de usuarios (panel, pagos, firmas, y lo que reportan por WhatsApp)
//   🟡 quejas y dudas repetidas (WhatsApp agrupado con Gemini)
//   🟢 mejoras sugeridas (max 5, cada una con donde y por que)
//   🧱 CRM trabado (de la bitacora de Control CRM, sin pedirle nada a Zoho)
//
// Cada bloque se junta por separado y si uno se cae el resto sale igual: un
// informe con un bloque marcado "no se pudo leer" sirve; un informe que no
// sale no sirve.
import { bloqueCrm } from './crm.js';
import { bloquePanel } from './panel.js';
import { leerWhatsapp, esperando, analizar, nombre, conContenido } from './whatsapp.js';

export const whatsappPrendido = () => process.env.VIGIA_WHATSAPP !== '0';

const cuando = (ahora) =>
  ahora.toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit',
  });

export const corta = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const quienes = (p) => (p.quienes?.length ? `: ${p.quienes.slice(0, 3).join(', ')}${p.quienes.length > 3 ? ` y ${p.quienes.length - 3} más` : ''}` : '');
const viejosDe = (lista) => lista.filter((c) => c.horas >= 2).sort((a, b) => b.horas - a.horas);
const horas = (h) => (h >= 48 ? `${Math.round(h / 24)} días` : `${Math.round(h)} h`);

/**
 * Junta todo. `get` es el lector de Zoho (ver whatsapp.js); `bitacoraCrm` la
 * bitacora de Control CRM; `crmInformado` el id del cierre que ya salio en el
 * informe anterior, para no repetirlo.
 */
export async function juntar({ ahora = new Date(), desde, get, bitacoraCrm, crmInformado }) {
  const r = { ahora, desde, crm: null, panel: null, wa: null, errores: [] };

  try {
    r.crm = bloqueCrm(bitacoraCrm, { ahora, yaInformado: crmInformado });
  } catch (e) {
    r.errores.push(`CRM: ${e.message}`);
  }

  r.panel = await bloquePanel(desde);

  if (!whatsappPrendido()) {
    r.wa = { apagado: true };
  } else {
    try {
      const { convs, masRegistros } = await leerWhatsapp({ get, desde });
      const pend = esperando(convs, ahora);
      let analisis = { problemas: [], mejoras: [], analizados: 0 }; // sin esperanRespuesta: se usa el filtro sin modelo
      try {
        analisis = await analizar(pend);
      } catch (e) {
        r.errores.push(`Gemini: ${e.message}`);
      }
      r.wa = { leidas: convs.length, masRegistros, pendientes: pend, ...analisis };
    } catch (e) {
      r.errores.push(`WhatsApp: ${e.message}`);
    }
  }
  return r;
}

/** El texto de Slack (mrkdwn). */
export function texto(r) {
  const rojo = [];
  const amarillo = [];
  const verde = [];
  const crm = [];

  // 🔴
  rojo.push(...(r.panel?.lineas || []));
  for (const p of (r.wa?.problemas || []).filter((x) => x.tipo === 'error')) {
    rojo.push(`WhatsApp: ${p.tema} (${p.cantidad}${quienes(p)}). _"${corta(p.ejemplo, 120)}"_`);
  }

  // 🟡
  for (const p of (r.wa?.problemas || []).filter((x) => x.tipo !== 'error')) {
    amarillo.push(`${p.tipo === 'queja' ? 'Queja' : 'Duda'}: ${p.tema} (${p.cantidad}${quienes(p)}). _"${corta(p.ejemplo, 120)}"_`);
  }
  // Solo los que necesitan respuesta: un "gracias" o un "no me interesa" no
  // espera nada. Si Gemini no corrio, se cae al filtro sin modelo.
  const pend = r.wa?.esperanRespuesta || (r.wa?.pendientes || []).filter(conContenido);
  if (pend.length) {
    const clientes = viejosDe(pend).filter((c) => c.sender__s?.module?.api_name === 'Contacts').length;
    const viejos = viejosDe(pend);
    if (viejos.length) {
      const mas = viejos[0];
      amarillo.push(
        `Sin respuesta en el 786: ${viejos.length} esperando hace más de 2 h (${clientes} son clientes). El más viejo: ${nombre(mas)}, hace ${horas(mas.horas)}.`
      );
    }
  }
  if (r.wa?.apagado) amarillo.push('WhatsApp: apagado (VIGIA_WHATSAPP=0).');
  const notas = [];
  if (r.wa?.masRegistros) notas.push('_Nota: hubo más de 200 conversaciones con movimiento y se miraron las 200 más nuevas._');

  // 🟢
  (r.wa?.mejoras || []).forEach((m, i) => {
    verde.push(`${i + 1}. ${m.que}\n      Dónde: ${m.donde}. Por qué: ${m.porque}`);
  });

  // 🧱
  crm.push(...(r.crm?.lineas || []));

  const fallas = r.errores.map((e) => `⚠️ ${corta(e, 200)}`);

  const encabezado = `*Vigía* · ${cuando(r.ahora)}`;
  const hayAlgo =
    rojo.some((l) => !/pendiente de acceso/.test(l)) || amarillo.length || verde.length || r.crm?.alerta ||
    crm.some((l) => !/^Sin corrida nueva/.test(l)) || fallas.length;

  if (!hayAlgo) return [encabezado, 'Sin novedades.', ...rojo.map((l) => `🔴 ${l}`)].join('\n');

  const bloque = (titulo, lineas, vacio) =>
    `${titulo}\n${lineas.length ? lineas.map((l) => (/^\d+\./.test(l) ? l : `• ${l}`)).join('\n') : `• ${vacio}`}`;

  return [
    encabezado,
    bloque('🔴 *Errores de usuarios*', rojo, 'Nada reportado.'),
    bloque('🟡 *Quejas y dudas repetidas*', amarillo, 'Nada repetido.'),
    bloque('🟢 *Mejoras sugeridas*', verde, 'Nada nuevo para sugerir.'),
    bloque('🧱 *CRM trabado*', crm, 'Nada nuevo.'),
    fallas.length ? fallas.join('\n') : null,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Lo que se guarda de cada corrida diaria (store `vigia`, clave `corrida/<ISO>`)
 * para armar el semanal sin volver a pedirle nada a Zoho. Sin telefonos ni
 * textos enteros: tema, cantidad, nombres y una frase de ejemplo.
 */
export function fotoDelDia(r) {
  return {
    id: r.ahora.toISOString(),
    desde: r.desde?.toISOString?.() || null,
    problemas: (r.wa?.problemas || []).map((p) => ({
      tipo: p.tipo, tema: p.tema, cantidad: p.cantidad, quienes: p.quienes || [], ejemplo: corta(p.ejemplo || '', 160),
    })),
    mejoras: r.wa?.mejoras || [],
    esperando: (r.wa?.esperanRespuesta || []).length,
    leidas: r.wa?.leidas ?? null,
    panel: r.panel?.crudos || [],
    panelApagado: Boolean(r.panel?.apagado),
    crmCierreId: r.crm?.cierreId || null,
    errores: r.errores,
  };
}
