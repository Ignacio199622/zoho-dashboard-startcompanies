// Elige el modelo segun PROVEEDOR y devuelve siempre la misma forma.
// Existe para que tareas.js no sepa con quien esta hablando.
import { PROVEEDOR_TAREAS, MODELO_GEMINI, MODELO_OPENAI } from './config.js';

export function modeloActual(proveedor = PROVEEDOR_TAREAS) {
  return proveedor === 'openai' ? MODELO_OPENAI : MODELO_GEMINI;
}

/**
 * `proveedor` va explicito cuando quien llama no es el extractor de tareas.
 * Sin eso, el coach heredaba PROVEEDOR_TAREAS y se caia con el 429 de OpenAI.
 */
export async function pensar({ proveedor = PROVEEDOR_TAREAS, ...opciones }) {
  const modelo = modeloActual(proveedor);
  if (proveedor === 'openai') {
    const { generar } = await import('./openai.js');
    return generar({ ...opciones, modelo });
  }
  const { generar } = await import('./gemini.js');
  return generar({ ...opciones, modelo });
}
