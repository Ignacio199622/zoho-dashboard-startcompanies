// Lleva el origen del cliente al trato, que es donde está la plata.
//
// POR QUE HACE FALTA (medido el 2026-09-05):
// El canal y el importe viven en módulos distintos y ninguno tiene los dos:
//   canal   -> lead 26% · cliente 1% · trato 0%
//   importe -> solo el trato, 80%
// Sin una fila que tenga las dos cosas no hay CAC por canal ni churn por
// origen. Esto arma esa fila.
//
// EL CLIENTE NO VIENE DEL LEAD. Se verificó uno por uno: de 998 clientes con
// mail, CERO tienen un lead con el mismo mail. El portal crea Cuenta + Trato +
// Contacto directo, sin pasar por Posibles clientes. Por eso el origen fino
// (anuncio, campaña) no se puede recuperar hacia atrás: para esos clientes
// nunca existió. Lo que sí tienen es `Lead_Source`, en el 52%.
//
// Se copia del cliente al trato, y del lead al cliente cuando el mail coincide
// (raro, pero cuando pasa es el dato bueno).

// Lo que se traslada. Mismo nombre de API en los tres módulos.
// 18-sep-2026 (normalizacion de origen): Lead_Source = canal, Landing_Origen = pagina,
// Calendario = calendario de Cal, Canal_de_contacto = por donde se comunico. Los cuatro
// viajan tal cual, sin interpretar: cada campo se llena una vez en el lead y de ahi se copia.
export const CAMPOS = [
  'Lead_Source',
  'Landing_Origen',
  'Calendario',
  'Canal_de_contacto',
  'leadchain0__Social_Lead_ID',
  'fbclid',
  'fbc',
  'creativeId',
  'Url_del_anuncio',
  'Preview_del_anuncio',
  'Anuncio',
  'Conjunto_de_anuncios',
  'Campa_a_Meta',
  'utm_campaign',
  'utm_content',
  'utm_source',
  'utm_medium',
  'utm_term',
  'utm_id',
  // 4-oct-2026: cada vez que volvio (lo escribe convertCal). El origen de arriba es el de la primera vez.
  'Historial_de_visitas',
  'Visitas',
];

/** Los campos que hay que pedirle a cada módulo. */
export const CAMPOS_CONTACTO = ['id', 'Full_Name', 'Email', 'Mobile', 'Phone', 'Tipo_de_Contacto', ...CAMPOS].join(',');
export const CAMPOS_TRATO = ['id', 'Deal_Name', 'Amount', 'Stage', 'Created_Time', 'Contact_Name', 'Account_Name', 'Layout', 'Fuente_del_cliente', 'Partner', ...CAMPOS].join(',');

const vacio = (v) => v === null || v === undefined || String(v).trim() === '' || (Array.isArray(v) && !v.length);
// Fuentes que dejan las integraciones y no son un canal: para copiar, cuentan como vacias.
const transitoria = (v) => /^WHATSAPP|^WhatsApp - |wwebjs|^Chatbot|Bot$|^TimelinesAI|^Landing Page$|^Web Organic$/.test(String(v || ''));
// Un canal que dice "no sabemos": cede ante cualquier señal firme.
const debil = (v) => vacio(v) || transitoria(v) || sinDato(v);
// 28-sep-2026 (Ignacio): una Fuente que dice "no sabemos" NO se hereda del contacto al trato.
// Si se copiaba, el trato nacia "sabiendo" y Cami nunca tenia que preguntarle al vendedor.
const sinDato = (v) => v === 'Sin dato histórico' || v === 'WhatsApp (no sabemos)' || v === 'No lo sé, completo después' || v === 'Sin origen de fuente';

/**
 * La venta la trajo un socio: el trato tiene el lookup Socio cargado, o su contacto es de
 * Tipo de Contacto = Partner (las gestorías, que cierran a nombre de sus clientes). Medido el
 * 20-sep-2026: 48 tratos así habían quedado en "Sin dato histórico" / "WhatsApp (no sabemos)".
 * Solo cuando el canal del trato es débil: un Meta Ads con socio cargado no se pisa.
 */
export function canalDeSocio(trato, cliente) {
  if (!debil(trato.Lead_Source)) return null;
  if (trato.Partner) return 'Partner';
  if (cliente?.Tipo_de_Contacto === 'Partner' && vacio(trato.Landing_Origen)) return 'Partner';
  return null;
}

/**
 * Qué le falta al trato que el cliente sí tiene.
 * Nunca pisa un campo con valor: si el trato ya trae algo, gana el trato.
 *
 * @returns {{cambios: object, detalle: string[]}}
 */
export function loQueFaltaAlTrato(trato, cliente) {
  const cambios = {};
  const detalle = [];
  if (!cliente) return { cambios, detalle };

  for (const c of CAMPOS) {
    if (c === 'Lead_Source' && (transitoria(cliente[c]) || sinDato(cliente[c]) || !(vacio(trato[c]) || transitoria(trato[c])))) continue;
    if (!vacio(cliente[c]) && vacio(trato[c])) {
      cambios[c] = cliente[c];
      detalle.push(c.replace('leadchain0__', ''));
    }
  }

  // Fuente_del_cliente (texto libre) se sigue completando por compatibilidad: se retira en la fase 5.
  if (!vacio(cliente.Lead_Source) && !transitoria(cliente.Lead_Source) && !sinDato(cliente.Lead_Source) && vacio(trato.Fuente_del_cliente)) {
    cambios.Fuente_del_cliente = String(cliente.Lead_Source).slice(0, 255);
    detalle.push('Fuente_del_cliente');
  }

  return { cambios, detalle };
}

