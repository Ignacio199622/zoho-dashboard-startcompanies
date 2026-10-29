// UNA PASADA DE RESPUESTA AUTOMATICA.
//
// Lee las conversaciones donde el cliente hablo ultimo, decide si alguna tiene
// respuesta en la base, y la manda por la Cloud API de Meta.
//
// El orden es el que hace que esto sea seguro, y va de lo barato a lo caro:
//
//   1. Gracia: si el cliente escribio hace menos de N minutos, se espera. Puede
//      estar mandando dos o tres mensajes seguidos, y contestarle en el medio
//      de la rafaga queda peor que tardar. Ademas le da lugar a una persona.
//   2. Ya le contestamos hoy: no se insiste.
//   3. Frenos deterministicos (`responder.js`): enojo, regateo, ya lo intento,
//      quiere avanzar, archivo suelto. No cuestan un token.
//   4. Recien ahi el modelo, que ELIGE una entrada. Nunca escribe.
//   5. Tope duro por corrida.
//
// La gracia es 20 minutos y no 5 a proposito. Medido sobre las respuestas
// humanas reales del CRM: NINGUNA llego en menos de 5 minutos, y un tercio
// llego entre 5 y 20. Con 5 minutos el robot le gana al humano casi siempre y
// pasa a ser la voz principal; con 20 solo habla cuando el equipo esta
// realmente ocupado. Se aprieta cuando la sombra muestre que acierta.
import { conversacionesDesde, fichas } from './zoho.js';
import { estaAbierto } from './guardia.js';
import { elegir, decidirRespuesta, freno } from './responder.js';
import { generar } from './gemini.js';
import { MODELO_GEMINI } from './config.js';
import { porZoho } from './enviar-zoho.js';
import {
  mandarTexto,
  configurado,
  porQueNoConfigurado,
  ENVIAR_DE_VERDAD,
  TOPE_POR_CORRIDA,
  TOPE_POR_DIA,
  VENTANA_HORAS,
} from './enviar.js';

// SIN ESPERA. Decision de Ignacio (2026-09-09): el bot es siempre la primera
// voz. Contesta apenas entra el mensaje y el equipo llega despues.
//
// Esto reemplaza la espera de 20 minutos que habia antes. El razonamiento de
// aquella era dejar que contestara una persona si estaba disponible; el de esta
// es que si contestamos en segundos, no hay con quien chocar: nadie del equipo
// llego a empezar. Medido: ninguna respuesta humana llego en menos de 5 minutos.
//
// El unico costo real es la rafaga: la gente manda dos o tres mensajes seguidos
// mientras piensa. Por eso quedan 30 segundos, que no se sienten como espera
// pero alcanzan para no contestar en el medio de la frase.
export const MINUTOS_DE_GRACIA = Number(process.env.RESPUESTAS_GRACIA || 0.5);

// Cuanto para atras se lee. Con el cron cada 10 minutos alcanza y sobra; el
// margen cubre una corrida perdida.
const HORAS_VENTANA_LECTURA = 3;

const POR_TANDA = 20;

/**
 * @param {object} opciones
 * @param {(numero: string, texto: string) => Promise<object>} opciones.mandar
 *        Inyectable para poder probar sin mandar nada.
 * @param {Map<string, string>} opciones.yaContestadas
 *        conversationId -> ISO de la ultima vez que le contestamos. Es el
 *        candado 3 y lo provee quien llama (blob en Netlify, archivo en la
 *        maquina), para que este modulo no dependa de donde se guarda.
 */
