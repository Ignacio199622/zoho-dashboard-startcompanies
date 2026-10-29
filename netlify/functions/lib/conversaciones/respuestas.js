// LA BASE DE RESPUESTAS
//
// El modelo NO escribe estos textos: los elige. Cada entrada la escribio una
// persona y la aprobo Ignacio, y el agente solo decide cual corresponde. Un
// modelo eligiendo entre 40 opciones cerradas es un problema muy distinto a un
// modelo redactando sobre impuestos de Estados Unidos.
//
// Reglas de escritura, sacadas de leer conversaciones reales (Emiliano y
// Katherine, agosto y septiembre de 2026):
//
//   - Sin botones. Es un WhatsApp, no un menu. El cliente contesta y le
//     responde una persona, esa es la salida y ya existe.
//   - Terminan y se callan. Nada de "hablar con un asesor" pegado al final.
//   - El precio va cuando es fijo. Cuando no lo es, no va ningun numero.
//   - Lo caro o lo lento va ADELANTE (la tarjeta sale 300 y tarda 20 dias),
//     no al final: si se enteran despues, es un reclamo.
//   - Al mandar al panel se NOMBRA el recurso exacto, entre comillas y letra
//     por letra, porque no hay link por video ni por guia: el cliente aterriza
//     en la grilla y tiene que reconocerlo.
//
// `publico`:  'lead' | 'cliente' | 'ambos'. El panel pide login, asi que
//             ninguna entrada de panel puede salirle a un lead.
// `estado`:   'lista' o 'frenada'. Las frenadas no se mandan aunque el modelo
//             las elija: les falta un dato y mandarlas a medias es peor.
// `{nombre}`: el nombre de pila. Se reemplaza al componer.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RAIZ } from './entorno.js';

export const LINK_AGENDA = 'www.startcompanies.io/agendar';
// Lili y partners tienen su propio calendario: el /agendar genérico es el de LLC (16-oct, Santi:
// leads de Lili que reagendaban en la consulta de LLC). Se decide por el título de la reunión o
// por la ficha (etiquetas, Calendario, Landing_Origen).
export const LINKS_AGENDA = { lili: 'lili.startcompanies.io', partner: 'socios.startcompanies.io' };
export function calendarioDe(texto) {
  const t = String(texto || '');
  if (/lili/i.test(t)) return 'lili';
  if (/socios start companies|partners-sc|socios\.startcompanies|posible partner/i.test(t)) return 'partner';
  return '';
}
export const linkAgendaDe = (texto) => `https://${LINKS_AGENDA[calendarioDe(texto)] || LINK_AGENDA}`;
export function calendarioDeFicha(ficha) {
  if (!ficha) return '';
  const tags = (ficha.Tag || []).map((t) => t.name || t).join(' ');
  return calendarioDe([tags, ficha.Calendario, ficha.Landing_Origen, ficha.Tipo].join(' '));
}
export const LINK_PANEL = 'panel.startcompanies.io/login';
export const LINK_VIDEOS = 'panel.startcompanies.io/panel/videos';
export const LINK_GUIAS = 'panel.startcompanies.io/panel/guias';
export const LINK_APERTURA = 'panel.startcompanies.io/apertura-llc';
export const LINK_FACTURACION = 'panel.startcompanies.io/panel/facturacion';
export const LINK_REFERIDOS = 'panel.startcompanies.io/panel/referidos';
export const LINK_BROCHURE = 'brochure.startcompanies.io';

