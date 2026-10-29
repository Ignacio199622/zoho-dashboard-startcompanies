// GUARDIA FUERA DE HORARIO
//
// Decide dos cosas y nada mas:
//   1. si en este momento hay alguien atendiendo
//   2. a que conversaciones les corresponde el aviso automatico
//
// NO manda WhatsApp y NO escribe en Zoho. El envio lo hace Zoho con una
// plantilla aprobada, disparado por la casilla `Aviso_Fuera_Horario` del
// registro; este modulo solo dice a quien habria que tildarsela. La razon esta
// en el encabezado de `zoho.js`: en agosto de 2026 una regla en bucle mando la
// misma plantilla cada tres minutos hasta que Meta bloqueo el numero.
//
// Decisiones de Ignacio del 2026-09-05 y 2026-09-07, para que no se re-discutan
// al leer el codigo:
//   - Horario: 9 a 18, hora de Argentina, lunes a viernes.
//   - Feriados: los federales de Estados Unidos, con fecha observada.
//   - Clientes: esperar 15 minutos antes de avisar. Si contesto una persona en
//     ese rato, no sale nada.
//   - Un aviso por conversacion por dia, y tope duro por corrida.
import { TZ_EQUIPO } from './config.js';

export const ABRE = 9;
export const CIERRA = 18;

// Minutos que se espera antes de avisar.
//
// Eran 15, por si contestaba una persona. Medido sobre 14 dias (1.396
// conversaciones con movimiento): de las 236 que quedaron de noche en dia
// habil, contesto una persona en 2. El resto lo contesto el robot o nadie.
// Quince minutos de espera para todos los clientes compraban un caso de cada
// cien, y con el cron cada 10 minutos la espera real quedaba en 15 a 25
// minutos. Bajado a 5 el 2026-09-08 por decision de Ignacio: la espera del
// cliente pasa a 5-15 minutos.
//
// No va a cero a proposito: la gente manda dos o tres mensajes seguidos
// mientras piensa, y contestarle en el medio de la rafaga queda peor que
// tardar. El caso que lo destapo (7-sep, 23:48) mando el segundo mensaje a
// los pocos minutos del primero.
//
// Vuelto a 15 el 30-sep-2026 por decision de Ignacio: si un chico contesta en
// ese rato, el robot no se mete. Con el cron cada 10 minutos la espera del
// cliente queda en 15 a 25 minutos.
export const MINUTOS_DE_GRACIA = 15;

// Tope duro por corrida. Si una corrida quiere avisar mas que esto, algo se
// rompio: mejor cortar y que lo mire una persona.
export const TOPE_POR_CORRIDA = 20;

// Feriados federales de Estados Unidos con la fecha OBSERVADA: cuando el
// feriado cae sabado se corre al viernes anterior, cuando cae domingo al lunes
// siguiente. Esa es la fecha en que efectivamente esta todo cerrado.
// Al agregar o sacar un dia se toca solo esta lista.
export const FERIADOS = new Set([
  '2026-09-07', // Labor Day
  '2026-10-12', // Columbus Day
  '2026-11-11', // Veterans Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas Day
  '2027-01-01', // New Year's Day
  '2027-01-18', // Martin Luther King Jr. Day
  '2027-02-15', // Presidents' Day
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth (observado, cae sabado)
  '2027-07-05', // Independence Day (observado, cae domingo)
  '2027-09-06', // Labor Day
  '2027-10-11', // Columbus Day
  '2027-11-11', // Veterans Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Christmas Day (observado, cae sabado)
]);

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
               'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// ─── Quien atiende ─────────────────────────────────────────────────────────
// Los id salen de leer el dueño de los registros: la API no deja listar
// usuarios (`users` da OAUTH_SCOPE_MISMATCH), pero cada lead y cada tarea
// traen su Owner con id y mail.
//
// El reparto lo definio Ignacio el 2026-09-07: venta va a Santiago o al
// vendedor que ya tenga el lead; cliente rota entre los de CX.
export const VENTAS = [
  { id: '6698625000041418001', nombre: 'Santiago Cuellar', mail: 'santiago@startcompanies.io' },
];

