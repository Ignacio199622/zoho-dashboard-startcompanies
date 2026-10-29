// El trabajo de la guardia, en un modulo para que lo puedan llamar los dos:
// el script de la maquina (`guardia-correr.js`) y la funcion de Netlify.
//
// Devuelve un resumen y las lineas del informe en vez de imprimir: quien lo
// llama decide si va a la consola o a un log de Netlify.
import { conversacionesDesde, get } from './zoho.js';
import { leerRespuesta } from './confirmar-reunion.js';
import { pendientes } from './reglas.js';
import {
  paraAvisar, estaAbierto, motivo, motivoParaElCliente, proximaApertura, aQuienLeToca,
  textoPara, inicioDelCierre, esCierreDeConversacion, esRechazo, atendidasEnCierre, sigueAtendida, vueltaConPedido, VENTAS, CX, ROBOT, TOPE_POR_CORRIDA,
} from './guardia.js';
import {
  contactosConTelefono, leadsConTelefono, fichaPorId, marcarAvisoFueraDeHorario,
  crearTareaGuardia, tareaGuardiaDesde, avisoGuardiaDesde, reglaAgendamientoActiva, ponerEnSecuencia,
  limpiarAvisoFueraDeHorario, ESTADOS_CON_CADENCIA, REGLA_AGENDAMIENTO,
} from './escritura.js';

const HORAS_DE_LECTURA = 24;

/** Cuando escribio, dicho como lo diria una persona. */
export function enCriollo(fecha) {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(fecha);
}

/**
 * ¿Existen ya los campos que disparan el aviso?
 *
 * Si no existen, escribirlos igual "por las dudas" no es inofensivo: Zoho los
 * ignora pero el PUT cuenta como edicion, y hay reglas que disparan al editar.
 * Mientras no esten, se crean las tareas y nada mas.
 */
async function camposListos(modulo) {
  try {
    const j = await get(`settings/fields?module=${modulo}`);
    const nombres = new Set((j.fields || []).map((f) => f.api_name));
    return ['Aviso_Fuera_Horario', 'Motivo_Cierre', 'Vuelta_Habil'].every((c) => nombres.has(c));
  } catch {
    return false;
  }
}

/** Donde vive esta persona en el CRM. Cliente primero: si ya compro, es CX. */
/**
 * ¿Este lead ya dijo que no, o alguien lo saco del embudo?
 *
 * Nurturing NO cuenta aca aunque `ESTADOS_YA_FUERA` lo incluya: hay 995 leads
 * en ese estado y el que escribe de noche "quiero abrir la LLC" merece la
 * tarea. Lo que lo deja afuera es la casilla de baja o haber salido del flujo.
 */
const yaPidioSalir = (lead) =>
  lead.Desactivar_Retargeting === true || ['No Interesado', 'Fuera de flujo'].includes(lead.Lead_Status);

// El que ya reservo una reunion no tiene que entrar a la secuencia de
// agendamiento: la cadencia le pediria "hagamos una llamada corta" teniendo la
// llamada agendada. El Flow de Cal deja el lead en `Reunion Agendada`, un
// estado que no esta en `ESTADOS_CON_CADENCIA` ni cuenta como baja, y por eso
// el 12-sep-2026 a las 23:32 la guardia metio a Enrique Bernabei en
// Agendamiento con reunion para el lunes; el mensaje 2 le caia 15 minutos
// antes de la reunion. La tarea y el aviso siguen saliendo igual: solo se
// evita el embudo.
const yaTieneReunion = (lead) =>
  ['Reunión Agendada', 'Reunion Agendada'].includes(String(lead.Lead_Status || '').trim());

/**
 * Donde vive esta persona en el CRM.
 *
 * Primero se cree lo que dice la conversacion: `sender__s` trae el modulo y el
 * id de la ficha a la que Zoho ya la tiene atada. Recien si eso no viene se
 * busca por telefono, que es lo que falla cuando la persona escribe desde un
 * numero distinto al cargado en su ficha (caso Leidy Valencia, 21-sep-2026:
 * clienta con dos aperturas activas, descartada como "no esta en el CRM").
 *
 * El telefono sigue haciendo falta para los DUPLICADOS: `sender__s` apunta a
 * una sola ficha y el CRM tiene gemelos. Por eso, cuando el numero coincide con
 * lo que hay cargado, gana la busqueda por telefono y se conserva la cuenta.
 */
