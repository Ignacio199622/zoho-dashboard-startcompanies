// Cerebro alternativo: Gemini.
//
// Existe porque la cuenta de Anthropic quedó desactivada y no queríamos que el
// agente dependiera de destrabarla. Cuando la cuenta vuelva, se cambia
// PROVEEDOR en config.js y esto queda de respaldo.
//
// La key sale de la configuración de los MCP que ya estaban instalados en la
// máquina, así que no hubo que pedir nada nuevo.
import { readFileSync } from 'node:fs';
import { env } from './entorno.js';

const CONFIG_CLAUDE = 'C:/Users/josei/.claude.json';

export function apiKey() {
  // En Netlify viene por variable de entorno. En la maquina, si no esta en el
  // .env, se cae a la configuracion de los MCP que ya la tenia.
  if (env.GEMINI_API_KEY) return env.GEMINI_API_KEY;
  try {
    const j = JSON.parse(readFileSync(CONFIG_CLAUDE, 'utf8'));
    const k =
      j.mcpServers?.gemini?.env?.GEMINI_API_KEY ||
      j.mcpServers?.veo?.env?.GEMINI_API_KEY ||
      j.mcpServers?.['nano-banana']?.env?.GEMINI_API_KEY;
    if (k) return k;
  } catch {}
  throw new Error('Falta GEMINI_API_KEY');
}

/**
 * El esquema de Gemini es OpenAPI, no JSON Schema: no acepta `type: [a, b]`
 * ni `additionalProperties`, y los opcionales se marcan con `nullable`.
 */
export function aEsquemaGemini(esquemaJsonSchema) {
  const conv = (n) => {
    // `type: ['object', 'null']` se resuelve sacando el null y convirtiendo el
    // tipo que queda. Antes esta rama cortaba antes que las de object y array,
    // asi que un objeto opcional perdia sus `properties` y un enum opcional
    // perdia sus valores: Gemini recibia un OBJECT vacio y contestaba null
    // siempre. Le pasaba a `mensaje` del coach y a `estructura` del extractor.
    const nulo = Array.isArray(n.type) && n.type.includes('null');
    const tipo = Array.isArray(n.type) ? n.type.find((t) => t !== 'null') : n.type;
    const marca = (x) => (nulo ? { ...x, nullable: true } : x);

    if (tipo === 'object') {
      return marca({
        type: 'OBJECT',
        description: n.description,
        properties: Object.fromEntries(Object.entries(n.properties || {}).map(([k, v]) => [k, conv(v)])),
        required: n.required || [],
      });
    }
    if (tipo === 'array') return marca({ type: 'ARRAY', items: conv(n.items), description: n.description });

    const base = { type: String(tipo).toUpperCase(), description: n.description };
    if (n.enum) base.enum = n.enum.filter((e) => e !== null);
    return marca(base);
  };
  return conv(esquemaJsonSchema);
}

export async function generar({ modelo, instrucciones, contenido, esquema, maxTokens = 4000 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey()}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: instrucciones }] },
      contents: [{ role: 'user', parts: [{ text: contenido }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: aEsquemaGemini(esquema),
        maxOutputTokens: maxTokens,
      },
    }),
  });

  const j = await r.json();
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);

  const cand = j.candidates?.[0];
  if (!cand) throw new Error(`Gemini sin candidatos: ${JSON.stringify(j).slice(0, 200)}`);
  // MAX_TOKENS deja el JSON cortado a la mitad: es un fallo, no un resultado.
  if (cand.finishReason && cand.finishReason !== 'STOP') {
    throw new Error(`Gemini corto la respuesta: ${cand.finishReason}`);
  }

  const texto = (cand.content?.parts || []).map((p) => p.text || '').join('');
  if (!texto.trim()) throw new Error('Gemini devolvió vacío');

  return {
    datos: JSON.parse(texto),
    uso: {
      entrada: j.usageMetadata?.promptTokenCount || 0,
      salida: j.usageMetadata?.candidatesTokenCount || 0,
    },
  };
}
