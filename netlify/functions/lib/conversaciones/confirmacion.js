// EL "OK, ENTENDÍ" DEL CLIENTE.
//
// Idea de Ignacio (2026-09-09): la unica prueba de que una respuesta sirvio no
// la tenemos nosotros, la tiene el cliente. Si despues de que el equipo le
// explica algo contesta "listo, entendi" o "buenisimo, gracias", esa respuesta
// funciono. Si vuelve a preguntar, no.
//
// El par que ya guardaba `aprendizaje.js` es de dos mensajes:
//
//     cliente pregunta  ->  equipo contesta
//
// Esto agrega el tercero, que es el que convierte un par en una leccion:
//
//     cliente pregunta  ->  equipo contesta  ->  cliente confirma
//
// Se puede armar porque el agente pasa cada pocos minutos y el CRM guarda un
// mensaje por conversacion: en una pasada la ve en `Responded` (la pregunta),
// en otra en `Replied` (la respuesta) y en una tercera de nuevo en `Responded`
// (la confirmacion). Ninguna pasada ve las tres, pero el estado las junta.
//
// ─── POR QUE NO TODO "OK" CUENTA ───────────────────────────────────────────
//
// "ok" despues de "te paso el link" no confirma que entendio: acusa recibo de
// un archivo. La diferencia esta en que la respuesta del equipo haya EXPLICADO
// algo. Por eso se pide que la respuesta tenga cuerpo (varias lineas o una
// longitud minima) antes de contar la confirmacion como voto.
//
// Y una confirmacion NUNCA agrega sola una entrada a la base. Propone. El texto
// que le sale a un cliente lo aprueba una persona, igual que todo lo demas.

// Cierres que sí dicen "lo entendí": hay comprension, no solo cortesia.
const ENTENDIO = [
  /\bentend[ií]\b/, /\bentiendo\b/, /\bahora (si|s[ií]) (entiendo|me queda)/,
  /\bqued[oó] claro\b/, /\bclar[ií]simo\b/, /\btodo claro\b/, /\bahora s[ií]\b/,
  /\bme qued[oó] claro\b/, /\bya s[eé] (como|qu[eé])\b/, /\bperfecto,? (gracias|entend)/,
  /\bexcelente,? (gracias|entend)/, /\bbuen[ií]simo,? gracias\b/, /\bde diez\b/,
  /\bgenial,? (gracias|entend)/, /\bahora me queda\b/, /\bcomprendo\b/,
  /\bya lo (hice|resolv[ií]|solucion[eé])\b/, /\blisto,? (gracias|ya est[aá])/,
];

// Lo contrario: volvio a preguntar sobre lo mismo. Eso es un voto en contra.
const NO_ENTENDIO = [
  /\bno entend[ií]\b/, /\bno entiendo\b/, /\bno me qued[oó] claro\b/,
  /\bc[oó]mo es\?/, /\bo sea\b.*\?/, /\bpero entonces\b/, /\bsigo sin entender\b/,
  /\bme confund/, /\bte pregunto (otra vez|de nuevo)\b/, /\bno era eso\b/,
];

// Cortesia sin contenido: "gracias" solo no dice que entendio, dice que es
// educado. No cuenta ni a favor ni en contra.
const SOLO_CORTESIA = [
  /^\s*(muchas\s+)?gracias[\s!.]*$/, /^\s*(ok|oka|okey|dale|listo|va|perfecto)[\s!.]*$/,
  /^\s*(genial|buen[ií]simo|excelente|joya|barbaro)[\s!.]*$/, /^\s*👍+\s*$/,
];

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Debajo de esto la respuesta del equipo fue un dato suelto, no una explicacion,
// y el "ok" del cliente no prueba nada.
const LARGO_MINIMO_EXPLICACION = 120;

/**
 * ¿La respuesta del equipo explicó algo, o solo pasó un dato?
 * Solo sobre las que explican tiene sentido medir si el cliente entendió.
 */
export function esExplicacion(respuesta) {
  const t = String(respuesta || '').trim();
  if (t.length >= LARGO_MINIMO_EXPLICACION) return true;
  // Una lista corta tambien explica, aunque no llegue al largo.
  return /\n\s*([•\-*]|\d[.)])/.test(t);
}

/**
 * Lee el mensaje del cliente posterior a la respuesta del equipo.
 * Devuelve 'sirvio' | 'no_sirvio' | 'neutro'.
 */
export function leerConfirmacion(mensaje) {
  const t = norm(mensaje);
  if (!t) return 'neutro';
  if (NO_ENTENDIO.some((re) => re.test(t))) return 'no_sirvio';
  if (SOLO_CORTESIA.some((re) => re.test(t))) return 'neutro';
  if (ENTENDIO.some((re) => re.test(t))) return 'sirvio';
  // Volvio a escribir algo largo despues de una explicacion: no la cerro.
  if (t.length > 60 && t.includes('?')) return 'no_sirvio';
  return 'neutro';
}

/**
 * Cierra el ciclo de tres mensajes.
 *
 * `pares` son los que `aprendizaje.js` ya guardo esperando veredicto. Cuando la
 * conversacion vuelve a estar en `Responded`, este modulo lee ese mensaje nuevo
 * y le pone el voto al par.
 *
 * @returns {{votados: number, sirvieron: number}}
 */
export function votar(conversaciones, estado, { guardarVoto } = {}) {
  const esperando = estado.esperandoVeredicto || (estado.esperandoVeredicto = {});
  let votados = 0;
  let sirvieron = 0;

  for (const c of conversaciones) {
    const par = esperando[c.id];
    if (!par) continue;
    // Todavia no volvio a hablar el cliente.
    if (c.conversation_status__s !== 'Responded') continue;
    // Es el mismo mensaje que ya teniamos: no hay nada nuevo.
    if (String(c.message_time__s) === String(par.cuandoRespuesta)) continue;

    const voto = leerConfirmacion(c.last_message__s);
    if (voto !== 'neutro') {
      guardarVoto?.({
        ...par,
        voto,
        confirmacion: String(c.last_message__s || '').slice(0, 300),
        cuandoVoto: c.message_time__s,
      });
      votados++;
      if (voto === 'sirvio') sirvieron++;
    }
    delete esperando[c.id];
  }
  return { votados, sirvieron };
}

/** Anota un par recien cerrado para esperarle el veredicto del cliente. */
export function esperarVeredicto(estado, par, conv) {
  if (!esExplicacion(par.respuesta)) return false;
  const esperando = estado.esperandoVeredicto || (estado.esperandoVeredicto = {});
  esperando[conv.id] = {
    conversacion: conv.id,
    cliente: par.cliente,
    respuesta: par.respuesta,
    respondio: par.respondio,
    tema: par.tema,
    cuandoRespuesta: conv.message_time__s,
  };
  return true;
}

/** Saca de la espera lo que quedo colgado, para que el estado no crezca solo. */
export function podarVeredictos(estado, dias = 5) {
  const limite = Date.now() - dias * 86400 * 1000;
  for (const [id, p] of Object.entries(estado.esperandoVeredicto || {})) {
    if (new Date(p.cuandoRespuesta).getTime() < limite) delete estado.esperandoVeredicto[id];
  }
}
