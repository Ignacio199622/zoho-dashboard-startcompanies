// Memoria entre corridas: hasta donde leimos, a quien ya avisamos, y cuantas
// veces insistimos.
//
// Sin esto el agente reavisa lo mismo cada 15 minutos y el canal se vuelve ruido
// que nadie mira, que es exactamente como muere una alerta.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RAIZ } from './entorno.js';
import { HORAS_RECORDATORIO } from './config.js';

const DIR = join(RAIZ, 'estado');
const ARCHIVO = join(DIR, 'estado.json');

const VACIO = { ultimoCorte: null, avisadas: {} };

// En la maquina la memoria es un archivo. En Netlify no hay disco que sobreviva
// entre corridas: la funcion carga el estado de un blob antes de empezar, lo
// deja aca, y al terminar escribe lo que quedo. Mientras hay memoria puesta,
// leer() y guardar() no tocan el disco.
//
// Se hace asi, y no con una API asincronica, para no tener que meter await en
// cada llamador: quePasaCon() y marcar() se usan adentro de bucles y el cambio
// se derramaba por todo el agente.
let memoria = null;

/** La funcion de Netlify llama a esto con lo que venia guardado en el blob. */
export function usarMemoria(inicial) {
  memoria = { ...VACIO, ...(inicial || {}) };
}

/** Lo que hay que escribir de vuelta al blob cuando termina la corrida. */
export function contenido() {
  return memoria;
}

export function leer() {
  if (memoria) return memoria;
  try {
    return { ...VACIO, ...JSON.parse(readFileSync(ARCHIVO, 'utf8')) };
  } catch {
    return { ...VACIO };
  }
}

export function guardar(estado) {
  if (memoria) {
    memoria = estado;
    return;
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(ARCHIVO, JSON.stringify(estado, null, 2), 'utf8');
}

/**
 * Que corresponde hacer con esta conversacion:
 *
 *   'avisar'      nunca se aviso por este mensaje
 *   'recordar'    ya se aviso, sigue sin respuesta y toca insistir
 *   'callar'      ya se aviso y todavia no toca insistir, o ya se agoto la insistencia
 *
 * Si el cliente vuelve a escribir cambia `message_time` y el ciclo empieza de cero:
 * es un mensaje nuevo, no el mismo esperando.
 */
export function quePasaCon(estado, id, messageTime, ahora = new Date()) {
  const a = estado.avisadas[id];
  if (!a || a.messageTime !== messageTime) return { accion: 'avisar', numero: 0 };

  const hechos = a.recordatorios || 0;
  if (hechos >= HORAS_RECORDATORIO.length) return { accion: 'callar', numero: hechos };

  const horasDesdePrimero = (ahora - new Date(a.primerAviso)) / 3600000;
  if (horasDesdePrimero >= HORAS_RECORDATORIO[hechos]) {
    return { accion: 'recordar', numero: hechos + 1, horasDesdePrimero: Math.round(horasDesdePrimero) };
  }
  return { accion: 'callar', numero: hechos };
}

export function marcar(estado, id, messageTime, esRecordatorio, ahora = new Date()) {
  const a = estado.avisadas[id];
  if (!a || a.messageTime !== messageTime) {
    estado.avisadas[id] = {
      messageTime,
      primerAviso: ahora.toISOString(),
      ultimoAviso: ahora.toISOString(),
      recordatorios: 0,
    };
    return;
  }
  a.ultimoAviso = ahora.toISOString();
  if (esRecordatorio) a.recordatorios = (a.recordatorios || 0) + 1;
}

/** Tira lo viejo para que el archivo no crezca sin freno. */
export function podar(estado, dias = 7) {
  const limite = Date.now() - dias * 86400 * 1000;
  for (const [id, a] of Object.entries(estado.avisadas)) {
    if (new Date(a.ultimoAviso || a.primerAviso).getTime() < limite) delete estado.avisadas[id];
  }
}
