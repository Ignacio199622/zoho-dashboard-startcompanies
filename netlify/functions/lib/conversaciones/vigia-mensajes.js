// Lo que dice la gente en los mensajes NUEVOS, para dos cosas (11-nov-2026):
//
// 1. IDIOMA: el que escribe en portugues y tiene Idioma vacio en la ficha recibe
//    la cadencia y los avisos en español (Will Oliveira, +49, brasilero:
//    "desativa essa porra dessa automação"). Se mira lo que ESCRIBE, no el +55:
//    hay hispanos viviendo en Brasil (misma regla que idioma-tratos-arreglar).
//
// 2. QUIERE SALIR: el boton "No me interesa / Não tenho interesse" ya apaga la
//    cadencia solo (bajas.js, match exacto). Lo que se escribe a mano ("sacame",
//    "desativa", "stop") NO se apaga solo a proposito — "quiero dar de BAJA mi LLC"
//    no es una baja — pero nadie se enteraba y la cadencia seguia. Esto AVISA en
//    Slack para que una persona lo frene; no apaga nada.
//
// Funciones puras: se prueban en scripts/test-vigia-mensajes.mjs.

const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/\p{Extended_Pictographic}/gu, ' ')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Palabras de portugues que NO existen (o casi no se usan) en español.
const PT = ['voce', 'voces', 'obrigado', 'obrigada', 'nao', 'tenho', 'quero', 'ola', 'bom dia', 'boa tarde',
  'boa noite', 'estou', 'preciso', 'essa', 'esse', 'isso', 'muito', 'tambem', 'agora', 'entao', 'gostaria',
  'duvida', 'posso', 'fazer', 'ainda', 'aqui', 'desativa', 'desativar', 'oi', 'tudo bem', 'valeu', 'beleza',
  'quanto custa', 'minha', 'meu', 'sim', 'vou', 'queria', 'saber', 'abrir uma', 'empresa nos', 'conta', 'pra'];
// Palabras que delatan español (si aparecen, no se decide portugues).
const ES = ['hola', 'quiero', 'tengo', 'gracias', 'usted', 'ustedes', 'necesito', 'estoy', 'cuanto', 'como', 'puedo',
  'buenas', 'buen dia', 'vos', 'esta', 'pero', 'muy', 'ahora', 'entonces', 'aca', 'mi', 'por favor', 'yo'];

const cuenta = (texto, lista) => {
  const t = ` ${norm(texto)} `;
  return lista.filter((p) => t.includes(` ${p} `)).length;
};

/** ¿El mensaje esta en portugues? Hacen falta 2 marcas PT y que gane a las de español. */
export function escribeEnPortugues(texto) {
  const pt = cuenta(texto, PT);
  const es = cuenta(texto, ES);
  return pt >= 2 && pt > es;
}

// Pedidos de salir escritos a mano, en los 3 idiomas. Se buscan como frase.
const SALIR = [
  // español
  'no me escriban', 'no me escribas', 'dejen de escribir', 'deja de escribir', 'dejen de mandar', 'deja de mandar',
  'no me manden', 'no me mandes', 'sacame', 'sáquenme', 'saquenme', 'borrame', 'borrenme', 'no quiero recibir',
  'no me interesa', 'no estoy interesado', 'no estoy interesada', 'basta de mensajes', 'dejen de molestar',
  'deja de molestar', 'no molesten', 'desuscribir', 'desuscribirme', 'apaguen', 'apaga esa', 'apaga esto',
  // portugues
  'desativa', 'desative', 'desativar', 'para de mandar', 'pare de mandar', 'parem de mandar', 'para de enviar',
  'pare de enviar', 'parem de enviar', 'nao quero mais', 'nao quero receber', 'nao tenho interesse', 'me tira',
  'me tirem', 'me remove', 'me remova', 'chega de mensagem', 'nao me mande', 'nao me mandem',
  // ingles
  'stop', 'unsubscribe', 'stop messaging', 'stop texting', 'remove me', 'not interested', 'leave me alone',
  'dont message', 'do not message', 'stop sending',
].map(norm);

// Lo que se parece pero NO es un pedido de salir (la LLC, el precio, una cuenta).
const NO_ES_SALIR = ['de baja mi llc', 'baja de la llc', 'dar de baja la', 'cerrar la llc', 'cerrar mi llc',
  'stop payment', 'bus stop', 'desativar a conta', 'desativar minha conta', 'nao para de', 'no para de'].map(norm);

/** ¿Pide que no le escribamos mas? (escrito a mano, no el boton) */
export function pideSalir(texto) {
  const t = ` ${norm(texto)} `;
  if (NO_ES_SALIR.some((p) => t.includes(` ${p} `))) return false;
  return SALIR.some((p) => t.includes(` ${p} `));
}
