// El cerebro de Fase 0: reglas explicitas, sin modelo.
// Todo lo que decide queda con su motivo escrito, para que se pueda auditar
// linea por linea en el reporte.
import { VENTANAS, LIMITES, STATUS_QUE_FRENAN, PATRONES_PRUEBA, DOMINIOS_INTERNOS } from './config.js';
import { zonaDeTelefono, horaLocal } from './tz.js';
import { redactar } from './mensajes.js';

const H = 3600000;

const esPrueba = (persona, tituloEvento) => {
  const texto = `${persona?.Full_Name || ''} ${tituloEvento || ''}`;
  if (PATRONES_PRUEBA.some((re) => re.test(texto))) return true;
  const mail = (persona?.Email || '').toLowerCase();
  return DOMINIOS_INTERNOS.some((d) => mail.endsWith(d));
};

const telefonoDe = (p) => p?.Mobile || p?.Phone || null;

/**
 * @param {Array} reuniones  eventos de Zoho en la ventana amplia
 * @param {Object} personas  { [id]: registro de Lead o Contact }
 * @param {Date} ahora
 */
export function decidir(reuniones, personas, ahora = new Date()) {
  const acciones = [];
  const descartes = [];
  const alertas = [];
  const enviadosPorPersonaDia = new Map();

  // Para detectar la misma persona con varias reuniones a futuro.
  const reunionesPorPersona = new Map();
  for (const e of reuniones) {
    const pid = e.What_Id?.id || e.Who_Id?.id;
    if (!pid) continue;
    if (!reunionesPorPersona.has(pid)) reunionesPorPersona.set(pid, []);
    reunionesPorPersona.get(pid).push(e);
  }

  const ordenadas = [...reuniones].sort(
    (a, b) => new Date(a.Start_DateTime) - new Date(b.Start_DateTime)
  );

  for (const e of ordenadas) {
    const inicio = new Date(e.Start_DateTime);
    const faltanH = (inicio - ahora) / H;
    const pid = e.What_Id?.id || e.Who_Id?.id;
    const persona = pid ? personas[pid] : null;
    const nombre = persona?.Full_Name || e.What_Id?.name || e.Who_Id?.name || null;

    const base = {
      idEvento: e.id,
      titulo: e.Event_Title,
      inicio,
      faltanH,
      nombre,
      status: e.Status_del_Meet || null,
      duenio: e.Owner?.name || null,
    };

    // --- Alertas de calidad de datos (independientes de si se manda o no) ---
    if (faltanH > 0 && STATUS_QUE_FRENAN.concat('No asistió').includes(e.Status_del_Meet)) {
      alertas.push({
        tipo: 'status_incoherente',
        ...base,
        detalle: `La reunion es a futuro pero ya esta marcada "${e.Status_del_Meet}".`,
      });
    }
    if (!pid) {
      alertas.push({
        tipo: 'sin_vinculo',
        ...base,
        detalle: 'La reunion no esta vinculada a ningun Lead ni Contacto: no hay a quien escribirle.',
      });
    }
    if (persona?.Retargeting === true && faltanH > 0) {
      alertas.push({
        tipo: 'colision_retargeting',
        ...base,
        detalle:
          `Tiene reunion a futuro y ademas la cadencia "${persona.Nombre_retargeting || '?'}" ` +
          `activa (mensaje ${persona.N_mero_de_mensaje || '?'}). Zoho le puede mandar mensajes de ` +
          `recuperacion mientras la llamada sigue en pie.`,
      });
    }
    if (pid && (reunionesPorPersona.get(pid) || []).length > 1 && faltanH > 0) {
      alertas.push({
        tipo: 'reuniones_duplicadas',
        ...base,
        detalle: `Esta persona tiene ${reunionesPorPersona.get(pid).length} reuniones en la ventana.`,
      });
    }

    // --- Filtros de descarte ---
    if (!pid) {
      descartes.push({ ...base, motivo: 'sin vinculo a Lead ni Contacto' });
      continue;
    }
    if (!persona) {
      descartes.push({ ...base, motivo: 'el registro vinculado no se pudo leer' });
      continue;
    }
    if (esPrueba(persona, e.Event_Title)) {
      descartes.push({ ...base, motivo: 'registro de prueba' });
      continue;
    }
    const tel = telefonoDe(persona);
    if (!tel) {
      descartes.push({ ...base, motivo: 'sin telefono cargado' });
      continue;
    }
    if (STATUS_QUE_FRENAN.includes(e.Status_del_Meet)) {
      descartes.push({ ...base, motivo: `ya marcada "${e.Status_del_Meet}"` });
      continue;
    }

    // --- Que ventana toca ---
    let tipo = null;
    if (faltanH >= VENTANAS.recordatorio.desdeH && faltanH <= VENTANAS.recordatorio.hastaH) {
      tipo = 'recordatorio';
    } else if (faltanH >= VENTANAS.confirmacion.desdeH && faltanH <= VENTANAS.confirmacion.hastaH) {
      tipo = 'confirmacion';
    } else if (
      faltanH < 0 &&
      -faltanH * 60 >= VENTANAS.rescate.desdeMin &&
      -faltanH <= VENTANAS.rescate.hastaH &&
      !e.Status_del_Meet
    ) {
      tipo = 'rescate';
    }

    // Un rescate le dice al cliente "se reagenda, ¿que dia te queda comodo?".
    // Si ya tiene otra reunion en pie, ese mensaje lo confunde. Caso real:
    // no vino a la de hoy y tiene otra manana.
    if (tipo === 'rescate') {
      const otraEnPie = (reunionesPorPersona.get(pid) || []).some(
        (o) => o.id !== e.id && new Date(o.Start_DateTime) > ahora
      );
      if (otraEnPie) {
        descartes.push({ ...base, motivo: 'no aparecio, pero ya tiene otra reunion agendada' });
        alertas.push({
          tipo: 'rescate_omitido',
          ...base,
          detalle:
            'Falto a esta reunion pero tiene otra a futuro. No se le escribe para no ' +
            'contradecirse; conviene que lo mire una persona.',
        });
        continue;
      }
    }

    if (!tipo) {
      descartes.push({
        ...base,
        motivo:
          faltanH < 0
            ? e.Status_del_Meet
              ? `ya paso y esta marcada "${e.Status_del_Meet}"`
              : 'ya paso, fuera de la ventana de rescate'
            : 'todavia no entra en ninguna ventana',
      });
      continue;
    }

    // --- Guardarrailes ---
    const { tz, prefijo, aprox } = zonaDeTelefono(tel);
    const hCliente = horaLocal(ahora, tz);
    if (hCliente !== null && (hCliente < LIMITES.horaMinima || hCliente >= LIMITES.horaMaxima)) {
      descartes.push({
        ...base,
        motivo: `son las ${hCliente}:00 para el cliente (${tz}), fuera del horario permitido`,
      });
      continue;
    }

    const claveDia = `${pid}|${ahora.toISOString().slice(0, 10)}`;
    const yaMandados = enviadosPorPersonaDia.get(claveDia) || 0;
    if (yaMandados >= LIMITES.maxMensajesPorPersonaPorDia) {
      descartes.push({ ...base, motivo: 'tope diario de mensajes para esa persona' });
      continue;
    }
    enviadosPorPersonaDia.set(claveDia, yaMandados + 1);

    acciones.push({
      ...base,
      tipo,
      telefono: tel,
      tz,
      prefijo,
      tzAprox: aprox,
      leadStatus: persona.Lead_Status || null,
      texto: redactar({
        tipo,
        nombre,
        inicio,
        tzCliente: tz,
        venue: e.Venue,
        tituloEvento: e.Event_Title,
      }),
    });
  }

  return { acciones, descartes, alertas };
}
