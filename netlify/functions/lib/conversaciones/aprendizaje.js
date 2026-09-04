// Aprender de como contesta el equipo de verdad.
//
// El CRM guarda un solo mensaje por conversacion, el ultimo, asi que el par
// "el cliente pregunto esto / le contestaron aquello" no existe en ningun lado.
// Pero el agente pasa cada 15 minutos: ve el mensaje del cliente cuando la
// conversacion esta en "Responded", y en una pasada posterior ve la respuesta
// del equipo cuando paso a "Replied". Con eso arma el par el mismo.
//
// Esos pares se le muestran al modelo como ejemplos de tono cuando escribe un
// borrador nuevo. No se reentrena nada: es el equipo enseñandole como habla.
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RAIZ } from './entorno.js';

const DIR = join(RAIZ, 'aprendizaje');
const ARCHIVO = join(DIR, 'pares.jsonl');

// Cuanto puede tardar la respuesta para seguir contando como respuesta a ESE
// mensaje. Mas alla de un dia lo mas probable es que sea otra conversacion.
const HORAS_MAX = 24;

// Igual que en estado.js: en la maquina esto es un .jsonl y en Netlify no hay
// disco entre corridas, asi que la funcion carga los pares del blob antes de
// empezar y escribe los nuevos al final. Con memoria puesta no se toca disco.
let memoria = null;

/** La funcion de Netlify llama a esto con los pares que venian del blob. */
export function usarMemoria(pares) {
  memoria = [...(pares || [])];
}

/** Los pares que hay que escribir de vuelta al blob. */
export function contenido() {
  return memoria;
}

export function leerPares() {
  if (memoria) return memoria;
  try {
    return readFileSync(ARCHIVO, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function guardarPar(par) {
  if (memoria) {
    memoria.push(par);
    return;
  }
  mkdirSync(DIR, { recursive: true });
  appendFileSync(ARCHIVO, JSON.stringify(par) + '\n', 'utf8');
}

/**
 * Recorre las conversaciones de esta pasada buscando cuales de las que estaban
 * esperando ya fueron contestadas, y guarda el par.
 *
 * Devuelve cuantos pares nuevos aprendio.
 */
export function capturar(conversaciones, estado, ahora = new Date()) {
  const pendientes = estado.esperandoRespuesta || (estado.esperandoRespuesta = {});
  let nuevos = 0;

  for (const c of conversaciones) {
    const guardado = pendientes[c.id];
    if (!guardado) continue;

    // Sigue esperando: nada que aprender todavia.
    if (c.conversation_status__s !== 'Replied') continue;

    const quien = c.replied_by__s?.name;
    const horas = (new Date(c.message_time__s) - new Date(guardado.cuando)) / 3600000;

    // Se descarta lo que no sirve como ejemplo:
    //  - sin autor: fue una automatizacion, no una persona
    //  - "Start Companies Staff": cuenta compartida, puede ser un envio masivo
    //  - fuera de ventana: probablemente conteste a otra cosa
    //  - respuesta vacia o de una palabra: no enseña nada
    const util =
      quien &&
      quien !== 'Start Companies Staff' &&
      horas >= 0 &&
      horas <= HORAS_MAX &&
      String(c.last_message__s || '').trim().length > 25;

    if (util) {
      guardarPar({
        cuando: ahora.toISOString(),
        conversacion: c.id,
        tema: guardado.tema,
        categoria: guardado.categoria,
        cliente: guardado.mensaje,
        respuesta: c.last_message__s,
        respondio: quien,
        horasQueTardaron: Math.round(horas * 10) / 10,
      });
      nuevos++;
    }
    delete pendientes[c.id];
  }
  return nuevos;
}

/** Anota que esta conversacion quedo esperando, para poder cerrar el par despues. */
export function anotarPendiente(estado, conv) {
  const pendientes = estado.esperandoRespuesta || (estado.esperandoRespuesta = {});
  pendientes[conv.id] = {
    cuando: conv.message_time__s,
    mensaje: String(conv.last_message__s || '').slice(0, 500),
    tema: conv.clase?.tema || null,
    categoria: conv.clase?.categoria || null,
    // Estos dos son para el panorama de cada 2 horas: sin ellos la lista sale
    // con el id de la conversacion y el mensaje crudo, que no se lee.
    quien: conv.ficha?.Full_Name || conv.mobile_number__s || null,
    resumen: conv.clase?.resumen || null,
  };
}

/** Saca de la lista lo que quedo colgado hace mucho, para que no crezca sin freno. */
export function podarPendientes(estado, dias = 3) {
  const limite = Date.now() - dias * 86400 * 1000;
  for (const [id, p] of Object.entries(estado.esperandoRespuesta || {})) {
    if (new Date(p.cuando).getTime() < limite) delete estado.esperandoRespuesta[id];
  }
}

/**
 * Los ejemplos que se le muestran al modelo: hasta 2 por tema, los mas nuevos.
 * Se limita a proposito. Con muchos ejemplos el modelo empieza a copiar el
 * contenido y no el tono, y termina contestando lo que contesto otro caso.
 */
export function ejemplos({ porTema = 2, tope = 12 } = {}) {
  const pares = leerPares();
  if (!pares.length) return [];
  const porClave = {};
  for (const p of pares) (porClave[p.tema || 'cx'] ||= []).push(p);
  const salida = [];
  for (const lista of Object.values(porClave)) {
    salida.push(...lista.slice(-porTema));
  }
  return salida.slice(-tope);
}

/** El bloque de texto que se le agrega al prompt. Vacio si todavia no hay nada. */
export function bloqueDeEjemplos() {
  const es = ejemplos();
  if (!es.length) return '';
  const cuerpo = es
    .map(
      (e) =>
        `Cliente: ${String(e.cliente).slice(0, 200)}\n${e.respondio} contesto: ${String(e.respuesta).slice(0, 300)}`
    )
    .join('\n\n');
  return `

ASI CONTESTA EL EQUIPO DE VERDAD. Son respuestas reales de los ultimos dias, tomadas del
CRM. Usalas para calcar el TONO y el largo, nunca el contenido: cada cliente pregunta otra
cosa. Si en los ejemplos son mas secos o mas informales que vos, escribi como ellos.

${cuerpo}`;
}
