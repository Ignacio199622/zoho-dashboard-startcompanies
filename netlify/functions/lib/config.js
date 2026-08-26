// Parametria del agente de llamadas.

// Que modelo analiza las transcripciones.
//
// Hoy corre con Gemini porque la organizacion de Anthropic esta desactivada.
// Cuando se destrabe, cambiar PROVEEDOR a 'anthropic' y listo: el resto del
// agente no cambia.
export const PROVEEDOR = 'gemini'; // 'anthropic' | 'gemini'

export const MODELO_ANTHROPIC = 'claude-opus-5';
export const MODELO_GEMINI = 'gemini-3.1-pro-preview';

// Precio de lista por millon de tokens, para estimar el costo de cada tanda.
export const PRECIOS = {
  'claude-opus-5': { entrada: 5, salida: 25 },
  'gemini-3.1-pro-preview': { entrada: 1.25, salida: 10 },
};

// Cuanto texto de la transcripcion se manda. Una llamada de 50 minutos son
// ~20.000 caracteres, que entran completos sin problema.
export const MAX_CARACTERES_TRANSCRIPCION = 60000;

// Solo se analizan llamadas que parezcan de venta o seguimiento.
export const TITULOS_DE_VENTA = /consulta|asesor|llc|seguimiento|meeting|reuni/i;

// Y se descartan las de prueba.
export const PATRONES_PRUEBA = /prueba|probador|\btest\b|testeo|ejemplo/i;

// Una llamada de 3 minutos no tiene nada que extraer.
export const MINIMO_LINEAS_TRANSCRIPCION = 25;