export async function unaPasada({
  ahora = new Date(),
  mandar = mandarTexto,
  yaContestadas = new Map(),
  enviar = ENVIAR_DE_VERDAD,
  tope = TOPE_POR_CORRIDA,
  enviadosHoy = 0,
  topeDia = TOPE_POR_DIA,
  gracia = MINUTOS_DE_GRACIA,
  // 'zoho'  -> plantilla aprobada disparada por la casilla (el camino que anda)
  // 'meta'  -> Cloud API, texto libre (cerrado mientras Zoho sea el BSP)
  via = process.env.RESPUESTAS_VIA || 'zoho',
} = {}) {
  // El tope del dia manda sobre el de la corrida. `enviadosHoy` lo provee quien
  // llama, contando la bitacora del dia.
  const cupo = Math.max(0, Math.min(tope, topeDia - enviadosHoy));

  // SOLO EN HORARIO. Decision de Ignacio (2026-09-08): fuera de horario y los
  // no laborables contesta la guardia con el mensaje de ausencia; en horario
  // contesta esto. Sin este corte los dos se dispararian sobre el mismo cliente
  // y recibiria "no hay nadie conectado" y una respuesta, con diez minutos de
  // diferencia. `estaAbierto` es la MISMA funcion que usa la guardia, asi que
  // los feriados y el horario se definen en un solo lugar.
  if (!estaAbierto(ahora)) {
    return {
      revisadas: 0,
      candidatas: 0,
      enviados: [],
      saltadas: [],
      motivo: 'fuera de horario: contesta la guardia',
    };
  }
  const desde = new Date(ahora.getTime() - HORAS_VENTANA_LECTURA * 3600 * 1000);
  const todas = await conversacionesDesde(desde);

  const bitacora = [];
  const saltadas = [];
  const nota = (c, motivo) =>
    saltadas.push({ id: c.id, numero: c.mobile_number__s, motivo, mensaje: c.last_message__s });

  // 1 y 2: los candados que no necesitan leer el mensaje.
  const candidatas = [];
  for (const c of todas) {
    if (c.conversation_status__s !== 'Responded') continue;
    if (!c.last_message__s) continue;

    const cuando = c.message_time__s ? new Date(c.message_time__s) : null;
    if (!cuando || Number.isNaN(cuando.getTime())) {
      nota(c, 'sin fecha de mensaje');
      continue;
    }
    const minutos = (ahora - cuando) / 60000;
    if (minutos < gracia) {
      nota(c, `recien escribio (${Math.round(minutos)} min)`);
      continue;
    }

    const ultima = yaContestadas.get(String(c.id));
    if (ultima && (ahora - new Date(ultima)) / 3600000 < VENTANA_HORAS) {
      nota(c, 'ya le contestamos hace poco');
      continue;
    }

    // 3: los frenos deterministicos, antes de gastar un token.
    const f = freno(c.last_message__s);
    if (f) {
      nota(c, f);
      continue;
    }
    candidatas.push(c);
  }

  if (!candidatas.length) {
    return { revisadas: todas.length, candidatas: 0, enviados: [], saltadas, uso: null };
  }

  // Quien es cada uno: hace falta para el nombre y para saber si es cliente.
  const mapa = await fichas(candidatas.map((c) => c.sender__s));
  for (const [i, c] of candidatas.entries()) {
    c.ref = `c${i}`;
    const s = c.sender__s;
    c.ficha = s ? mapa[`${s.module?.api_name}:${s.id}`] : null;
  }

  // Por Zoho el mensaje sale por la regla, y la regla manda al campo Movil.
  // Un contacto que tenga el numero solo en Telefono se encuentra igual, pero
  // el WhatsApp no saldria: quedaria la casilla tildada y la bitacora diciendo
  // 'enviado' sin que nadie reciba nada.
  if (via === 'zoho') {
    for (let i = candidatas.length - 1; i >= 0; i -= 1) {
      if (candidatas[i].ficha?.Mobile) continue;
      nota(candidatas[i], 'sin Movil cargado: la regla de Zoho no puede mandar');
      candidatas.splice(i, 1);
    }
    if (!candidatas.length) {
      return { revisadas: todas.length, candidatas: 0, enviados: [], saltadas, uso: null };
    }
  }

  // 4: el modelo elige.
  const porRef = {};
  const uso = { entrada: 0, salida: 0 };
  for (let i = 0; i < candidatas.length; i += POR_TANDA) {
    const r = await elegir(candidatas.slice(i, i + POR_TANDA), {
      generar,
      modelo: MODELO_GEMINI,
    });
    Object.assign(porRef, r.porRef);
    uso.entrada += r.uso.entrada;
    uso.salida += r.uso.salida;
  }

  const aResponder = [];
  for (const c of candidatas) {
    const d = decidirRespuesta(c, porRef[c.ref], { ahora });
    if (d.responde) aResponder.push({ c, d });
    else nota(c, d.motivo);
  }

  // 5: el tope. Si una corrida quiere mandar mas que esto, algo se rompio.
  const topeado = aResponder.length > cupo;
  const salen = aResponder.slice(0, cupo);
  for (const { c } of aResponder.slice(cupo)) {
    nota(c, enviadosHoy >= topeDia ? 'se agoto el cupo del dia' : 'cortado por el tope de la corrida');
  }

  const enviados = [];
  for (const { c, d } of salen) {
    const fila = {
      id: String(c.id),
      numero: c.mobile_number__s,
      quien: c.ficha?.Full_Name || c.mobile_number__s,
      esCliente: c.ficha?.modulo === 'Contacts',
      entrada: d.entrada.id,
      inicio: d.inicio,
      pregunta: c.last_message__s,
      texto: d.texto,
      cuando: ahora.toISOString(),
    };

    if (!enviar) {
      fila.resultado = 'sombra';
    } else if (via === 'meta' && !configurado()) {
      fila.resultado = 'no configurado';
      fila.error = porQueNoConfigurado();
    } else {
      // Por Zoho hay que escribir sobre el registro, no sobre el numero, asi
      // que el emisor se arma por conversacion. Por Cloud API da igual.
      const emisor = via === 'zoho' ? porZoho(c.ficha) : mandar;
      const r = await emisor(c.mobile_number__s, d.texto);
      fila.resultado = r.ok ? 'enviado' : 'error';
      fila.mensajeId = r.id || null;
      fila.error = r.ok ? null : r.error;
      fila.ventanaCerrada = r.ventanaCerrada || false;
    }

    enviados.push(fila);
    bitacora.push(fila);
  }

  return {
    revisadas: todas.length,
    candidatas: candidatas.length,
    enviados,
    saltadas,
    topeado,
    uso,
    via,
    modo: enviar ? (via === 'zoho' || configurado() ? 'enviando' : 'sin token') : 'sombra',
  };
}
