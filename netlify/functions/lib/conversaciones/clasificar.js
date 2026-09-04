// Lee el ultimo mensaje del cliente y decide si alguien del equipo tiene que
// enterarse ahora. Es el unico lugar donde interviene un modelo.
//
// El caso que motivo el agente: un cliente activo escribio "me interesaria
// hacer otra llc con otro socio", el equipo contesto "desde el mismo panel
// puedes gestionarla" y ahi murio. No fue falta de respuesta, fue no ver que
// era una venta. Una regla de "conversacion sin contestar" no lo agarra.
import { generar } from './gemini.js';
import { MODELO_GEMINI } from './config.js';
import { bloqueDeEjemplos } from './aprendizaje.js';

export const CATEGORIAS = {
  venta: { emoji: '🟢', etiqueta: 'Señal comercial', equipo: 'sales' },
  riesgo: { emoji: '🔴', etiqueta: 'Riesgo', equipo: 'cx' },
  soporte: { emoji: '🟡', etiqueta: 'Soporte con fricción', equipo: 'cx' },
  operativo: { emoji: '⚪', etiqueta: 'Operativo', equipo: null },
  ruido: { emoji: '⚪', etiqueta: 'Sin acción', equipo: null },
};

// Etiqueta legible del tema, para que en Slack se vea de un vistazo que una
// alianza no es una venta comun aunque las atienda la misma persona.
export const TEMAS = {
  venta_nueva: 'Venta nueva',
  partnership: 'Partnership',
  referidos: 'Referidos',
  renovacion: 'Renovación',
  bancario: 'Bancario',
  administrativo: 'Administrativo',
  cx: 'Consulta',
};