async function ubicar(numero, emisor = null) {
  const contactos = await contactosConTelefono(numero);
  if (contactos.length) {
    return { modulo: 'Contacts', equipo: 'CX', registro: contactos[0], duplicados: contactos.length };
  }
  const leads = await leadsConTelefono(numero);
  if (leads.length) {
    return { modulo: 'Leads', equipo: 'ventas', registro: leads[0], duplicados: leads.length };
  }
  const modulo = emisor?.module?.api_name;
  if (modulo === 'Contacts' || modulo === 'Leads') {
    const registro = await fichaPorId(modulo, emisor.id);
    if (registro) {
      return {
        modulo,
        equipo: modulo === 'Contacts' ? 'CX' : 'ventas',
        registro,
        duplicados: 1,
        porConversacion: true,
      };
    }
  }
  return null;
}

// Donde se guardan las conversaciones que atendio una persona en este cierre.
// La funcion de Netlify le pasa un blob; a mano no se guarda nada y la corrida
// solo ve lo que esta contestado en ese momento.
const MEMORIA_VACIA = { leer: async () => ({}), guardar: async () => {} };

export async function correrGuardia({ aplicar = false, tope = TOPE_POR_CORRIDA, ahora = new Date(), memoria = MEMORIA_VACIA } = {}) {
  const linea = [];
  const decir = (t) => linea.push(t);

  if (estaAbierto(ahora)) {
    decir('Hay alguien atendiendo. No corresponde ningun aviso.');
    return { abierto: true, avisos: 0, tareas: 0, saltados: 0, sinFicha: 0, linea };
  }

  const vuelta = proximaApertura(ahora);
  decir(`Cerrado: ${motivo(ahora)}. Volvemos ${vuelta.frase}.`);

  const conversaciones = await conversacionesDesde(new Date(ahora.getTime() - HORAS_DE_LECTURA * 3600e3));
  const esperando = pendientes(conversaciones, ahora);
  const { avisos, corte } = paraAvisar(esperando, ahora);

  // Las que ya esta atendiendo alguien del equipo en este cierre: a esas no se
  // les dice "no hay nadie conectado". Ver `atendidasEnCierre` en guardia.js.
  const previas = await memoria.leer().catch(() => ({}));
  const atendidas = atendidasEnCierre(conversaciones, previas, inicioDelCierre(ahora));
  if (aplicar && JSON.stringify(atendidas) !== JSON.stringify(previas)) {
    await memoria.guardar(atendidas).catch((e) => decir(`OJO: no se pudo guardar quien atendio: ${e.message}`));
  }

  // El "ya tiene tarea de hoy" se pregunta ANTES de aplicar el tope, no
  // despues. Si no, los primeros de la cola (que son los que mas esperaron y
  // por eso ya se atendieron) se comen la cuota todas las corridas y la
  // guardia queda trabada: pasa el dia entero salteando a los mismos tres y
  // sin llegar nunca a los nuevos. Verificado en vivo el 7-sep-2026.
  // La ventana del "uno por persona" es ESTE cierre, no el dia del calendario:
  // la noche del lunes al martes es un solo cierre y cruza la medianoche.
  const desdeCierre = inicioDelCierre(ahora);
  const salida0 = { saltados: 0, sinFicha: 0, rechazos: 0 };
  const aMandar = [];
  for (const a of avisos) {
    if (aMandar.length >= tope) break;
    // "No me interesa" no se contesta: ni aviso, ni tarea, ni secuencia. Va
    // antes de buscar la ficha para no gastar una llamada en alguien que no
    // se va a tocar.
    if (esRechazo(a.last_message__s)) {
      salida0.rechazos++;
      decir(`- ${a.sender__s?.name || a.mobile_number__s}: dijo "${String(a.last_message__s).trim().slice(0, 40)}", no se lo contesta.`);
      continue;
    }
    const donde = await ubicar(a.mobile_number__s, a.sender__s);
    if (!donde) {
      salida0.sinFicha++;
      decir(`- ${a.mobile_number__s}: no esta en el CRM.`);
      continue;
    }
    // El "Si" / "No" del que tiene reunion agendada es la respuesta a la
    // confirmacion de 24 h, no una consulta: lo lee `confirmar-reunion.js`.
    // Contestarle "no hay nadie, agenda una llamada" es un sinsentido y ademas
    // PISA su respuesta en el CRM (solo guarda el ultimo mensaje). Paso el
    // 13-sep-2026 con Rodolfo Martinez Rogers: dijo "Si" a las 14:22 y a las
    // 14:27 la guardia le contesto eso. Ni aviso ni tarea: no hay nada que
    // contestar.
    if (leerRespuesta(a.last_message__s) && yaTieneReunion(donde.registro)) {
      salida0.confirmaciones = (salida0.confirmaciones || 0) + 1;
      decir(`- ${donde.registro.Full_Name || a.mobile_number__s}: contesto "${String(a.last_message__s).trim().slice(0, 30)}" a la confirmacion de reunion, se lo deja al agente de confirmaciones.`);
      continue;
    }
    // Tarea y aviso se cuentan por separado, una vez cada uno por cierre. La
    // tarea sola NO quiere decir que le salio el WhatsApp (ver
    // `avisoGuardiaDesde`): el cliente que el viernes atendia una persona y
    // el sabado escribe sin que nadie le conteste tiene que recibir el aviso.
    // Si ya le salio una vez, no se repite aunque siga escribiendo.
    const tieneTarea = await tareaGuardiaDesde(donde.modulo, donde.registro.id, desdeCierre);
    const yaAvisado = tieneTarea
      && (donde.modulo !== 'Contacts' || await avisoGuardiaDesde(donde.modulo, donde.registro.id, desdeCierre));
    if (tieneTarea && yaAvisado) {
      salida0.saltados++;
      continue;
    }
    // El lead que ya pidio salir (lo dio de baja una persona o el agente de
    // bajas) no se toca: ni aviso, ni tarea, ni de vuelta a la secuencia. El
    // 9-sep-2026 Santiago saco a mano a Arturo A, Maria Grandio y Gerardo
    // Macina despues de un "No me interesa SC"; a las 18:02 la guardia los vio
    // en "Fuera de flujo" (que no contaba como cadencia), les mando "agenda
    // aca" y los volvio a poner en Agendamiento. A las 18:07 recibieron el
    // primer mensaje de la cadencia de nuevo. Lo mismo German Garcia el 10-sep.
    if (donde.modulo === 'Leads' && yaPidioSalir(donde.registro)) {
      salida0.rechazos++;
      decir(`- ${donde.registro.Full_Name}: ya esta fuera (${donde.registro.Lead_Status}, baja=${donde.registro.Desactivar_Retargeting}), no se lo toca.`);
      continue;
    }
    aMandar.push({ ...a, donde, tieneTarea });
  }

  decir(`${conversaciones.length} chats con movimiento, ${esperando.length} esperando, ${avisos.length} con aviso.`);
  if (corte) decir(`OJO: eran ${corte}, se corto por el tope de seguridad.`);

  const listos = aplicar
    ? { Leads: await camposListos('Leads'), Contacts: await camposListos('Contacts') }
    : { Leads: false, Contacts: false };
  if (aplicar && !listos.Leads && !listos.Contacts) {
    decir('Faltan los campos de aviso en Zoho: se crean solo las tareas, no sale ningun WhatsApp.');
  }

  // Sin la regla prendida, mover el lead a "Agendamiento" no le manda nada y
  // encima lo edita. Se pregunta una vez por corrida, no una por lead.
  const secuenciaViva = aplicar ? await reglaAgendamientoActiva() : false;
  if (aplicar && !secuenciaViva) {
    decir(`"${REGLA_AGENDAMIENTO}" esta apagada: los leads NO entran a la secuencia todavia.`);
  }

  const salida = { abierto: false, avisos: 0, tareas: 0, saltados: 0, sinFicha: 0, fallas: 0, casos: [], linea };

  salida.saltados = salida0.saltados;
  salida.sinFicha = salida0.sinFicha;
  salida.rechazos = salida0.rechazos;
  if (salida0.saltados) decir(`${salida0.saltados} ya tenian tarea de hoy, salteados antes del tope.`);

  for (const a of aMandar) {
    const donde = a.donde;
    const quien = donde?.registro?.Full_Name || a.mobile_number__s;

    const dueno = donde.registro.Owner;
    const propio = dueno?.id && dueno.name !== ROBOT ? { id: dueno.id, nombre: dueno.name } : null;
    const responsable = propio || aQuienLeToca(donde.equipo === 'CX' ? CX : VENTAS, ahora);
    // El motivo se calcula con AHORA, no con el momento en que escribio. El
    // mensaje le llega ahora y la vuelta ya sale de `ahora`: mezclar los dos
    // relojes producia frases que se contradicen solas. El 8-sep a las 00:12 un
    // cliente recibio "hoy lunes es feriado en Estados Unidos... te respondemos
    // hoy a las 9", siendo martes y no siendo feriado.
    const porQue = motivoParaElCliente(ahora);
    // Al cliente se le pide que deje el detalle: si vuelve a escribir, la
    // conversacion reaparece en "no contestados" a la mañana. Ver guardia.js.
    const vuelta = donde.equipo === 'CX' ? vueltaConPedido(a.vuelta) : a.vuelta;
    const texto = textoPara(donde.equipo, (quien || '').split(' ')[0], porQue, vuelta);
    const yaEnCadencia = ESTADOS_CON_CADENCIA.includes(donde.registro.Lead_Status);

    const caso = {
      quien, equipo: donde.equipo, modulo: donde.modulo, id: donde.registro.id,
      escribio: enCriollo(a.cuando), horas: a.horasEsperando,
      responsable: responsable?.nombre || null, vence: a.vueltaISO, texto, porQue,
      duplicados: donde.duplicados, aviso: false, tarea: false, secuencia: false,
      estadoPrevio: donde.registro.Lead_Status || null,
      sinAvisoPorCadencia: false,
      sinAvisoPorCierre: false,
      sinAvisoPorOtroNumero: false,
      sinAvisoPorSerLead: false,
      sinAvisoPorEquipo: false,
    };

    // El que ya cerro la conversacion ("gracias", "dale") no necesita que le
    // digan que no hay nadie. La TAREA se crea igual: el filtro nunca puede
    // hacer desaparecer a alguien, solo evita el WhatsApp.
    const yaCerro = esCierreDeConversacion(a.last_message__s);

    // El lead que recien entra ya tiene un mensaje en camino: la cadencia de
    // Agendamiento le escribe a los 5 minutos, sea la hora que sea. Sumarle el
    // "no hay nadie conectado" son dos WhatsApp parecidos en diez minutos, y de
    // madrugada es peor: medido, un lead que entro a la 1:16 recibio el suyo a
    // la 1:21. Se le crea la tarea igual, que es lo que no tenia.
    const yaLeEscriben = yaEnCadencia;

    if (aplicar) {
      // EL WHATSAPP ES SOLO PARA CLIENTES. Decision de Ignacio, 22-sep-2026.
      //
      // Hasta hoy el filtro no preguntaba lead o cliente: preguntaba si ya le
      // escribe una cadencia. En los hechos daba casi lo mismo (1.502 de 1.531
      // conversaciones de leads de los ultimos 30 dias caen en un estado con
      // cadencia), pero los 29 restantes -- Nuevo MQL, En Calificacion, los
      // dormidos que no tienen ningun mensaje programado -- si recibian
      // `fuera_horario_lead`. Al lead le habla el embudo; sumarle un
      // automatico mas es lo que ya nos costo el bloqueo de WhatsApp de
      // agosto. La tarea se crea igual: el vendedor lo ve a la mañana.
      if (donde.modulo === 'Leads') {
        caso.sinAvisoPorSerLead = true;
        salida.sinAvisoPorSerLead = (salida.sinAvisoPorSerLead || 0) + 1;
        decir(`- ${quien}: es un posible cliente, el aviso automatico es solo para clientes; se le crea la tarea.`);
      } else if (sigueAtendida(atendidas[a.ref], ahora)) {
        // Una persona del equipo le contesto hoy. Decirle ahora "no hay nadie
        // conectado" desmiente al que le esta escribiendo.
        caso.sinAvisoPorEquipo = true;
        salida.sinAvisoPorEquipo = (salida.sinAvisoPorEquipo || 0) + 1;
        decir(`- ${quien}: ya le venia contestando alguien del equipo, solo se le crea la tarea.`);
      } else if (yaLeEscriben) {
        caso.sinAvisoPorCadencia = true;
        salida.sinAvisoPorCadencia = (salida.sinAvisoPorCadencia || 0) + 1;
        decir(`- ${quien}: ya esta en ${caso.estadoPrevio} y la cadencia le escribe sola, solo se le crea la tarea.`);
      } else if (yaTieneReunion(donde.registro)) {
        // Ya tiene la llamada agendada: decirle "no hay nadie, agenda una llamada" es un
        // sinsentido (Marco Rodriguez, 13-sep-2026: pidio reagendar y recibio eso). La tarea
        // se crea igual para que una persona lo lea a la mañana; el agente de confirmaciones
        // ademas lo manda a Slack como "revisar".
        caso.sinAvisoPorReunion = true;
        salida.sinAvisoPorReunion = (salida.sinAvisoPorReunion || 0) + 1;
        decir(`- ${quien}: ya tiene reunion agendada, solo se le crea la tarea.`);
      } else if (donde.porConversacion) {
        // La ficha la encontramos por la conversacion, no por el telefono: el
        // numero desde el que escribio NO es el que tiene cargado. La plantilla
        // de Zoho sale al campo `Movil` de la ficha, asi que el aviso le
        // llegaria al otro telefono (o al de otra persona, si la ficha esta
        // mal). La tarea si se crea: una persona lee el hilo real y contesta
        // ahi.
        caso.sinAvisoPorOtroNumero = true;
        salida.sinAvisoPorOtroNumero = (salida.sinAvisoPorOtroNumero || 0) + 1;
        decir(`- ${quien}: escribio desde ${a.mobile_number__s} y su ficha tiene otro numero, solo se le crea la tarea.`);
      } else if (yaCerro) {
        caso.sinAvisoPorCierre = true;
        salida.sinAvisoPorCierre = (salida.sinAvisoPorCierre || 0) + 1;
        decir(`- ${quien}: cerro la conversacion ("${String(a.last_message__s || '').slice(0, 40)}"), solo se le crea la tarea.`);
      } else if (listos[donde.modulo]) {
        const r = await marcarAvisoFueraDeHorario(donde.modulo, donde.registro.id, porQue, vuelta);
        caso.aviso = r.ok;
        if (r.ok) salida.avisos++;
        else salida.fallas++;

        // Devolver la casilla a false, sin disparar nada. Es lo que deja lista
        // la proxima transicion false -> true: sin esto la regla de Zoho avisa
        // una sola vez por persona en toda su vida y el mismo cliente no
        // recibiria el aviso el finde siguiente. Va despues de un envio exitoso
        // y con `trigger: []`, asi limpiar nunca manda un segundo mensaje.
        if (r.ok) {
          const limpio = await limpiarAvisoFueraDeHorario(donde.modulo, donde.registro.id);
          if (!limpio.ok) {
            decir(`OJO: no se pudo destildar a ${quien}; hasta que se destilde no vuelve a avisarse.`);
          }
        }
      }
      if (responsable && !a.tieneTarea) {
        const t = await crearTareaGuardia({
          modulo: donde.modulo,
          registroId: donde.registro.id,
          nombre: quien,
          responsableId: responsable.id,
          vencimiento: a.vueltaISO,
          cuandoEscribio: `el ${caso.escribio}`,
          mensaje: a.last_message__s,
        });
        caso.tarea = t.ok;
        if (t.ok) salida.tareas++;
        else salida.fallas++;
      }

      // Y al embudo. Solo leads, solo si no venia ya con cadencia, y solo si
      // la regla que manda los mensajes esta viva.
      if (donde.modulo === 'Leads' && secuenciaViva && !yaEnCadencia && !yaTieneReunion(donde.registro)) {
        const sec = await ponerEnSecuencia(donde.registro.id);
        caso.secuencia = sec.ok;
        if (sec.ok) salida.secuencias = (salida.secuencias || 0) + 1;
        else salida.fallas++;
      }
    }

    decir(
      `${aplicar ? (caso.tarea || a.tieneTarea ? 'OK ' : 'MAL') : '~  '} ${quien} (${donde.equipo}), escribio el ` +
      `${caso.escribio}, hace ${a.horasEsperando}h -> ${a.tieneTarea ? 'ya tenia tarea de este cierre' : `tarea para ${caso.responsable}`}` +
      `${propio ? ' (ya es suyo)' : ''}, vence ${a.vueltaISO}` +
      `${caso.aviso ? ' + aviso enviado' : ''}` +
      `${yaEnCadencia ? ' · SIN aviso: ya le escribe la cadencia' : ''}` +
      `${!yaEnCadencia && yaCerro ? ' · SIN aviso: ya cerro la conversacion' : ''}` +
      `${caso.sinAvisoPorSerLead ? ' · SIN aviso: es lead' : ''}` +
      `${caso.sinAvisoPorEquipo ? ' · SIN aviso: lo estaba atendiendo el equipo' : ''}` +
      `${caso.secuencia ? ' + entro a Agendamiento' : ''}` +
      `${donde.porConversacion ? ` · escribio desde OTRO numero (${a.mobile_number__s}), la ficha salio de la conversacion` : ''}` +
      `${donde.modulo === 'Leads' && yaTieneReunion(donde.registro) ? ' · SIN secuencia: ya tiene reunion agendada' : ''}` +
      `${donde.modulo === 'Leads' && yaEnCadencia ? ` (ya venia en ${caso.estadoPrevio})` : ''}`
    );
    salida.casos.push(caso);
  }

  return salida;
}
