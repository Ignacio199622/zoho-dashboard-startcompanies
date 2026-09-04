// Las ventas no se sueltan.
//
// El resto del agente razona por conversacion: si el cliente escribio y nadie
// contesto, avisa. Eso deja pasar el caso que motivo todo esto: a David le
// CONTESTARON ("desde el mismo panel podes gestionarla") y la venta se murio
// igual, cuatro dias, hasta que alguien lo vio a mano. Para la conversacion
// estaba todo bien: el ultimo que hablo fue el equipo.
//
// Asi que las ventas llevan su propia vida aparte. Se abre un seguimiento
// cuando aparece una, y sigue abierto AUNQUE YA HAYAN CONTESTADO, hasta que se
// cierre de verdad.
import { comoEsta } from './zoho.js';
import { TEMAS_QUE_NO_SE_SUELTAN, DIAS_INSISTENCIA_VENTA } from './config.js';

const DIA = 86400000;

const dias = (desde, hasta) => Math.floor((hasta - new Date(desde)) / DIA);

/** Cada cuanto toca insistir, segun cuantas veces ya insistimos. */
function esperaEnDias(insistencias) {
  const i = Math.min(insistencias, DIAS_INSISTENCIA_VENTA.length - 1);
  return DIAS_INSISTENCIA_VENTA[i];
}

/** Abre el seguimiento de una venta, si es de las que no se sueltan. */
export function abrir(estado, alerta, ahora = new Date()) {
  const abiertos = estado.ventasAbiertas || (estado.ventasAbiertas = {});
  if (!TEMAS_QUE_NO_SE_SUELTAN.includes(alerta.clase?.tema)) return false;
  if (abiertos[alerta.id]) return false;

  abiertos[alerta.id] = {
    abierto: ahora.toISOString(),
    ultimoAviso: ahora.toISOString(),
    insistencias: 0,
    quien: alerta.ficha?.Full_Name || alerta.mobile_number__s,
    telefono: alerta.mobile_number__s,
    tema: alerta.clase.tema,
    resumen: alerta.clase.resumen,
    mensaje: String(alerta.last_message__s || '').slice(0, 400),
    ficha: alerta.ficha ? { modulo: alerta.ficha.modulo, id: alerta.ficha.id } : null,
    // Foto del estado al abrir. Es contra esto que se compara para saber si
    // alguien movio la aguja.
    tratosAlAbrir: null,
    estadoLeadAlAbrir: alerta.ficha?.Lead_Status ?? null,
  };
  return true;
}

/** Cierre a mano, desde `cerrar.js`. */
export function cerrarAMano(estado, id, motivo = 'cerrado a mano') {
  const v = (estado.ventasAbiertas || {})[id];
  if (!v) return null;
  delete estado.ventasAbiertas[id];
  return { ...v, motivoCierre: motivo };
}

/**
 * Revisa todas las ventas abiertas contra el CRM.
 *
 * Devuelve `{ cerradas, aInsistir }`:
 *  - cerradas: se movieron en el CRM, se sacan del seguimiento
 *  - aInsistir: siguen igual y ya paso el plazo, hay que volver a avisar
 */
export async function revisar(estado, conversaciones, ahora = new Date()) {
  const abiertos = estado.ventasAbiertas || (estado.ventasAbiertas = {});
  const cerradas = [];
  const aInsistir = [];

  // Lo que se movio en esta pasada, para poder mostrar en que quedo la charla.
  const porId = Object.fromEntries(conversaciones.map((c) => [c.id, c]));

  for (const [id, v] of Object.entries(abiertos)) {
    const esperaCumplida = ahora - new Date(v.ultimoAviso) >= esperaEnDias(v.insistencias) * DIA;

    // Si el cliente volvio a escribir, el flujo normal ya lo va a levantar como
    // conversacion pendiente. No hace falta insistir por duplicado.
    const conv = porId[id];
    if (conv?.conversation_status__s === 'Responded') {
      // Salvo que lo que escribio sea que no va a avanzar. Ahi se deja de
      // insistir: seguir empujando a alguien que ya dijo que no es exactamente
      // lo que genera los pedidos de baja.
      if (conv.clase?.desinteres) {
        delete abiertos[id];
        cerradas.push({
          ...v,
          id,
          motivoCierre: `el cliente dijo que no avanza ("${String(conv.last_message__s || '').slice(0, 80)}")`,
        });
        continue;
      }
      v.ultimoAviso = ahora.toISOString();
      continue;
    }

    if (!esperaCumplida) continue;

    // Recien aca se consulta el CRM, y solo por las que ya cumplieron el plazo:
    // son pocas, asi que no encarece la corrida.
    const hoy = v.ficha ? await comoEsta(v.ficha) : null;

    if (hoy?.modulo === 'Contacts') {
      if (v.tratosAlAbrir === null) {
        // Primera revision: se guarda la foto para comparar de la proxima.
        v.tratosAlAbrir = (hoy.tratos || []).map((t) => t.id);
      } else {
        const nuevos = (hoy.tratos || []).filter((t) => !v.tratosAlAbrir.includes(t.id));
        if (nuevos.length) {
          delete abiertos[id];
          cerradas.push({ ...v, id, motivoCierre: `se abrió el trato "${nuevos[0].nombre}"`, trato: nuevos[0] });
          continue;
        }
      }
    }

    if (hoy?.modulo === 'Leads' && v.estadoLeadAlAbrir && hoy.estadoLead !== v.estadoLeadAlAbrir) {
      delete abiertos[id];
      cerradas.push({
        ...v,
        id,
        motivoCierre: `el lead pasó de "${v.estadoLeadAlAbrir}" a "${hoy.estadoLead}"`,
      });
      continue;
    }

    v.insistencias += 1;
    v.ultimoAviso = ahora.toISOString();
    aInsistir.push({
      ...v,
      id,
      diasAbierta: dias(v.abierto, ahora),
      ultimoMensajeDeLaCharla: conv?.last_message__s || null,
      quienContestoUltimo: conv?.replied_by__s?.name || null,
    });
  }

  return { cerradas, aInsistir };
}

export const abiertas = (estado) => Object.entries(estado.ventasAbiertas || {});
