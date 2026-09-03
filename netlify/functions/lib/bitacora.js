// Registro de lo que hace el agente en cada corrida.
//
// Sin esto, un agente que corre solo falla en silencio: nadie se entera hasta
// que alguien nota que hace tres semanas no carga nada. La bitacora guarda que
// paso en cada corrida, con el detalle de cada error, para que se pueda mirar
// despues sin tener que reproducir el problema.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(RAIZ, 'salidas');
const ARCHIVO = join(DIR, 'bitacora.json');
const MAX_CORRIDAS = 200;

const leer = () => {
  if (!existsSync(ARCHIVO)) return [];
  try {
    return JSON.parse(readFileSync(ARCHIVO, 'utf8'));
  } catch {
    return [];
  }
};

export function nuevaCorrida(disparador = 'manual') {
  const inicio = new Date();
  const errores = [];
  const avisos = [];
  const pasos = [];
  let procesadas = 0;
  let escritas = 0;

  return {
    /** Un paso que salio bien. */
    paso(nombre, detalle = '') {
      pasos.push({ nombre, detalle, cuando: new Date().toISOString() });
    },
    /** Algo fallo. Se guarda el contexto para poder entenderlo despues. */
    error(donde, e, contexto = {}) {
      errores.push({
        donde,
        mensaje: String(e?.message || e).slice(0, 300),
        contexto,
        cuando: new Date().toISOString(),
      });
    },
    /** Algo raro que no rompe pero conviene mirar. */
    aviso(texto, contexto = {}) {
      avisos.push({ texto, contexto, cuando: new Date().toISOString() });
    },
    conto(p, e = 0) {
      procesadas += p;
      escritas += e;
    },
    /** Cierra la corrida y la guarda. Devuelve el registro. */
    cerrar(extra = {}) {
      const fin = new Date();
      const reg = {
        id: inicio.toISOString(),
        disparador,
        inicio: inicio.toISOString(),
        fin: fin.toISOString(),
        segundos: Math.round((fin - inicio) / 1000),
        procesadas,
        escritas,
        errores,
        avisos,
        pasos,
        estado: errores.length === 0 ? 'ok' : errores.length >= procesadas && procesadas > 0 ? 'fallo' : 'parcial',
        ...extra,
      };
      mkdirSync(DIR, { recursive: true });
      const todas = leer();
      todas.unshift(reg);
      writeFileSync(ARCHIVO, JSON.stringify(todas.slice(0, MAX_CORRIDAS), null, 1), 'utf8');
      return reg;
    },
  };
}

export const corridas = () => leer();

/** Lo que hay que mirar: si la ultima fallo, o si hace mucho que no corre. */
export function estado() {
  const todas = leer();
  if (!todas.length) return { estado: 'sin datos', mensaje: 'El agente todavia no corrio nunca' };

  const ultima = todas[0];
  const horas = (Date.now() - new Date(ultima.fin).getTime()) / 3600000;
  const problemas = [];

  if (ultima.estado === 'fallo') problemas.push('la ultima corrida fallo entera');
  else if (ultima.estado === 'parcial') problemas.push(`la ultima corrida tuvo ${ultima.errores.length} errores`);
  if (horas > 26) problemas.push(`hace ${Math.round(horas)}h que no corre`);

  // Un error que se repite en varias corridas no es un tropiezo, es algo roto.
  const recientes = todas.slice(0, 5).flatMap((c) => c.errores.map((e) => e.mensaje.slice(0, 60)));
  const repetidos = {};
  for (const m of recientes) repetidos[m] = (repetidos[m] || 0) + 1;
  for (const [m, n] of Object.entries(repetidos)) {
    if (n >= 3) problemas.push(`error repetido ${n} veces: ${m}`);
  }

  return {
    estado: problemas.length ? 'atencion' : 'ok',
    problemas,
    ultima: { cuando: ultima.fin, procesadas: ultima.procesadas, escritas: ultima.escritas, errores: ultima.errores.length },
    total: todas.length,
  };
}