const INSTRUCCIONES = `Sos parte del equipo de Start Companies, que abre y administra LLCs en
Estados Unidos para emprendedores de Latinoamerica y España. Servicios: apertura de LLC,
renovacion anual, cuenta bancaria, ITIN, contabilidad y facturacion.

Te paso el ULTIMO mensaje que escribio un cliente por WhatsApp y que todavia nadie contesto.
Tu tarea es decidir si alguien del equipo tiene que enterarse ahora mismo.

Categorias:

- "venta": el cliente muestra intencion de comprar o de ampliar lo que ya tiene. Incluye
  querer abrir otra LLC, sumar un socio, pedir precio, preguntar por un servicio que no
  tiene contratado (ITIN, contabilidad, cuenta bancaria), mencionar que va a recomendar a
  alguien, o pedir hablar con un asesor para avanzar. Ante la duda entre venta y operativo,
  elegi venta: perder una venta cuesta mas que una alerta de mas.

- "riesgo": el cliente esta enojado, amenaza con irse, pide cancelar o dar de baja, se queja
  de un cobro, dice que otro proveedor le ofrece algo mejor, o reclama algo que ya reclamo antes.

- "soporte": tiene un problema concreto sin resolver o esta confundido y necesita ayuda, pero
  sin enojo ni riesgo de perderlo. Por ejemplo no puede entrar al panel, no le llego un documento,
  no entiende un tramite.

- "operativo": tramite en curso que sigue su camino normal. Manda un documento que le pidieron,
  confirma un dato, avisa que ya pago, coordina un horario. Nadie tiene que reaccionar distinto.

- "ruido": agradecimientos, saludos, emojis sueltos, "ok", "listo", "dale". No requiere nada.

Si el mensaje es un archivo de audio o una imagen (llega como un nombre de archivo tipo
"1553465225969179.ogg") no podes leer el contenido: usa categoria "operativo", urgencia 1 y
poné en resumen "Audio o archivo, hay que escucharlo".

- tema: quien tiene que atenderlo. Es independiente de la categoria: un cliente
  enojado por su cuenta bancaria es categoria "riesgo" y tema "bancario".

  "venta_nueva"    quiere contratar algo PARA SI MISMO que todavia no tiene: abrir una LLC,
                   sumar otra, meter un socio, ITIN, contabilidad, o pide precio de algo nuevo.
                   Tambien cuando alguien llega recomendado y quiere contratar ("vengo de
                   parte de Juan", "me recomendo un amigo"): esa persona es una venta, no
                   un tema del programa de referidos.
  "referidos"      es sobre el PROGRAMA de referidos en si: pregunta como funciona o cuanto
                   pagan, avisa que va a referir a alguien, pasa el contacto de un conocido
                   para referirlo, o reclama una comision que le corresponde.
  "partnership"    propone trabajar JUNTO a nosotros en vez de comprarnos: ser socio,
                   revendedor, afiliado o white label, llevar nuestro servicio con su marca,
                   derivarnos clientes de forma sistematica (contadores, agencias, bancos,
                   plataformas), o pregunta por el programa de partners y sus condiciones.
  "renovacion"     la renovacion anual de una LLC que ya tiene: vencimiento, cobro de la
                   renovacion, si le conviene renovar, o dar de baja la empresa.
  "bancario"       cuenta bancaria: apertura, Mercury, Relay, Payoneer, transferencias,
                   cobros, tarjeta, cuenta bloqueada o cerrada.
  "administrativo" tramites y papeles de una LLC que ya existe: documentos, EIN, direccion,
                   Registered Agent, IRS, formularios, cambio de datos.
  "cx"             todo lo demas: consultas generales, seguimiento, quejas sobre la atencion,
                   pedidos de baja de la difusion, y cuando no queda claro de que se trata.

Campos:
- categoria: una de las cinco.
- tema: uno de los cinco de arriba.
- urgencia: 1 a 5. 5 = si nadie lo atiende hoy se pierde plata o se pierde el cliente.
- resumen: una linea, maximo 90 caracteres, en español rioplatense, diciendo que quiere el
  cliente. No repitas el mensaje textual, interpretalo.
- accion: que deberia hacer el equipo, maximo 90 caracteres. Concreto y en imperativo.
  Si la categoria es "ruido" u "operativo", dejalo en null.
- borrador: una respuesta lista para mandarle al cliente por WhatsApp, para que la persona
  del equipo la copie, la ajuste y la envie. Si la categoria es "ruido", dejalo en null.

  Como tiene que estar escrito:
  - Voseo rioplatense, como habla el equipo: "podes", "te parece", "contame". Sin usted.
  - Dos o tres frases. Es WhatsApp, no un mail.
  - Calido y directo, sin sonar a robot ni a plantilla de soporte.
  - Como maximo un emoji, y solo si suma. Casi siempre ninguno.
  - Nada de guiones largos.
  - Si la persona espera hace mucho, reconocelo en una frase corta y sin dramatizar.
  - Terminar moviendo la conversacion: una pregunta concreta o una propuesta.

  Lo que NO podes hacer, porque el que lo mande queda expuesto:
  - No inventes precios, plazos, fechas, nombres ni estados de tramites. Si hace falta un
    dato que no esta en el mensaje, dejalo entre corchetes: [precio de renovacion],
    [fecha], [link de agenda].
  - No prometas nada que no se pueda cumplir ("te lo resuelvo hoy") si no sabes si se puede.
  - No supongas que ya se hizo algo. Si no sabes en que quedo el tramite, preguntalo.

- desinteres: true SOLO si el cliente esta diciendo que NO va a avanzar. Vale para
  "no me interesa", "lo dejo para mas adelante", "ya lo hice con otra empresa", "no tengo
  el presupuesto", "no era lo que buscaba", "por ahora no". Tambien si pide que no le
  escriban mas. Es false si solo esta pensandolo, si pregunta algo, si no contesta lo que
  se le preguntó o si dice que despues ve: dudar no es desinteres.

  Esto apaga el seguimiento de una venta, asi que ante la duda poné false. Es peor dejar
  de insistirle a alguien que todavia puede comprar que insistirle una vez de mas.

Escribi resumen y accion SIEMPRE en español y solo con alfabeto latino. En una prueba el
modelo devolvio "y リンク de pago" mezclando katakana: eso llega al canal del equipo y queda
ilegible.`;

const ESQUEMA = {
  type: 'object',
  properties: {
    resultados: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'el mismo ref que vino en la entrada' },
          categoria: { type: 'string', enum: ['venta', 'riesgo', 'soporte', 'operativo', 'ruido'] },
          tema: {
            type: 'string',
            enum: [
              'venta_nueva',
              'partnership',
              'referidos',
              'renovacion',
              'bancario',
              'administrativo',
              'cx',
            ],
          },
          urgencia: { type: 'integer' },
          resumen: { type: 'string' },
          accion: { type: ['string', 'null'] },
          borrador: { type: ['string', 'null'] },
          desinteres: { type: 'boolean' },
        },
        required: ['ref', 'categoria', 'tema', 'urgencia', 'resumen'],
      },
    },
  },
  required: ['resultados'],
};

