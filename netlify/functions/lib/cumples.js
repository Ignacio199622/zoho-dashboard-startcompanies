// Cumpleaños del equipo y feriados de Estados Unidos: quien cumple "mañana".
//
// Lo pidio Ignacio el 16-sep-2026 en el hilo de Slack donde cada uno puso su
// fecha: un aviso a la Cupula EL DIA ANTES, y si el cumple cae lunes, el
// viernes. Nada mas: ni el mismo dia, ni resumen mensual, ni regalos.
//
// Los feriados van por la misma regla porque para un equipo que abre LLCs y
// cuentas en Estados Unidos un feriado alla es un dia sin bancos, sin IRS y
// sin Secretaria de Estado: conviene saberlo antes de prometerle algo a un
// cliente para ese dia.
//
// La lista vive aca y no en Notion a proposito: son 8 fechas que cambian una
// vez por año (cuando entra alguien). Una tabla mas seria mas cosas que
// mantener que lo que ahorra.

/** Las fechas tal cual las pusieron en el hilo (dia/mes). */
export const CUMPLES = [
  { nombre: 'Ignacio Campo', dia: 13, mes: 1 },
  { nombre: 'Camila', dia: 14, mes: 1 },
  { nombre: 'Pablo Gijón', dia: 27, mes: 4 },
  { nombre: 'Ignacio N.', dia: 22, mes: 5 },
  { nombre: 'Santi', dia: 21, mes: 6 },
  { nombre: 'Martín Poblet', dia: 22, mes: 7 },
  { nombre: 'Guadalupe Ramirez', dia: 11, mes: 8 },
  { nombre: 'Adrián', dia: 15, mes: 11 },
];

// ─── Feriados federales de Estados Unidos ─────────────────────────────────
//
// Se calculan, no se cargan: la mitad son "el tercer lunes de" y cambian de
// fecha todos los años. Si el feriado cae sabado se observa el viernes y si
// cae domingo el lunes; ese dia observado es el que cierran los bancos, asi
// que es el que se avisa.

const DIAS_MES = (a, m) => new Date(Date.UTC(a, m, 0)).getUTCDate(); // m en 1..12

/** El n-esimo (1..4) dia de la semana `dow` (0=dom) del mes `m` (1..12). */
function enesimo(a, m, dow, n) {
  const primero = new Date(Date.UTC(a, m - 1, 1)).getUTCDay();
  return 1 + ((dow - primero + 7) % 7) + (n - 1) * 7;
}

/** El ultimo dia de la semana `dow` del mes. */
function ultimo(a, m, dow) {
  const ultimoDia = DIAS_MES(a, m);
  const dowUltimo = new Date(Date.UTC(a, m - 1, ultimoDia)).getUTCDay();
  return ultimoDia - ((dowUltimo - dow + 7) % 7);
}

/** Corre un feriado fijo al viernes o al lunes si cae en finde. */
function observado(a, m, d) {
  const f = new Date(Date.UTC(a, m - 1, d));
  const dow = f.getUTCDay();
  if (dow === 6) f.setUTCDate(f.getUTCDate() - 1);
  if (dow === 0) f.setUTCDate(f.getUTCDate() + 1);
  return { mes: f.getUTCMonth() + 1, dia: f.getUTCDate(), corrido: dow === 6 || dow === 0 };
}

/** Los feriados federales de un año, con la fecha observada. */
export function feriadosUSA(a) {
  const fijo = (nombre, m, d) => ({ nombre, ...observado(a, m, d) });
  const movil = (nombre, m, d) => ({ nombre, mes: m, dia: d, corrido: false });
  return [
    fijo("Año Nuevo (New Year's Day)", 1, 1),
    movil('Martin Luther King Jr. Day', 1, enesimo(a, 1, 1, 3)),
    movil("Presidents' Day", 2, enesimo(a, 2, 1, 3)),
    movil('Memorial Day', 5, ultimo(a, 5, 1)),
    fijo('Juneteenth', 6, 19),
    fijo('Día de la Independencia (4th of July)', 7, 4),
    movil('Labor Day', 9, enesimo(a, 9, 1, 1)),
    movil('Columbus Day', 10, enesimo(a, 10, 1, 2)),
    fijo('Veterans Day', 11, 11),
    movil('Thanksgiving', 11, enesimo(a, 11, 4, 4)),
    fijo('Navidad (Christmas)', 12, 25),
  ];
}

// ─── Que se avisa hoy ─────────────────────────────────────────────────────

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const ymd = (d) => d.toISOString().slice(0, 10);
const masDias = (d, n) => new Date(d.getTime() + n * 86400000);
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * "Hoy" en Argentina como fecha UTC a medianoche. Netlify corre en UTC y a las
 * 9 de la mañana de Argentina ya es el mismo dia en UTC, pero se resta igual
 * para no depender de a que hora corra.
 */
export function hoyArgentina(ahora = new Date()) {
  const local = new Date(ahora.getTime() - 3 * 3600000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}

/**
 * Los dias que cubre el aviso de hoy: desde mañana hasta el proximo dia habil
 * inclusive. Un martes cubre el miercoles; un viernes cubre sabado, domingo y
 * lunes. Asi el cumple del lunes se avisa el viernes, que fue lo pedido.
 */
export function diasQueCubre(hoy) {
  const dias = [];
  let d = hoy;
  do {
    d = masDias(d, 1);
    dias.push(d);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return dias;
}

/** Como se nombra la fecha en el aviso: "mañana, jueves 21/6," o "el lunes 13/1". */
export function cuandoTexto(fecha, hoy) {
  const diff = Math.round((fecha - hoy) / 86400000);
  const ddmm = `${fecha.getUTCDate()}/${fecha.getUTCMonth() + 1}`;
  if (diff === 1) return `mañana, ${DIAS[fecha.getUTCDay()]} ${ddmm},`;
  return `el ${DIAS[fecha.getUTCDay()]} ${ddmm}`;
}

/**
 * Lo que hay para avisar hoy. Devuelve una lista vacia la mayoria de los dias,
 * y ese caso no manda nada: un "hoy no cumple nadie" diario es la forma mas
 * rapida de que silencien al bot.
 */
export function avisosDeHoy(hoy = hoyArgentina()) {
  const cubre = diasQueCubre(hoy);
  const feriados = new Map();
  for (const a of new Set(cubre.map((d) => d.getUTCFullYear()))) {
    for (const f of feriadosUSA(a)) feriados.set(`${a}-${f.mes}-${f.dia}`, f);
  }

  const avisos = [];
  for (const d of cubre) {
    const cuando = capital(cuandoTexto(d, hoy));
    for (const c of CUMPLES) {
      if (c.dia === d.getUTCDate() && c.mes === d.getUTCMonth() + 1) {
        avisos.push({ tipo: 'cumple', fecha: ymd(d), texto: `🎂 ${cuando} cumple años *${c.nombre}*. ¡A saludar!` });
      }
    }
    const f = feriados.get(`${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`);
    if (f) {
      const nota = f.corrido ? ' (cae en fin de semana, se observa ese día)' : '';
      avisos.push({
        tipo: 'feriado',
        fecha: ymd(d),
        texto: `🇺🇸 ${cuando} es feriado en Estados Unidos: *${f.nombre}*${nota}. Bancos, IRS y oficinas estatales cerrados.`,
      });
    }
  }
  return avisos;
}

/** El mensaje de Slack, o null si no hay nada que decir. */
export function armarMensaje(avisos) {
  if (!avisos.length) return null;
  const texto = avisos.map((a) => a.texto).join('\n');
  return {
    text: texto,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    unfurl_links: false,
  };
}
