import { env } from './entorno.js';

// Parametria del agente de llamadas.

// Que modelo analiza las transcripciones.
//
// Hoy corre con Gemini porque la organizacion de Anthropic esta desactivada.
// Cuando se destrabe, cambiar PROVEEDOR a 'anthropic' y listo: el resto del
// agente no cambia.
export const PROVEEDOR = env.PROVEEDOR || 'gemini'; // 'anthropic' | 'gemini'

// El extractor de TAREAS elige aparte: el agente de llamadas sigue con lo suyo
// y cambiar uno no rompe el otro.
export const PROVEEDOR_TAREAS = env.PROVEEDOR_TAREAS || 'gemini'; // 'gemini' | 'openai'

// Y el Coach de Ventas elige aparte tambien. Tiene que ser asi: el extractor de
// tareas quedo apuntando a OpenAI y esa cuenta se quedo sin credito, lo que
// habria dejado al coach caido por algo que no es suyo.
export const PROVEEDOR_COACH = env.PROVEEDOR_COACH || 'gemini'; // 'gemini' | 'openai'

export const MODELO_ANTHROPIC = 'claude-opus-5';
export const MODELO_GEMINI = 'gemini-3.1-pro-preview';
// El nombre exacto se confirma contra /v1/models cuando entre la key.
export const MODELO_OPENAI = env.OPENAI_MODEL || 'gpt-5';

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

// El Coach usa un filtro mas estricto: los tipos de evento reales de Cal.com.
// TITULOS_DE_VENTA deja pasar "Impromptu Google Meet Meeting" por la palabra
// "meeting", y de las ultimas 60 reuniones 32 eran eso: internas del equipo.
// Coachearlas seria gastar el modelo y empapelar el canal con informes vacios.
export const TITULOS_DE_CLIENTE = /consulta gratuita|asesor[ií]a estrat|consulta de seguimiento|crea tu llc|30 min meeting/i;

// Y se descartan las de prueba.
export const PATRONES_PRUEBA = /prueba|probador|\btest\b|testeo|ejemplo/i;

// Una llamada de 3 minutos no tiene nada que extraer.
export const MINIMO_LINEAS_TRANSCRIPCION = 25;