// Los mensajes son de una linea, asi que van juntos en una sola llamada al
// modelo en vez de una por conversacion. En la corrida normal son 5 o 10; el
// barrido del backlog puede traer cientos, y ahi hay que partir en tandas: con
// mas de ~50 el modelo empieza a saltearse refs, y el techo de salida se corta
// solo (con 40 por tanda y 8000 tokens el barrido del backlog murio con
// MAX_TOKENS a mitad de camino). El presupuesto de salida se calcula por fila.
const POR_TANDA = 25;

export async function clasificar(conversaciones, alAvanzar = null) {
  if (!conversaciones.length) return { porRef: {}, uso: { entrada: 0, salida: 0 } };

  if (conversaciones.length > POR_TANDA) {
    const tandas = [];
    for (let i = 0; i < conversaciones.length; i += POR_TANDA) {
      tandas.push(conversaciones.slice(i, i + POR_TANDA));
    }
    // De a 4 en paralelo: en serie, el barrido de las 1.016 pendientes tardaba
    // 7 minutos. Mas de 4 empieza a chocar con el limite de la API de Gemini.
    const porRef = {};
    const uso = { entrada: 0, salida: 0 };
    for (let i = 0; i < tandas.length; i += 4) {
      const grupo = await Promise.all(tandas.slice(i, i + 4).map((t) => clasificar(t)));
      for (const r of grupo) {
        Object.assign(porRef, r.porRef);
        uso.entrada += r.uso.entrada;
        uso.salida += r.uso.salida;
      }
      if (alAvanzar) alAvanzar(Object.keys(porRef).length, conversaciones.length);
    }
    return { porRef, uso };
  }

  const contenido = conversaciones
    .map((c, i) => {
      const ficha = c.ficha;
      const quien = ficha?.Full_Name || c.mobile_number__s || 'desconocido';
      const tipo = ficha?.modulo === 'Contacts' ? 'cliente ya activo' : 'posible cliente, todavia no compro';
      return [
        `--- ref: ${c.ref}`,
        `persona: ${quien} (${tipo})`,
        `espera hace: ${c.horasEsperando} horas`,
        `mensaje: ${String(c.last_message__s || '').slice(0, 1200)}`,
      ].join('\n');
    })
    .join('\n\n');

  let datos, uso;
  try {
    ({ datos, uso } = await generar({
      modelo: MODELO_GEMINI,
      // Los ejemplos van pegados al final de las instrucciones y no en el
      // contenido, para que el modelo los lea como parte de "asi se escribe
      // aca" y no como mas mensajes a clasificar.
      instrucciones: INSTRUCCIONES + bloqueDeEjemplos(),
      contenido: `Clasifica estos ${conversaciones.length} mensajes:

${contenido}`,
      esquema: ESQUEMA,
      // El presupuesto de salida se comparte con los tokens de razonamiento del
      // modelo, asi que no se puede calcular exacto por fila: un mensaje ambiguo
      // lo hace pensar mas y se lleva el margen puesto.
      maxTokens: Math.max(3000, conversaciones.length * 800),
    }));
  } catch (e) {
    // Un corte por MAX_TOKENS no devuelve resultado parcial: se pierde la tanda
    // entera. En vez de subir el techo a ojo, se parte al medio y se reintenta.
    // Con una sola conversacion ya no hay nada que partir, ahi si se propaga.
    if (!/MAX_TOKENS/.test(e.message) || conversaciones.length === 1) throw e;
    const mitad = Math.ceil(conversaciones.length / 2);
    const [a, b] = await Promise.all([
      clasificar(conversaciones.slice(0, mitad)),
      clasificar(conversaciones.slice(mitad)),
    ]);
    return {
      porRef: { ...a.porRef, ...b.porRef },
      uso: { entrada: a.uso.entrada + b.uso.entrada, salida: a.uso.salida + b.uso.salida },
    };
  }

  const porRef = {};
  for (const r of datos.resultados || []) porRef[r.ref] = r;
  return { porRef, uso };
}