export const CX = [
  { id: '6698625000048708001', nombre: 'Camila Salazar', mail: 'camila@startcompanies.io' },
  { id: '6698625000056211001', nombre: 'Pablo Gijon', mail: 'pablo@startcompanies.net' },
  { id: '6698625000002191001', nombre: 'Ignacio Campo', mail: 'ignaciocampo@startcompanies.io' },
  // Falta Guadalupe: no aparece como dueña de ningun registro, asi que no
  // tengo su id. Cuando Ignacio lo confirme se agrega aca y entra en la rueda.
];

// El usuario robot. Que un registro sea de el es lo mismo que no tener dueño.
export const ROBOT = 'Start Companies Staff';

/** A quien le toca esta vez. Rota por dia para que no caiga siempre al mismo. */
export function aQuienLeToca(equipo, fecha = new Date()) {
  if (!equipo.length) return null;
  const dias = Math.floor(Date.parse(`${enArgentina(fecha).iso}T12:00:00Z`) / 864e5);
  return equipo[dias % equipo.length];
}

// Una fecha cualquiera vista con los ojos del equipo, que esta en Argentina.
// Se arma un Date "local falso" con los componentes de Buenos Aires para poder
// preguntarle el dia y la hora sin arrastrar el huso de la maquina que corre.
function enArgentina(fecha) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_EQUIPO,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(fecha).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  // hourCycle h23 devuelve "24" a la medianoche en algunos runtimes.
  const hora = Number(p.hour) % 24;
  return {
    iso: `${p.year}-${p.month}-${p.day}`,
    hora,
    minuto: Number(p.minute),
    // getUTCDay sobre la fecha civil: no depende del huso de la maquina.
    dow: new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`).getUTCDay(),
  };
}

/** El dia de hoy en Argentina, en yyyy-mm-dd. */
export function hoyEnArgentina(fecha = new Date()) {
  return enArgentina(fecha).iso;
}

export function esFinDeSemana(fecha) {
  const d = enArgentina(fecha).dow;
  return d === 0 || d === 6;
}

export function esFeriado(fecha) {
  return FERIADOS.has(enArgentina(fecha).iso);
}

/** Dia entero sin atencion: sabado, domingo o feriado. */
export function diaCerrado(fecha) {
  return esFinDeSemana(fecha) || esFeriado(fecha);
}

/** ¿Hay alguien atendiendo en este momento? */
export function estaAbierto(fecha = new Date()) {
  if (diaCerrado(fecha)) return false;
  const { hora } = enArgentina(fecha);
  return hora >= ABRE && hora < CIERRA;
}

/** Por que esta cerrado, para el log del equipo. */
export function motivo(fecha = new Date()) {
  if (esFeriado(fecha)) return 'feriado en Estados Unidos';
  if (esFinDeSemana(fecha)) return DIAS[enArgentina(fecha).dow];
  const { hora } = enArgentina(fecha);
  if (hora < ABRE) return 'todavía no abrimos';
  if (hora >= CIERRA) return 'ya cerramos';
  return null;
}

/**
 * Lo mismo pero dicho para el cliente, y en dia no laborable dicho con todas
 * las letras. "No hay nadie conectado" un sabado suena a que la empresa esta
 * desatendida; "hoy es sabado y no es dia laborable" es un dato, no una excusa.
 *
 * Es la variable {{2}} de las plantillas, y va como frase entera porque
 * enganchar con "asi que no hay nadie" cambia segun el caso.
 */
export function motivoParaElCliente(fecha = new Date()) {
  if (esFeriado(fecha)) {
    return `hoy ${DIAS[enArgentina(fecha).dow]} es feriado en Estados Unidos y no es día laborable`;
  }
  if (esFinDeSemana(fecha)) {
    return `hoy es ${DIAS[enArgentina(fecha).dow]} y no es día laborable`;
  }
  const { hora } = enArgentina(fecha);
  if (hora < ABRE) return 'todavía no arrancamos el día';
  return 'ya terminamos la jornada';
}

function sumarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function cerradoISO(iso) {
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6 || FERIADOS.has(iso);
}

// Argentina esta en UTC-3 todo el año, sin horario de verano desde 2009. Por
// eso se puede armar el instante pegando el huso a mano; si algun dia vuelve el
// cambio de hora, esto es lo primero que hay que revisar.
function instanteEnArgentina(iso, hora) {
  return new Date(`${iso}T${String(hora).padStart(2, '0')}:00:00-03:00`);
}

/**
 * Cuando arranco el cierre en el que estamos.
 *
 * Es la ventana en la que a una persona le corresponde UN solo aviso. No es
 * "el dia": la noche del lunes al martes es un unico cierre que cruza la
 * medianoche, y un finde largo es un cierre de tres o cuatro dias.
 *
 * Preguntar por el dia del calendario fue el bug del 8-sep-2026: a las 00:00
 * cambiaba el dia, todos los que habian escrito la noche anterior volvian a
 * quedar habilitados y recibian el mismo aviso por segunda vez, sin que hubiera
 * pasado nada nuevo y con la oficina todavia cerrada.
 *
 * Devuelve las 18:00 del ultimo dia habil.
 */
export function inicioDelCierre(fecha = new Date()) {
  const { iso, hora } = enArgentina(fecha);

  // Dia habil despues de las 18: el cierre arranco hoy mismo.
  if (!cerradoISO(iso) && hora >= CIERRA) return instanteEnArgentina(iso, CIERRA);

  // Si no (madrugada de un dia habil, finde o feriado), hay que retroceder
  // hasta el ultimo dia que si se trabajo.
  let d = iso;
  for (let i = 0; i < 30; i++) {
    d = sumarDias(d, -1);
    if (!cerradoISO(d)) return instanteEnArgentina(d, CIERRA);
  }
  return instanteEnArgentina(d, CIERRA);
}

/**
 * Cuando vuelve a haber alguien, y como se dice en un mensaje.
 * Devuelve { iso, frase }. La frase es la que va en la variable de la plantilla.
 */
export function proximaApertura(fecha = new Date()) {
  const { iso, hora } = enArgentina(fecha);

  // Antes de las 9 de un dia habil: abrimos hoy mismo.
  if (!cerradoISO(iso) && hora < ABRE) {
    return { iso, frase: 'hoy a las 9', porque: null };
  }

  // Se anotan los dias que se saltean para poder explicar por que. Un finde no
  // hace falta explicarlo, un feriado si: nadie sabe de memoria que el lunes es
  // Labor Day, y sin el motivo "te respondemos el martes" suena a desidia.
  const saltados = [];
  let siguiente = sumarDias(iso, 1);
  for (let i = 0; i < 20 && cerradoISO(siguiente); i++) {
    saltados.push(siguiente);
    siguiente = sumarDias(siguiente, 1);
  }

  const esManana = siguiente === sumarDias(iso, 1);
  const d = new Date(`${siguiente}T12:00:00Z`);
  const cuando = esManana
    ? 'mañana a las 9'
    : `el ${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} a las 9`;

  // El motivo solo se dice cuando explica una espera mas larga de lo normal.
  // Si volvemos mañana no hace falta justificar nada, y agregarlo suena a excusa.
  const feriadoSaltado = esManana
    ? null
    : saltados.find((x) => FERIADOS.has(x) && !esFinDeSemanaISO(x));
  const porque = feriadoSaltado
    ? `el ${DIAS[new Date(`${feriadoSaltado}T12:00:00Z`).getUTCDay()]} es feriado en Estados Unidos`
    : null;

  return { iso: siguiente, frase: porque ? `${cuando}, porque ${porque}` : cuando, porque };
}

function esFinDeSemanaISO(iso) {
  const d = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

// ─── Lo que recibe la persona ──────────────────────────────────────────────
//
// Son los cuerpos de las dos plantillas de WhatsApp, tal cual hay que cargarlas
// en Zoho (Configuracion -> Canales -> WhatsApp), categoria Utilidad.
//
//   {{1}} = el nombre de pila     -> se mapea a First_Name
//   {{2}} = cuando volvemos       -> se mapea a Vuelta_Habil
//
// Estan escritos para que no suenen a robot: nombre propio, se dice que no hay
// nadie en vez de "su mensaje ha sido recibido", y siempre hay algo que la
// persona puede hacer ahora en vez de esperar.
export const LINK_AGENDA = 'cal.com/startcompanies-businessenusa/30min';

export const TEXTOS = {
  lead: [
    'Hola {{1}}, gracias por escribir a Start Companies.',
    'Te cuento que {{2}}, así que no hay nadie del equipo conectado. Tu mensaje ya quedó registrado y lo vemos {{3}}.',
    'Si no querés esperar, podés dejar agendada una llamada de 30 minutos con un asesor y sacarte todas las dudas de una: ' + LINK_AGENDA,
    'Y si nos contás por acá qué necesitás, llegamos con eso ya revisado.',
  ].join('\n\n'),

  cliente: [
    'Hola {{1}}, gracias por escribir.',
    'Te cuento que {{2}}, así que no hay nadie del equipo conectado. Tu mensaje ya quedó registrado y te respondemos {{3}}.',
    'Si es algo urgente, como una fecha límite de tu LLC o un problema con la cuenta bancaria, dejanos el detalle por acá y lo tomamos primero apenas abrimos.',
  ].join('\n\n'),
};

// ─── El que ya cerro la conversacion ───────────────────────────────────────
//
// Mandarle "no hay nadie del equipo conectado" al que escribio "Dale" es
// gastar un credito de WhatsApp en molestar. El 7-sep-2026 salieron asi 3 de
// los 6 avisos del dia, y Luciana Heredia lo recibio DOS veces por haber dicho
// "Dale".
//
// Es deterministico y no usa el modelo a proposito. `clasificar.js` haria un
// trabajo mas fino, pero necesita GEMINI_API_KEY y esa variable NO existe en
// Netlify: en la nube se caeria siempre y el filtro no filtraria nada. Esto
// anda en los dos lados, se prueba sin red y no cuesta tokens.
//
// El criterio es a proposito estrecho: ante la duda, que salga el aviso. Dejar
// esperando en silencio a alguien que preguntaba algo es peor que un mensaje
// de mas.

// Tiene que haber al menos UNA de estas para considerarlo un cierre. Sin este
// requisito, un "si" suelto pasaria por ruido, y un "si" puede ser el si a una
// pregunta del equipo, que si merece el aviso.
const ACUSES = new Set([
  'gracias', 'ok', 'oka', 'okey', 'okok', 'okis', 'okay', 'dale', 'listo', 'lista',
  'perfecto', 'perfecta', 'genial', 'excelente', 'barbaro', 'buenisimo', 'buenisima',
  'joya', 'entendido', 'entendida', 'igualmente', 'vale', 'copiado', 'recibido',
]);

// Relleno permitido alrededor del acuse. Si aparece cualquier palabra que no
// este ni aca ni en ACUSES, no es un cierre.
const RELLENO = new Set([
  'muchas', 'muchisimas', 'mil', 'de', 'nada', 'no', 'hay', 'problema', 'todo', 'bien',
  'esta', 'ya', 'si', 'y', 'a', 'al', 'las', 'los', 'la', 'el', 'un', 'una', 'por',
  'hasta', 'nos', 'vemos', 'hablamos', 'luego', 'despues', 'entonces', 'ahi', 'muy',
  'amable', 'quedo', 'atento', 'atenta', 'saludos', 'abrazo', 'buenas', 'buen', 'buenos',
  'dia', 'dias', 'tarde', 'tardes', 'noche', 'noches', 'manana', 'hoy', 'lunes', 'martes',
  'miercoles', 'jueves', 'viernes', 'sabado', 'domingo', 'hs', 'am', 'pm', 'me',
]);

// Mas largo que esto ya no es un "gracias": es alguien contando algo.
const MAX_PALABRAS_CIERRE = 8;

/**
 * ¿El ultimo mensaje cierra la conversacion en vez de pedir algo?
 *
 * Devuelve true solo para agradecimientos y acuses de recibo. Una pregunta
 * nunca cuenta, por corta que sea.
 */
export function esCierreDeConversacion(mensaje) {
  const bruto = String(mensaje == null ? '' : mensaje);
  if (!bruto.trim()) return false;
  // Un signo de pregunta descarta todo lo demas.
  if (/[?¿]/.test(bruto)) return false;

  const limpio = bruto
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // fuera los tildes
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}/gu, ' ')         // fuera los emojis
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Solo emojis o solo signos: no hay nada que contestar.
  if (!limpio) return true;

  const palabras = limpio.split(' ');
  if (palabras.length > MAX_PALABRAS_CIERRE) return false;
  if (!palabras.some((p) => ACUSES.has(p))) return false;
  return palabras.every((p) => ACUSES.has(p) || RELLENO.has(p) || /^\d+$/.test(p));
}

// El que dijo "no me interesa" NO se contesta, en ninguna forma (Ignacio,
// 10-sep-2026). Ni el WhatsApp de "no hay nadie, agenda aca", ni la tarea de
// "Contestar a", ni meterlo en la secuencia de Agendamiento: las tres cosas son
// insistirle al que acaba de decir que no. El 9-sep, Arturo A y Maria Grandio
// dijeron "No me interesa SC" a la mañana y a las 18:02 recibieron la
// invitacion a agendar, y a las 18:07 la plantilla de la cadencia.
//
// La baja del blueprint no es tarea de la guardia: la hace `bajas.js`.
//
// Es a proposito una lista corta de frases ENTERAS (el mensaje tiene que ser
// eso, con o sin la coletilla del boton), no palabras sueltas: "no me interesa
// pagar tanto, hay otra opcion?" es una objecion, no un rechazo, y ese si
// merece que alguien lo llame.
const RECHAZOS = [
  'no me interesa', 'no me interesa sc', 'no me interesa gracias', 'no gracias',
  'no estoy interesado', 'no estoy interesada', 'baja', 'buscaba otra cosa',
  'lo siento buscaba otra cosa', 'me equivoque', 'numero equivocado',
  'ya no me interesa', 'no quiero', 'no por ahora', 'por ahora no',
];

/**
 * ¿El ultimo mensaje es un "no me interesa"? A esa persona la guardia no la
 * toca: ni aviso, ni tarea, ni secuencia.
 */
export function esRechazo(mensaje) {
  const bruto = String(mensaje == null ? '' : mensaje);
  if (/[?¿]/.test(bruto)) return false;
  const limpio = bruto
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return RECHAZOS.includes(limpio);
}

/** El texto ya armado, para mostrarlo en la corrida de prueba. */
export function textoPara(equipo, nombre, porQue, vuelta) {
  return (equipo === 'CX' ? TEXTOS.cliente : TEXTOS.lead)
    .replace('{{1}}', nombre || 'hola')
    .replace('{{2}}', porQue)
    .replace('{{3}}', vuelta);
}

/**
 * De las conversaciones que estan esperando respuesta, cuales merecen el aviso.
 *
 * `pendientes` son las que devuelve `reglas.pendientes()`: el ultimo que hablo
 * fue el cliente y nadie contesto. Sobre eso se pide, ademas:
 *
 *   - que el mensaje haya entrado fuera de horario (no vale que haya entrado a
 *     las 17:50 y lo miremos a las 18:05: a esa hora habia alguien)
 *   - que sigamos cerrados AHORA, para no avisar "no hay nadie" un lunes 9:05
 *   - que hayan pasado los 15 minutos de gracia
 *   - que no se le haya avisado ya hoy
 *
 * `yaAvisados` es un Set de claves "idConversacion:yyyy-mm-dd".
 */
export function paraAvisar(pendientes, ahora = new Date(), yaAvisados = new Set()) {
  if (estaAbierto(ahora)) return { avisos: [], corte: null };

  const hoy = enArgentina(ahora).iso;
  const vuelta = proximaApertura(ahora);
  const avisos = [];

  for (const c of pendientes) {
    if (!c.cuando || estaAbierto(c.cuando)) continue;
    if (c.minutosEsperando < MINUTOS_DE_GRACIA) continue;
    if (yaAvisados.has(`${c.ref}:${hoy}`)) continue;

    avisos.push({
      ...c,
      clave: `${c.ref}:${hoy}`,
      motivo: motivo(c.cuando),
      vuelta: vuelta.frase,
      vueltaISO: vuelta.iso,
      // La ventana de 24h no importa para esto: el aviso sale como plantilla
      // aprobada, que se puede mandar igual. Se deja a la vista para el que lea.
      ventanaCerrada: c.ventanaCerrada,
    });
  }

  // El que espera hace mas rato primero, por si hay que cortar por el tope.
  avisos.sort((a, b) => b.minutosEsperando - a.minutosEsperando);

  if (avisos.length > TOPE_POR_CORRIDA) {
    return { avisos: avisos.slice(0, TOPE_POR_CORRIDA), corte: avisos.length };
  }
  return { avisos, corte: null };
}

// ─── La que ya esta atendiendo una persona ─────────────────────────────────
//
// Reclamo del 30-sep-2026: los chicos contestan de noche o el finde, el
// cliente les responde, y a los 5 minutos le llega "no hay nadie del equipo
// conectado". El robot desmiente a la persona que le esta escribiendo.
//
// `messages__s` guarda solo el ultimo mensaje, y cuando el cliente vuelve a
// escribir `replied_by__s` queda vacio: en la foto de ese momento no se ve que
// hubo una persona. Por eso la guardia se anota, en cada corrida, las
// conversaciones que encuentra contestadas por alguien del equipo dentro del
// cierre, y a esas no les manda el aviso hasta que vuelva a abrir. La tarea se
// crea igual: el que estaba contestando capaz lo dejo para la mañana.
//
// Limite conocido: si la persona contesta y el cliente responde antes de la
// corrida siguiente (cada 10 minutos), esa respuesta no se llega a ver.

// Una hora antes del cierre, para el que contesto a las 17:50 y el cliente le
// respondio a las 18:05. Solo se ve si a la primera corrida de la noche la
// conversacion seguia contestada.
const MARGEN_ANTES_DEL_CIERRE_MS = 60 * 60e3;

// Horas minimas que dura el "ya lo atiende alguien" aunque cambie el dia: el
// que contesto a las 23:50 no puede quedar desmentido a las 00:10.
const HORAS_MINIMAS_ATENDIDA = 3;

/**
 * ¿Sigue valiendo que a esta persona la esta atendiendo alguien del equipo?
 *
 * Decision de Ignacio (30-sep-2026): si alguien le contesta ese dia, el aviso
 * queda apagado para esa persona ESE dia. En un finde largo el dia siguiente
 * vuelve a correr la guardia normal.
 */
export function sigueAtendida(iso, ahora = new Date()) {
  if (!iso) return false;
  const t = new Date(iso);
  if (hoyEnArgentina(t) === hoyEnArgentina(ahora)) return true;
  return ahora - t < HORAS_MINIMAS_ATENDIDA * 3600e3;
}

/**
 * Suma a `previas` las conversaciones que contesto una persona en este cierre
 * y descarta las de cierres anteriores.
 *
 * `previas` y el resultado son { idConversacion: iso del mensaje de la persona }.
 */
export function atendidasEnCierre(conversaciones, previas = {}, desde, robot = ROBOT) {
  const corte = desde.getTime() - MARGEN_ANTES_DEL_CIERRE_MS;
  const out = {};
  for (const [id, iso] of Object.entries(previas || {})) {
    if (Date.parse(iso) >= corte) out[id] = iso;
  }
  for (const c of conversaciones) {
    const quien = c.replied_by__s?.name;
    if (c.conversation_status__s !== 'Replied' || !quien || quien === robot) continue;
    const t = Date.parse(c.message_time__s);
    if (!(t >= corte)) continue;
    if (!out[c.id] || Date.parse(out[c.id]) < t) out[c.id] = new Date(t).toISOString();
  }
  return out;
}

// ─── Que el cliente vuelva a escribir ──────────────────────────────────────
//
// Reclamo del 30-sep-2026: el aviso cuenta como respuesta nuestra, la
// conversacion queda "contestada" y a la mañana no aparece en el filtro de no
// contestados. Si el cliente vuelve a escribir, reaparece.
//
// Va DENTRO de la variable de la vuelta ({{3}} = Vuelta_Habil) y no en el
// cuerpo de la plantilla: Meta aprobo el marco, lo que entra por la variable no
// se vuelve a aprobar. Sin punto final (lo pone la plantilla) y en una sola
// linea: un salto de linea en una variable hace que Meta rechace el mensaje.
//
// El "si ya lo escribiste arriba" es pedido de Ignacio: el que ya conto todo
// antes del aviso no tiene por que saber que tiene que repetirlo.
// Y tiene que sonar obligatorio, no opcional (Ignacio, 30-sep): si no la
// escribe abajo, a la mañana nadie la ve.
export const PEDIDO_DE_DETALLE =
  'IMPORTANTE: escribí tu consulta acá abajo, aunque ya la hayas mandado';

/** La vuelta con el pedido pegado, tal cual va a `Vuelta_Habil`. */
export function vueltaConPedido(frase) {
  return `${frase}. ${PEDIDO_DE_DETALLE}`;
}