export const RESPUESTAS = [
  {
    // La mas repetida del historial: el equipo la escribio 136 veces. Es el que
    // abre diciendo que tiene consultas pero todavia no dice cual.
    id: 'primer_contacto',
    titulo: 'Primer contacto sin pregunta concreta',
    cuando:
      'Abre la conversacion diciendo que tiene consultas, que vio algo nuestro o que quiere informacion, pero todavia no dice de que. Solo para el primer mensaje.',
    publico: 'lead',
    estado: 'lista',
    texto: `¡Gracias por escribir! Contame en qué te puedo ayudar y te paso el detalle:

• Constitución de tu LLC
• Renovación de una LLC que ya tenés
• Apertura de cuenta bancaria
• Otra cosa

Decime cuál y seguimos por acá.`,
  },

  // Solo leads: /agendar es el calendario de VENTA. El 14-sep un cliente con
  // dos LLCs pregunto por Relay, el bot le mando este link, reservo, y entro
  // como lead nuevo con el pitch de apertura. Para clientes va `agendar_cliente`.
  {
    id: 'agendar',
    titulo: 'Agendar o reagendar una llamada',
    cuando: 'Pide agendar, reagendar, el link del calendario, o avisa que no pudo entrar a una reunion.',
    publico: 'lead',
    estado: 'lista',
    texto: `Claro, agendá el horario que te quede cómodo desde acá:

${LINK_AGENDA}

Son 30 minutos con un asesor. Si ya tenías una reservada y no llegaste, desde ese mismo link sacás la nueva, no hace falta cancelar la anterior.`,
  },

  {
    id: 'agendar_cliente',
    titulo: 'Un cliente pide una llamada o una reunion',
    cuando: 'Ya es cliente y pide una llamada o una reunion para resolver dudas de su LLC, su cuenta o su tramite. La mayoria se resuelve por chat: no se ofrece llamada.',
    publico: 'cliente',
    estado: 'lista',
    texto: `Claro. Contame por acá qué duda tenés y te la resolvemos por este mismo chat, no hace falta una llamada.

Si después de eso queda algo que conviene hablar, lo coordinamos.`,
  },

  {
    id: 'precio_apertura',
    titulo: 'Que incluye y cuanto sale la apertura',
    cuando: 'Pregunta cuanto cuesta abrir la LLC, que incluye el servicio, o pide el brochure o la propuesta.',
    publico: 'lead',
    estado: 'lista',
    texto: `Tenemos tres planes. El más elegido es el Emprendedor, USD 599 pago único, e incluye:

• La LLC + el EIN, que es el número fiscal ante el IRS
• Tu cuenta bancaria en EE.UU. (Relay, Mercury o Lili)
• Articles of Organization y Operating Agreement
• Registered Agent y dirección por 1 año
• La plataforma 3 meses y soporte

Va en Florida, Wyoming, New Mexico o Montana.

Después está el Elite (USD 850), que suma cualquier estado y la cuenta global en USDC, y el Premium (USD 1.450), que ya te cubre el primer año de renovación y las presentaciones del CPA.

La propuesta completa, con todo comparado: ${LINK_BROCHURE}`,
  },

  {
    id: 'que_cuentas_abren',
    titulo: 'Que cuentas abren ustedes y cuales no',
    cuando: 'Pregunta si ustedes abren Mercury, Stripe o Chase, o si lo hace el cliente, o hasta donde llega el servicio.',
    publico: 'ambos',
    estado: 'lista',
    texto: `Te lo separo para que no queden dudas:

• Relay, Mercury y Lili Bank las abrimos nosotros. La de Lili es asistida, en una videollamada uno a uno con nuestra agente de cuentas.

• Stripe no lo abrimos, porque la cuenta es personal y tiene que crearla el titular. Sí te acompañamos en el proceso y te ayudamos si te trabás.

• Chase, Bank of America o Wells Fargo no. Esos bancos piden presencia física, así que hay que viajar. Con la documentación que te entregamos podés abrirlos vos cuando vayas.`,
  },

  {
    id: 'diferencia_bancos',
    titulo: 'Diferencia entre Relay, Mercury y Lili',
    cuando: 'Pregunta para que sirve cada cuenta, cual usar, o si alguna esta limitada.',
    publico: 'ambos',
    estado: 'lista',
    texto: `Las tres son cuentas de negocio en Estados Unidos. La diferencia práctica es cómo se usan juntas:

• Relay viene incluida en el paquete y es tu cuenta operativa. Trabaja con transferencias dentro de Estados Unidos: para mandar o recibir plata de afuera no te va a servir.
• Lili es la que usás para transferencias internacionales. Por eso conviene tener las dos.
• Mercury es una cuenta de negocio más, la gestionamos nosotros y sirve como respaldo.

Fiscalmente no hay ninguna diferencia entre las tres.`,
  },

  {
    id: 'requisitos_bancaria',
    titulo: 'Requisitos para la apertura bancaria',
    cuando: 'Pregunta que documentos necesitan para abrir la cuenta, o si un comprobante sirve.',
    publico: 'cliente',
    estado: 'frenada',
    frenoPorque: 'Frenada por Ignacio el 18-sep-2026: le salio a Kelyt (cliente) en medio de una apertura de Mercury que estaba llevando Camila, y encima el texto esta mal (pide el EIN dos veces y los Articles, que ya los tenemos nosotros). La apertura bancaria es un caso vivo que lleva CX, Marcos no se mete.',
    texto: `Para avanzar con tu apertura bancaria necesitamos:

1. El número de EIN
2. Articles of Organization
3. El EIN emitido por el IRS
4. Una factura de servicio (luz, agua o gas)
5. Un resumen bancario

Importante: la factura y el resumen tienen que estar a nombre del titular de la cuenta y con su dirección de residencia. Si están a nombre de otra persona, el banco los rechaza.

Los cargás acá: ${LINK_PANEL}`,
  },

  {
    id: 'requisitos_mercury',
    titulo: 'Requisitos de Mercury y Relay',
    cuando: 'Pregunta que pide Mercury o Relay, o los pasos de verificacion. NO si ya le fallo la verificacion.',
    publico: 'cliente',
    estado: 'frenada',
    frenoPorque: 'Frenada por Ignacio el 18-sep-2026: la apertura bancaria la lleva CX caso por caso (Camila le pidio a Kelyt el LinkedIn de la LLC y el bot dice otra cosa). Marcos no se mete en aperturas bancarias.',
    texto: `Depende de cuál:

Mercury es la más exigente. Pide un resumen de un banco tradicional a tu nombre, una web de tu negocio, tu perfil de LinkedIn y una factura de luz o agua a tu nombre y dirección.

Relay es más simple y se hace online.

Dos cosas que hacen fallar la verificación seguido: la foto del documento tiene que sacarse en el momento desde la app, no vale subir una que ya tengas guardada; y el teléfono tiene que ser el mismo con el que arrancaste la cuenta.`,
  },

  {
    id: 'llamada_apertura',
    titulo: 'Que necesito para la llamada de apertura',
    cuando: 'Pregunta que tiene que tener listo para la videollamada de apertura de cuenta.',
    publico: 'cliente',
    estado: 'frenada',
    frenoPorque: 'Frenada por Ignacio el 18-sep-2026: la apertura bancaria la lleva CX caso por caso. Marcos no se mete en aperturas bancarias.',
    texto: `Para la llamada de apertura de tu cuenta necesitás tener a mano:

• La computadora, no el celular, porque vas a compartir pantalla
• El pasaporte físico
• El celular también, para las verificaciones
• Tu web o LinkedIn activo

Si falta alguna de esas, la apertura se traba en el momento y hay que reagendar.`,
  },

  {
    id: 'sin_web_ni_linkedin',
    titulo: 'No tengo web ni LinkedIn',
    cuando: 'Avisa que no tiene pagina web ni LinkedIn de la empresa, o pregunta si hace falta.',
    publico: 'cliente',
    estado: 'frenada',
    frenoPorque: 'Frenada por Ignacio el 18-sep-2026: contradice lo que CX le pide al cliente en la apertura (Camila pidio LinkedIn de la LLC, esto dice que alcanza el personal). Marcos no se mete en aperturas bancarias.',
    texto: `No hace falta una web ni una página de empresa. Con tu LinkedIn personal alcanza:

• Poné tu foto
• Puesto: CEO de tu LLC, con el nombre exacto de la empresa
• Una descripción corta de a qué se dedica

Eso es lo que el banco mira para entender qué hace tu negocio.`,
  },

  {
    id: 'formulario_apertura',
    titulo: 'Donde esta el formulario de apertura',
    cuando: 'Pide el link para arrancar la apertura de la LLC o pregunta donde completa el formulario.',
    publico: 'ambos',
    estado: 'lista',
    texto: `Te comparto el formulario de apertura de tu LLC:

${LINK_APERTURA}

Se completa desde el celular sin problema. Si hay algún campo que no sabés cómo llenar, dejámelo por acá y lo vemos juntos.`,
  },

  {
    id: 'plazos_proceso',
    titulo: 'Cuanto tarda todo el proceso',
    cuando: 'Pregunta cuanto demora la LLC, el EIN o las cuentas bancarias.',
    publico: 'ambos',
    estado: 'lista',
    texto: `Los tiempos aproximados son:

• La LLC: en Wyoming y New Mexico, alrededor de 7 días hábiles. En Florida y Delaware, alrededor de 12 días hábiles o menos.
• El EIN: entre 1 y 3 días, una vez que están los Articles.
• Las cuentas bancarias: 2 o 3 días hábiles después de la verificación de identidad.

Te vamos avisando en cada paso, así seguís tu trámite sin tener que estar encima.`,
  },

  {
    id: 'como_pago',
    titulo: 'Como pago / medios de pago',
    cuando: 'Pregunta como abonar o que medios de pago se aceptan. NO si esta regateando el precio.',
    publico: 'lead',
    estado: 'lista',
    texto: `Aceptamos transferencia ACH, wire, Zelle, PayPal, criptomonedas y tarjeta con link de Stripe. La tarjeta tiene un recargo de la plataforma, el resto no.

Decime cuál te queda cómodo y te paso el link o los datos en el momento.`,
  },

  {
    id: 'renovacion',
    titulo: 'Que incluye la renovacion y cuando es',
    cuando: 'Pregunta cuando renovar, que incluye la renovacion anual o cuanto sale.',
    publico: 'ambos',
    estado: 'lista',
    texto: `Tu LLC se renueva una vez al año y lo hacemos todo junto, entre marzo y abril. Incluye:

• El pago del fee anual del estado, para mantenerla activa y en regla
• El Registered Agent y tu dirección en EE.UU. por un año más
• Las presentaciones federales y estatales: 1120 + 5472 si sos dueño extranjero, o 1065 si la LLC tiene más de un socio, más los informes del estado
• Los recordatorios: te avisamos cada vencimiento, no tenés que estar pendiente vos

La fecha límite es el 15 de marzo si tu LLC tiene más de un socio y el 15 de abril si es de un solo socio.

Sale USD 600 para single member y USD 700 para multi member. Delaware sale USD 950, porque el estado cobra un fee más alto.

Lo que no incluye es la contabilidad mensual, eso va aparte.`,
  },

  {
    id: 'impuestos',
    titulo: 'Impuestos: cuanto pago',
    cuando: 'Pregunta cuanto paga de impuestos, como tributa la LLC, o si paga taxes en Estados Unidos.',
    publico: 'ambos',
    estado: 'lista',
    texto: `Te tranquilizo de entrada: si no sos residente fiscal en Estados Unidos y no tenés presencia física allá, no pagás impuestos en Estados Unidos.

Lo que sí hay que hacer todos los años es presentar y renovar: el formulario federal ante el IRS (1120 + 5472 si sos dueño extranjero, o 1065 si la LLC tiene más de un socio), el fee anual del estado y el Registered Agent. De eso nos ocupamos nosotros entre marzo y abril y te avisamos antes.

Distinto es lo que te toque pagar en tu país por lo que cobrás. Eso depende de dónde seas residente y lo ve tu contador de allá.`,
  },

  {
    id: 'declaracion_anual',
    titulo: 'Que necesitan de mi para la declaracion anual',
    cuando: 'Pregunta que documentacion o extractos tiene que mandar para el reporte anual.',
    publico: 'cliente',
    estado: 'lista',
    texto: `Es más simple de lo que parece. Para la presentación anual de tu LLC necesitamos dos datos:

• Cuánto dinero ingresó durante el año
• Cuánto salió

No necesitamos tus extractos bancarios ni te los vamos a pedir. Tampoco entran tus cuentas personales: solo se declara lo de la LLC.

Te lo pedimos nosotros en marzo o abril, con las preguntas ya armadas, desde el panel en Renovación. No tenés que preparar nada por tu cuenta ahora.

Lo único que conviene que hagas durante el año es ir anotando los movimientos grandes, para contestar tranquilo cuando llegue el momento.`,
  },

  {
    id: 'que_registrar',
    titulo: 'Que tengo que registrar y para que',
    cuando: 'Pregunta que movimientos anotar, para que sirven los contratos o si tiene que guardar comprobantes.',
    publico: 'cliente',
    estado: 'lista',
    texto: `Son tres cosas y nada más:

• Aportes: la plata que ponés vos en la empresa
• Retiros: la que sacás para vos
• Ventas: lo que cobrás de tus clientes

Con eso alcanza para la declaración anual, que te la pedimos nosotros en marzo o abril.

Aparte de eso conviene guardar los contratos y las facturas, pero no son para el IRS: son para el banco. Si entra un movimiento grande y te lo preguntan, esa documentación es la que lo respalda y evita que te frenen la cuenta.`,
  },

  {
    id: 'panel_acceso',
    titulo: 'Como entro al panel',
    cuando: 'Pregunta como acceder al panel o donde ve sus documentos.',
    publico: 'cliente',
    estado: 'lista',
    texto: `Entrás desde acá, con el mail con el que abriste la empresa:

${LINK_PANEL}

Ahí tenés tus documentos, el estado del trámite y el facturador.

Si no te deja entrar, decime con qué mail lo estás intentando y lo destrabo.`,
  },

  {
    id: 'panel_para_que',
    titulo: 'Para que sirve el panel',
    cuando: 'Pregunta que puede hacer con la plataforma o para que se la dieron.',
    publico: 'cliente',
    estado: 'lista',
    texto: `El panel es donde vive tu empresa. Ahí tenés:

• Mis Solicitudes: el estado de cada trámite tuyo, sin tener que preguntar
• Tus documentos: Articles, EIN y Operating Agreement, para descargar cuando te los pidan
• Facturación: emitís las facturas a tus clientes y seguís lo que está pendiente de cobro
• Contabilidad: cargás los movimientos del año
• Renovación: desde ahí se gestiona la renovación anual
• Guías LLC y Videos Premium: el paso a paso de casi todo lo que vas a necesitar
• Referidos: tu link para recomendarnos y cobrar comisión

Si querés un recorrido, en Videos Premium está "Como Usar la plataforma de START COMPANIES".

${LINK_PANEL}`,
  },

  {
    id: 'facturar',
    titulo: 'Como emito una factura',
    cuando: 'Pregunta como hacer una factura o donde esta el facturador.',
    publico: 'cliente',
    estado: 'lista',
    texto: `Lo hacés desde tu panel, en Facturación: cargás los datos de tu cliente y la emitís ahí mismo. También tenés ahí el catálogo de tus servicios y el seguimiento de lo que está pendiente de cobro.

${LINK_FACTURACION}

Y si querés verlo antes: en Videos Premium está "Como hacer una factura".

Sí, conviene facturar siempre, tanto lo que cobrás como lo que gastás. Así el cierre del año sale limpio.`,
  },

  {
    id: 'relay_uso',
    titulo: 'Como uso mi cuenta de Relay',
    cuando: 'Pregunta como usar Relay, transferir, ver balances o pedir la tarjeta.',
    publico: 'cliente',
    estado: 'lista',
    texto: `Tenés el video "Como usar Relay" en tu panel, en Videos Premium. Va paso a paso: transferencias, balances y la tarjeta.

${LINK_VIDEOS}

Ahí mismo están los de Mercury, Lili y Wise, por si usás más de una.`,
  },

  {
    id: 'cuenta_aprobada',
    titulo: 'Me aprobaron la cuenta, que sigue',
    cuando: 'Avisa que le aprobaron o activaron la cuenta bancaria y pregunta el paso siguiente.',
    publico: 'cliente',
    estado: 'lista',
    texto: `¡Felicitaciones! Ya podés usarla. Te quedan dos cosas:

• Activarla con un primer depósito
• Mirar "Como usar Relay", en Videos Premium de tu panel

${LINK_VIDEOS}

Con el video alcanza para arrancar. Si aun así preferís que lo veamos juntos, decímelo y coordinamos.`,
  },

  {
    id: 'stripe',
    titulo: 'Como conecto Stripe',
    cuando: 'Pregunta como abrir o configurar Stripe. NO si ya se trabo o se lo rechazaron.',
    publico: 'cliente',
    estado: 'lista',
    texto: `En tu panel, en Videos Premium, tenés dos: "Como abrir Stripe" y "Como usar Stripe". El primero es el que buscás.

${LINK_VIDEOS}

Va con la LLC, el EIN y tu cuenta bancaria, que ya los tenés.

Una aclaración que también está dicha en el video: Stripe cambia su formulario seguido, así que puede que te aparezca algún campo que ahí no sale. El orden y la lógica son los mismos. Si te aparece uno que no reconocés, mandame la captura y te digo qué va.

Y un dato que evita el rechazo más común: si la empresa tiene socios, Stripe pide validar el pasaporte de cada uno. Si sos el único dueño, no aplica.`,
  },

  {
    id: 'payouts',
    titulo: 'Cuanto tarda en llegar la plata',
    cuando: 'Pregunta por que no le llego un pago de Stripe, o cuanto demora una transferencia a su cuenta.',
    publico: 'cliente',
    estado: 'lista',
    texto: `Te ordeno los tiempos, que son tramos distintos:

• Del cliente a Stripe: el pago se ve al instante en tu panel de Stripe.
• El primer pago que cobrás: Stripe lo retiene entre 7 y 14 días. Es una validación inicial de cuenta nueva, pasa una sola vez y no hay forma de acelerarla.
• De ahí en adelante: Stripe te libera cada pago 2 días hábiles después de cobrarlo, y te lo envía según la frecuencia que tengas configurada.
• De Relay a otra cuenta: 1 o 2 días hábiles por ACH si lo mandás antes de las 22:30 de Nueva York. Relay también tiene ACH del mismo día si lo enviás antes de las 16:15.

Todo cuenta días hábiles: un fin de semana o un feriado corre la fecha.

En tu panel de Stripe, en Balances, ves la fecha exacta de tu próximo envío y podés cambiar cada cuánto te lo manda.`,
  },

  {
    id: 'cobrar_exterior',
    titulo: 'Como le cobro a un cliente de otro pais',
    cuando: 'Pregunta como cobrarle a un cliente de otro pais o que paga en su moneda.',
    publico: 'cliente',
    estado: 'lista',
    texto: `Para un cliente que paga en su moneda, lo más simple es mandarle un link de pago de Stripe: paga con débito o crédito desde su país y a vos te entra en dólares.

Tiene un recargo de alrededor del 4%, que es la comisión de la plataforma.

Distinto es un cliente que ya tiene cuenta en Estados Unidos: ese te puede transferir directo a tu Relay y suele llegar en el día.`,
  },

  {
    id: 'transferencia_cual',
    titulo: 'Como hago una transferencia (sin decir a donde)',
    cuando: 'Pregunta como transferir o como mandar plata, sin aclarar si es dentro de EE.UU., al exterior o a su cuenta personal.',
    publico: 'cliente',
    estado: 'lista',
    // Existe porque el modelo se callaba: hay tres entradas de transferencia y
    // ninguna aplica hasta saber a donde va la plata. Elegir mal es mandarlo al
    // video equivocado, asi que esta repregunta y nombra los tres caminos.
    texto: `Depende de a donde va la plata, y son tres caminos distintos:

• A otra cuenta en Estados Unidos: sale desde Relay o Mercury. En Videos Premium de tu panel están "Como usar Relay" y "Como usar Mercury".
• A un proveedor o cliente del exterior: sale desde Lili, no desde Relay. Video "Como usar Lili Bank".
• A tu cuenta personal en tu país: es un retiro y el camino cambia según el país. En Guías LLC está "¿Cómo retirar dinero a tu país?".

${LINK_VIDEOS}

Decime cuál de las tres es y te paso el paso a paso.`,
  },

  {
    id: 'transferencia_internacional',
    titulo: 'Como mando una transferencia internacional',
    cuando: 'Quiere mandar plata a otro pais o pagarle a un proveedor del exterior.',
    publico: 'cliente',
    estado: 'lista',
    texto: `Las internacionales salen desde Lili. Relay trabaja dentro de Estados Unidos, así que desde ahí no vas a poder.

El paso a paso está en Videos Premium de tu panel, en "Como usar Lili Bank".

${LINK_VIDEOS}

Si el destino es una cuenta a tu nombre en tu país, mirá también la guía "¿Cómo retirar dinero a tu país?", que es un camino distinto.`,
  },

  {
    id: 'fondear_desde_mi_pais',
    titulo: 'Como meto plata desde mi pais a la LLC',
    cuando: 'Pregunta como mandar pesos o moneda local a la cuenta de la LLC, o como fondearla.',
    publico: 'cliente',
    estado: 'lista',
    texto: `Pesos directo a una cuenta en dólares no se puede. El camino es una cuenta puente: pasás tus pesos a dólares y desde ahí los mandás a la cuenta de tu LLC.

En Videos Premium tenés los dos caminos, paso a paso:

• "LB Finanzas: abrí tu cuenta y comprá USDT paso a paso"
• "Cómo abrir tu cuenta Wise paso a paso"

${LINK_VIDEOS}

Un detalle importante para después: esa plata que ponés vos es un aporte, no una venta. Anotala así, porque a fin de año se declaran distinto.`,
  },

  {
    id: 'bajar_plata',
    titulo: 'Como bajo la plata a mi pais',
    cuando: 'Pregunta como transferirse el dinero a su cuenta personal en su pais.',
    publico: 'cliente',
    estado: 'lista',
    texto: `Se puede, y el camino cambia según el país. En tu panel, en Guías LLC, está "¿Cómo retirar dinero a tu país?" con el detalle.

${LINK_GUIAS}

• Argentina: el camino habitual es pasar por una billetera virtual y bajar los pesos desde ahí.
• España, México y Colombia: transferencia internacional a tu cuenta. En España además podés usar directamente la tarjeta de débito de la cuenta de tu LLC.

Y lo mismo que con los aportes: la plata que sacás para vos es un retiro, no un gasto de la empresa. Anotalo así.`,
  },

  {
    id: 'tarjeta_fisica',
    titulo: 'Me mandan la tarjeta fisica',
    cuando: 'Pregunta si le pueden enviar la tarjeta de debito fisica, cuanto sale o cuanto tarda.',
    publico: 'cliente',
    estado: 'lista',
    texto: `Sí, se puede pedir la tarjeta física de la cuenta y usarla desde tu país.

Te adelanto las dos cosas que conviene saber antes: el envío sale USD 300, porque mandar tarjetas al exterior es caro, y puede demorar hasta 20 días hábiles en llegar.

Si lo que necesitás es tener la plata disponible ya, conviene la transferencia y dejar la tarjeta para después.`,
  },

  {
    id: 'cuenta_global',
    titulo: 'Que es la cuenta global',
    cuando: 'Pregunta que es la cuenta global o para que sirve.',
    publico: 'ambos',
    estado: 'frenada',
    frenoPorque: 'Falta confirmar desde que paises se puede recibir, si tiene costo por operacion y como se pasa de USDC a dolares.',
    texto: `Es una cuenta en USDC para cobrar y pagar en cualquier parte del mundo sin depender de los tiempos de un banco.

Sirve sobre todo para dos cosas: cobrarle a clientes de Latinoamérica y Europa que no te pueden hacer una transferencia a Estados Unidos, y mover plata entre países sin esperar días hábiles.

Recibís USDT y te queda en USDC, listo para usar.

Va incluida con el plan Premium. Si no lo tenés, se puede sumar aparte por USD 25 al mes. La manejás desde tu panel.`,
  },

  {
    id: 'pagar_equipo',
    titulo: 'Como le pago a mi equipo',
    cuando: 'Pregunta como pagarle a vendedores, freelancers o contractors.',
    publico: 'cliente',
    estado: 'lista',
    texto: `No hace falta manejarlo como nómina de empleados de Estados Unidos. Si trabajan para tu LLC como contractors, alcanza con dos cosas:

• Un contrato de prestación de servicios con cada uno
• Que cada pago quede respaldado con su factura o invoice a nombre de la LLC

En Guías LLC de tu panel están "¿Por qué es tan importante tener un Contrato?" y "¿Por qué es tan importante hacer y recibir una Invoice?", que es justo esto.

${LINK_GUIAS}`,
  },

  {
    id: 'w8ben',
    titulo: 'El formulario W-8BEN',
    cuando: 'Le piden un W-8BEN o pregunta como completarlo.',
    publico: 'cliente',
    estado: 'lista',
    texto: `En tu panel, en Guías LLC, tenés la "Guía de llenado Form W-8BEN" con el paso a paso de cada campo.

${LINK_GUIAS}

Es el formulario que te pide tu cliente en Estados Unidos para saber que no sos residente fiscal allá.

Una aclaración que evita idas y vueltas: el W-8BEN es el de las personas. Si la que factura es tu LLC, el que corresponde es el W-8BEN-E, que es la versión para empresas. Los campos son casi los mismos y la guía te sirve igual.

Si te lo pidieron con algún dato puntual que no sabés cómo completar, mandame la captura por acá.`,
  },

  {
    id: 'w9',
    titulo: 'Le piden un W-9',
    cuando: 'Le piden un W-9 o pregunta que es.',
    publico: 'cliente',
    estado: 'lista',
    // Dato de Ignacio (10-sep-2026): el W-9 es de quienes tienen presencia
    // fisica en EE.UU. La LLC de dueno extranjero completa W-8BEN-E, no W-9 ni
    // W-8BEN a secas (ese es el de las personas).
    texto: `El W-9 no es el tuyo: lo completan las empresas y las personas con presencia física en Estados Unidos.

Tu LLC es de dueño extranjero, así que lo que tenés que mandarle a tu cliente es el W-8BEN-E, que es la versión para empresas. El W-8BEN a secas es el de las personas.

En Guías LLC de tu panel está la "Guía de llenado Form W-8BEN": los campos son casi los mismos y te sirve para entenderlo.

${LINK_GUIAS}

Si tu cliente insiste con el W-9 porque ve que tenés EIN, mandame la captura y lo vemos.`,
  },

  {
    id: 'documentos_llc',
    titulo: 'Que documentos tiene mi LLC',
    cuando: 'Pregunta que documentos le corresponden o para que sirve cada uno.',
    publico: 'cliente',
    estado: 'lista',
    texto: `Tus documentos están todos en el panel, y en Guías LLC tenés "Documentos principales de tu LLC", que explica para qué sirve cada uno y cuál te van a pedir en cada trámite.

${LINK_GUIAS}

En Videos Premium también está "Documentos importantes de una LLC", si preferís verlo explicado.`,
  },

  {
    id: 'proteger_cuenta',
    titulo: 'Como cuido que no me cierren la cuenta',
    cuando: 'Pregunta como evitar bloqueos, si puede recibir transferencias grandes o que precauciones tomar. NO si ya le frenaron algo.',
    publico: 'cliente',
    estado: 'lista',
    texto: `En Guías LLC de tu panel está "Reglas para proteger tu cuenta". Son las prácticas que evitan que el banco te frene los fondos o te cierre la cuenta.

${LINK_GUIAS}

Vale la pena leerla antes de que pase algo, no después.`,
  },

  {
    id: 'direccion_ra',
    titulo: 'La direccion y el Registered Agent',
    cuando: 'Pregunta que es el agente registrado, si es la direccion comercial, o para que sirve.',
    publico: 'ambos',
    estado: 'lista',
    texto: `El Registered Agent es el representante legal de tu empresa en el estado donde la abriste, y va incluido con tu LLC por un año. Todo estado lo exige: es quien recibe en tu nombre las notificaciones del estado, del IRS y las judiciales.

Como tiene que tener una dirección física en ese estado, esa dirección es la que queda como domicilio de tu empresa y la que ponés cuando te piden dirección. Cuando llega algo a tu nombre, te avisamos.

No sirve para recibir paquetes ni mercadería. Si necesitás eso, contame para qué y lo vemos aparte.`,
  },

  {
    id: 'direccion_importar',
    titulo: 'Direccion fisica para importar (Amazon, aduana)',
    cuando: 'Avisa que Amazon o la aduana le rechazan la direccion para ser Importer of Record, o le piden una direccion fisica que no sea la del agente registrado.',
    publico: 'cliente',
    estado: 'lista',
    // La escribio Ignacio el 10-sep-2026, despues del caso de Milena: le habian
    // pasado la direccion del R.A., que es justo la que Amazon rechaza, y tuvo
    // que volver a preguntar al dia siguiente diciendo que era urgente.
    //
    // Ojo con el "no garantizamos": no es una formula para cubrirse. Amazon
    // rechaza la direccion porque hay mas de una empresa registrada ahi, y en la
    // de Miami tambien hay mas de una. Prometerle que sirve seria mentirle.
    texto: `Esto es un cambio de Amazon, no un problema de tu LLC.

Todas las LLC se abren con la dirección del Registered Agent, y para todo lo demás esa dirección sirve. Lo que cambió es que para ser Importer of Record te piden una dirección física, y como en la del agente registrado hay más de una empresa registrada, Amazon la rechaza.

Para resolverlo tenés dos caminos:

• Conseguir un coworking o una oficina y cambiar la dirección a esa. Es el camino que más chances tiene, porque queda a tu nombre y con una sola empresa.
• Usar nuestra dirección de Miami: 420 SW 7th, Suite 1014, Miami FL 33130. Te la damos sin problema, pero te lo digo de frente: ahí también hay más de una empresa, así que no podemos garantizarte que Amazon la acepte.`,
  },

  {
    id: 'ein_irs',
    titulo: 'El EIN no aparece en el sistema del IRS',
    cuando: 'Avisa que su EIN no figura en alguna base o plataforma no se lo acepta.',
    publico: 'cliente',
    estado: 'lista',
    texto: `Tranquilo, es normal y no es un error.

Tu EIN es válido desde el momento en que el IRS lo asigna, y por eso ya sirve para abrir las cuentas bancarias y operar.

Lo que puede tardar hasta un mes es que ese número se replique en las bases de datos de consulta del IRS y de algunas plataformas. Es un tema de tiempos internos de ellos, no de tu empresa.`,
  },

  {
    id: 'itin',
    titulo: 'ITIN',
    cuando: 'Pregunta que es el ITIN, si lo necesita, cuanto sale o cuanto tarda.',
    publico: 'ambos',
    estado: 'lista',
    texto: `El ITIN es tu número de identificación fiscal personal ante el IRS, para cuando tenés que declarar a tu nombre y no tenés Social Security.

En tu panel, en Guías LLC, está "ITIN: el número fiscal para extranjeros" con todo el detalle.

${LINK_GUIAS}

Lo tramitamos nosotros: sale USD 350 y demora entre 8 y 12 semanas hábiles, que es lo que tarda el IRS.

No es obligatorio para tener tu LLC ni para abrir las cuentas: se pide cuando lo necesitás para trámites a tu nombre.`,
  },

  {
    id: 'boi',
    titulo: 'Que es el BOI',
    cuando: 'Pregunta por el BOI o por FinCEN.',
    publico: 'cliente',
    estado: 'lista',
    texto: `El BOI es el reporte de los dueños reales de la empresa ante FinCEN.

Va incluido en la renovación cuando corresponde, así que no tenés que hacer nada por tu cuenta ni contratarlo aparte.

Si querés el detalle, en Guías LLC de tu panel está "¿El reporte BOI es obligatorio?".

${LINK_GUIAS}`,
  },

  {
    id: 'referidos',
    titulo: 'Cuanto me pagan por referir',
    cuando: 'Pregunta por el programa de referidos, la comision o como recomendar.',
    publico: 'ambos',
    estado: 'lista',
    texto: `Cobrás USD 50 por cada persona que constituya su LLC con nosotros y pague. A partir del referido número 11, pasás a USD 75 por cada uno.

Te das de alta vos mismo desde el panel, en la sección Referidos, y ahí te generás tu link.

${LINK_REFERIDOS}

Ese link se lo mandás a tus clientes o a quien quieras: la persona queda registrada a tu nombre desde el primer contacto, sin que tengas que avisarnos nada.`,
  },

  {
    id: 'confiables',
    titulo: 'Son ustedes serios',
    cuando: 'Duda de si la empresa es confiable, pregunta si tienen oficina, o si esto es una estafa.',
    publico: 'lead',
    estado: 'lista',
    texto: `Te entiendo, es plata y es a distancia. Te dejo con qué chequearnos.

Tenemos 4,9 de 5 con más de 250 reseñas en Trustpilot, escritas por clientes reales. Y en el brochure está todo lo que incluye el servicio y quiénes somos: ${LINK_BROCHURE}

Además la apertura va con garantía: si no te abrimos la cuenta bancaria, te devolvemos el dinero.

Y si preferís vernos la cara antes de pagar nada, la llamada de 30 minutos es gratis y sin compromiso.`,
  },
];