/** Índices por mail y por teléfono, para cruzar sin depender de la conversión. */
export function indexar(registros) {
  const norm = (s) => String(s || '').toLowerCase().trim();
  const tel = (s) => {
    const d = String(s || '').replace(/\D/g, '');
    return d.length >= 8 ? d.slice(-10) : null;
  };
  const porMail = new Map();
  const porTel = new Map();
  for (const r of registros) {
    if (r.Email) porMail.set(norm(r.Email), r);
    for (const k of [tel(r.Mobile), tel(r.Phone)]) if (k && !porTel.has(k)) porTel.set(k, r);
  }
  return {
    buscar(x) {
      if (x.Email && porMail.has(norm(x.Email))) return porMail.get(norm(x.Email));
      for (const k of [tel(x.Mobile), tel(x.Phone)]) if (k && porTel.has(k)) return porTel.get(k);
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Atar el trato huerfano a su cliente.
//
// 164 tratos (15%) no cuelgan de ningun cliente, y sin ese vinculo no hay a
// quien copiarle el origen: son los que dejan la cadena cortada.
//
// LOS 164 TIENEN CUENTA. Ese es el atajo: no hace falta adivinar por el nombre
// del trato, alcanza con mirar quien esta en la cuenta.
//   93 -> la cuenta tiene UN solo contacto: ese es, sin ambiguedad
//   18 -> la cuenta tiene varios: NO se toca, hay que elegir a mano
//   53 -> la cuenta no tiene a nadie: no hay nada que atar
// Solo se escriben los 93. Con dos candidatos la respuesta correcta es no
// elegir: un trato atado al socio equivocado es peor que uno sin atar.

export const CAMPOS_CUENTA_CONTACTO = 'id,Full_Name,Email,Account_Name';

/** Contactos agrupados por cuenta. */
export function contactosPorCuenta(contactos) {
  const m = new Map();
  for (const c of contactos) {
    const k = c.Account_Name?.id;
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(c);
  }
  return m;
}

/**
 * A quien hay que atar este trato, si la respuesta es una sola.
 * @returns {{contacto: object}|{motivo: string}}
 */
export function clienteDelTratoHuerfano(trato, porCuenta) {
  if (trato.Contact_Name?.id) return { motivo: 'ya tiene cliente' };
  const cuenta = trato.Account_Name?.id;
  if (!cuenta) return { motivo: 'sin cuenta' };
  const cs = porCuenta.get(cuenta) || [];
  if (cs.length === 1) return { contacto: cs[0] };
  if (cs.length > 1) return { motivo: `la cuenta tiene ${cs.length} contactos` };
  return { motivo: 'la cuenta no tiene contactos' };
}

/**
 * Segunda via para el trato huerfano: mirar los HERMANOS.
 *
 * Si la cuenta no tiene ningun contacto cargado, todavia queda una pista: otro
 * trato de la MISMA cuenta que si tenga cliente. Pasa con quien abre varias
 * LLC (DPM Diving Gili Air, Nusa Penida, Gili T y QUMA HOTEL son todas de la
 * misma persona): una quedo bien atada y las otras sueltas.
 *
 * SE EXIGE UNANIMIDAD. Si dos hermanos apuntan a clientes distintos, la cuenta
 * tiene socios y elegir uno seria adivinar. Ahi no se toca.
 *
 * @param tratosPorCuenta Map de id de cuenta -> tratos de esa cuenta
 */
export function clientePorHermanos(trato, tratosPorCuenta) {
  if (trato.Contact_Name?.id) return { motivo: 'ya tiene cliente' };
  const cuenta = trato.Account_Name?.id;
  if (!cuenta) return { motivo: 'sin cuenta' };
  const hermanos = (tratosPorCuenta.get(cuenta) || []).filter((d) => d.id !== trato.id && d.Contact_Name?.id);
  if (!hermanos.length) return { motivo: 'ningun hermano tiene cliente' };
  const ids = [...new Set(hermanos.map((d) => d.Contact_Name.id))];
  if (ids.length > 1) return { motivo: `los hermanos apuntan a ${ids.length} clientes distintos` };
  return { contacto: { id: ids[0], Full_Name: hermanos[0].Contact_Name.name } };
}

/** Tratos agrupados por cuenta. */
export function tratosPorCuenta(tratos) {
  const m = new Map();
  for (const d of tratos) {
    const k = d.Account_Name?.id;
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(d);
  }
  return m;
}

/**
 * Ultimo recurso: el canal de la LLC.
 *
 * La LLC es lo unico que sobrevive a las renovaciones. El trato de apertura se
 * cierra y el cliente puede no tener origen, pero la renovacion del año que
 * viene cuelga de la misma LLC. Si el canal esta ahi, la renovacion nace
 * atribuida y se puede medir LTV y churn por canal, no solo la primera venta.
 *
 * Va DESPUES del cliente a proposito: el cliente es mas especifico (una persona
 * vino por un canal), la LLC es el contenedor.
 */
export function canalDeLaCuenta(trato, cuentas) {
  // 18-sep-2026: el canal de la LLC vive en `Fuente` (antes en Landing_Origen).
  if (!vacio(trato.Lead_Source) && !transitoria(trato.Lead_Source)) return null;
  const a = trato.Account_Name?.id ? cuentas.get(trato.Account_Name.id) : null;
  const v = a?.Fuente;
  return v && String(v).trim() && !sinDato(String(v)) ? String(v) : null;
}
