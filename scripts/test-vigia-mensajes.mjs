// node scripts/test-vigia-mensajes.mjs — sin red.
import assert from 'node:assert/strict';
import { escribeEnPortugues, pideSalir } from '../netlify/functions/lib/conversaciones/vigia-mensajes.js';

let ok = 0;
const caso = (n, fn) => { fn(); ok++; console.log(`✓ ${n}`); };

// Portugues
caso('Will: desativa essa porra', () => assert.equal(escribeEnPortugues('O Daniel, desativa essa porra dessa automação'), true));
caso('Marcos: E agora, o que fazer??', () => assert.equal(escribeEnPortugues('Não tenho outros. Apenas esse. E agora, o que fazer??'), true));
caso('bom dia solo NO alcanza (1 marca)', () => assert.equal(escribeEnPortugues('bom dia'), false));
caso('Olá, quero abrir uma empresa', () => assert.equal(escribeEnPortugues('Olá, quero abrir uma empresa nos EUA'), true));
caso('español no es portugues', () => assert.equal(escribeEnPortugues('Hola, quiero saber cuanto cuesta abrir la LLC'), false));
caso('Jacobo (español) no', () => assert.equal(escribeEnPortugues('en estas instancias necesito la factura de la apertura de la LLC'), false));
caso('Luciana (español) no', () => assert.equal(escribeEnPortugues('Llegó documentación? De las tarjetas de la llc?'), false));
caso('ingles no', () => assert.equal(escribeEnPortugues('Hi, I want to open an LLC'), false));

// Quiere salir
caso('Will: desativa', () => assert.equal(pideSalir('O Daniel, desativa essa porra dessa automação'), true));
caso('sacame de la lista', () => assert.equal(pideSalir('Sacame de la lista por favor'), true));
caso('dejen de mandarme', () => assert.equal(pideSalir('dejen de mandar mensajes'), true));
caso('não quero mais', () => assert.equal(pideSalir('Não quero mais receber isso'), true));
caso('STOP', () => assert.equal(pideSalir('STOP'), true));
caso('unsubscribe', () => assert.equal(pideSalir('please unsubscribe me'), true));
caso('no me interesa (texto)', () => assert.equal(pideSalir('no me interesa, gracias'), true));
caso('dar de baja mi LLC NO', () => assert.equal(pideSalir('quiero dar de baja mi llc'), false));
caso('cuando baja el precio NO', () => assert.equal(pideSalir('cuando baja el precio?'), false));
caso('desativar minha conta (banco) NO', () => assert.equal(pideSalir('como desativar minha conta do banco?'), false));
caso('consulta normal NO', () => assert.equal(pideSalir('Hola, necesito la factura de la apertura'), false));
caso('stopwatch NO (palabra entera)', () => assert.equal(pideSalir('uso stopwatch para medir'), false));

console.log(`\n${ok} casos OK`);