// ─── LAS QUE SE CREARON SOLAS ──────────────────────────────────────────────
//
// `nuevas-entradas.js` agrega entradas a partir de respuestas que escribio una
// persona y que un cliente confirmo que le sirvieron. Viven en un JSON aparte,
// no aca: asi se pueden borrar o editar sin tocar el codigo, y en el `git diff`
// de este archivo solo aparece lo que escribio un humano.
//
// Se leen con require diferido para que este modulo siga sirviendo sin el
// archivo (la primera vez no existe) y para no arrastrar dependencias.
function aprendidas() {
  try {
    return JSON.parse(readFileSync(join(RAIZ, 'aprendizaje', 'entradas-nuevas.json'), 'utf8'));
  } catch {
    return [];
  }
}

/** Todas: las escritas a mano y las que aprendio el agente. */
export function todas() {
  return [...RESPUESTAS, ...aprendidas()];
}

/** Las que se pueden mandar hoy. Las frenadas se eligen pero no salen. */
export const LISTAS = RESPUESTAS.filter((r) => r.estado === 'lista');

export function porId(id) {
  return todas().find((r) => r.id === id) || null;
}

/**
 * El catalogo que ve el modelo. Solo id, titulo y cuando: el texto no le hace
 * falta para elegir y gastaria tokens en cada corrida.
 */
export function catalogo(publico) {
  return todas().filter((r) => r.publico === 'ambos' || r.publico === publico)
    .map((r) => `- ${r.id}: ${r.cuando}`)
    .join('\n');
}
