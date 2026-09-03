// Quien atendio la llamada, como persona de Zoho.
//
// EL HALLAZGO (medido el 2026-09-03 sobre las 8 llamadas de venta mas nuevas):
// las etiquetas de hablante de Fathom traen el NOMBRE COMPLETO y coinciden
// exacto con un usuario de Zoho en 8 de 8. O sea que el vendedor no hay que
// deducirlo: viene en los metadatos.
//
// OJO CON LA CONFUSION FACIL: la diarizacion de Fathom esta mal, en el sentido
// de que atribuye frases al hablante equivocado. Pero la LISTA de hablantes es
// correcta, y es lo unico que se necesita para saber quien atendio. Son dos
// cosas distintas y conviene no mezclarlas.
//
// Antes esto se le pedia al modelo, que lo sacaba del texto ("gracias
// Santiago"). Eso sigue de respaldo, pero ahora es el plan B: el plan A no
// gasta tokens, no se equivoca y no depende de que alguien diga el nombre.
import { USUARIOS, usuarioDesdeNombre } from './mapeos.js';

const NORM = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, '')
    .trim();

/** Los nombres que Fathom le puso a cada hablante de la reunion. */
export function hablantes(reunion) {
  if (!Array.isArray(reunion?.transcript)) return [];
  return [...new Set(reunion.transcript.map((t) => t.speaker?.display_name).filter(Boolean))];
}

/**
 * @returns {{id:string|null, nombre:string|null, motivo:string, fuente:string}}
 */
export function resolverVendedor(reunion, nombreSegunModelo) {
  const nombres = hablantes(reunion);

  // Los usuarios de Zoho que aparecen como hablantes. La cuenta generica
  // ("Administración Start Companies") esta marcada y no cuenta como persona.
  const internos = Object.entries(USUARIOS)
    .filter(([, u]) => !u.generico)
    .filter(([, u]) => nombres.some((n) => NORM(n) === NORM(u.nombre)));

  const venden = internos.filter(([, u]) => u.vende);

  if (venden.length === 1) {
    const [id, u] = venden[0];
    return { id, nombre: u.nombre, motivo: 'Fathom lo etiqueto como hablante', fuente: 'hablantes' };
  }

  if (venden.length > 1) {
    return {
      id: null,
      nombre: null,
      motivo: `hablaron ${venden.map(([, u]) => u.nombre).join(' y ')}: no se puede decir cual atendio`,
      fuente: 'hablantes',
    };
  }

  // Hay gente de la casa en la llamada, pero ninguno vende. Pasa en soporte y
  // en seguimientos de filing: no es un error, es que no hubo vendedor.
  if (internos.length) {
    return {
      id: null,
      nombre: null,
      motivo: `en la llamada estuvo ${internos.map(([, u]) => u.nombre).join(', ')}, que no atiende ventas`,
      fuente: 'hablantes',
    };
  }

  // Plan B: lo que dedujo el modelo del texto de la llamada.
  const porTexto = usuarioDesdeNombre(nombreSegunModelo);
  return {
    ...porTexto,
    nombre: porTexto.id ? USUARIOS[porTexto.id]?.nombre : null,
    motivo: porTexto.id ? `${porTexto.motivo} (deducido del texto)` : porTexto.motivo,
    fuente: 'texto',
  };
}
