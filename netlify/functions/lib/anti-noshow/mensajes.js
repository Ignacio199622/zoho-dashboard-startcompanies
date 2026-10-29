// Plantillas de Fase 0. Texto fijo con datos reales del CRM.
// Cuando se prenda el cerebro (Fase 2), estas plantillas pasan a ser el piso:
// el modelo puede adaptar el texto pero no puede inventar horarios ni links.
import { formatearEn } from './tz.js';

const primerNombre = (n) => (n || '').trim().split(/\s+/)[0] || 'Hola';

// El titulo de Cal.com viene como "<tipo> entre Start Companies ... y <cliente>",
// a veces con un emoji roto adelante. Nos quedamos con el tipo de reunion.
export function tipoDeReunion(titulo = '') {
  const limpio = titulo.replace(/[^\p{L}\p{N}\s\-–—,.]/gu, '').trim();
  const corte = limpio.split(/\s+entre\s+/i)[0];
  return (corte || 'la reunion').trim();
}

// Bajar a minusculas rompe las siglas del negocio ("tu llc"). Se preservan
// los tokens que vienen enteros en mayusculas.
const SIGLAS = /^(LLC|EIN|ITIN|USA|EEUU|IRS)$/i;
function enMinuscula(frase) {
  return frase
    .split(' ')
    .map((p) => {
      const limpio = p.replace(/[^\p{L}]/gu, '');
      if (SIGLAS.test(limpio)) return p.toUpperCase();
      return p === p.toUpperCase() && limpio.length > 1 ? p : p.toLowerCase();
    })
    .join(' ');
}

export function redactar({ tipo, nombre, inicio, tzCliente, venue, tituloEvento }) {
  const n = primerNombre(nombre);
  const cuando = formatearEn(inicio, tzCliente) || inicio.toISOString().slice(0, 16);
  const que = tipoDeReunion(tituloEvento);
  const link = venue ? `\n\nLink: ${venue}` : '';

  if (tipo === 'recordatorio') {
    return (
      `Hola ${n}, te escribo de Start Companies.\n\n` +
      `Te queda agendada tu ${enMinuscula(que)} para mañana ${cuando} (tu hora).${link}\n\n` +
      `¿Te sigue quedando bien ese horario? Si necesitas moverlo, decime y lo cambiamos sin problema.`
    );
  }

  if (tipo === 'confirmacion') {
    return (
      `Hola ${n}, tu reunion con Start Companies es hoy ${cuando} (tu hora).${link}\n\n` +
      `Con el celular alcanza, no hace falta que prepares nada. Te espero.`
    );
  }

  if (tipo === 'rescate') {
    return (
      `Hola ${n}, te esperamos en la reunion de hoy y no pudimos conectarnos.\n\n` +
      `No hay problema, se reagenda. ¿Que dia te queda comodo esta semana?`
    );
  }

  throw new Error(`Tipo de mensaje desconocido: ${tipo}`);
}
