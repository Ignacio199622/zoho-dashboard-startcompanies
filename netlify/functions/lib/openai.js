// Cerebro con OpenAI. Misma firma que gemini.js, asi que el resto del agente
// no cambia: se elige con PROVEEDOR en config.js.
//
// Usa structured outputs, que exige un JSON Schema estricto: todas las
// propiedades listadas en required y additionalProperties en false.
import { env, exigir } from './entorno.js';

/** Convierte el esquema del agente al dialecto estricto de OpenAI. */
export function aEsquemaEstricto(n) {
  if (n.type === 'object') {
    const props = Object.fromEntries(
      Object.entries(n.properties || {}).map(([k, v]) => [k, aEsquemaEstricto(v)])
    );
    return {
      type: 'object',
      properties: props,
      // strict exige que TODAS las propiedades esten en required.
      required: Object.keys(props),
      additionalProperties: false,
    };
  }
  if (n.type === 'array') return { type: 'array', items: aEsquemaEstricto(n.items) };
  const base = { type: n.type };
  if (n.description) base.description = n.description;
  if (n.enum) base.enum = n.enum;
  return base;
}

export async function generar({ modelo, instrucciones, contenido, esquema, maxTokens = 8000 }) {
  exigir('OPENAI_API_KEY');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelo,
      messages: [
        { role: 'system', content: instrucciones },
        { role: 'user', content: contenido },
      ],
      max_completion_tokens: maxTokens,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'salida', strict: true, schema: aEsquemaEstricto(esquema) },
      },
    }),
  });

  const j = await r.json();
  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);

  const msg = j.choices?.[0];
  if (!msg) throw new Error(`OpenAI sin respuesta: ${JSON.stringify(j).slice(0, 200)}`);
  // Si corta por limite de tokens el JSON queda a la mitad: es un fallo.
  if (msg.finish_reason && !['stop', null].includes(msg.finish_reason)) {
    throw new Error(`OpenAI cortó la respuesta: ${msg.finish_reason}`);
  }
  const texto = msg.message?.content || '';
  if (!texto.trim()) throw new Error('OpenAI devolvió vacío');

  return {
    datos: JSON.parse(texto),
    uso: {
      entrada: j.usage?.prompt_tokens || 0,
      salida: j.usage?.completion_tokens || 0,
    },
  };
}
