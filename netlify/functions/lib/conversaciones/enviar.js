// MANDA EL WHATSAPP. TEXTO LIBRE, SIN PLANTILLA.
//
// Por que se puede: cuando un cliente nos escribe, Meta abre una "ventana de
// servicio" de 24 horas y durante ese rato se le puede contestar texto libre,
// sin plantilla y sin aprobacion. La restriccion de las plantillas nunca fue de
// Meta: es de Zoho, cuyo modulo de mensajes es de solo lectura
// (`creatable: false`). Por eso el envio sale por la Cloud API de Meta, sobre
// la WABA propia de Start Companies.
//
// Como el agente solo contesta a alguien que acaba de escribir, la ventana
// siempre esta abierta. Si por lo que sea estuviera cerrada, Meta devuelve el
// error 131047 y este modulo lo reporta sin reintentar.
//
// ─── LOS FRENOS, QUE NO SE TOCAN ───────────────────────────────────────────
//
// En agosto de 2026 una regla en bucle mando la misma plantilla cada tres
// minutos hasta que Meta bloqueo el numero. Esto es un emisor automatico nuevo
// sobre el mismo numero, asi que va con cuatro candados:
//
//   1. ENVIAR apagado por defecto. Sin la variable puesta, corre en sombra.
//   2. Tope duro por corrida.
//   3. Uno por conversacion cada VENTANA_HORAS. Si ya le contestamos, no se
//      insiste, aunque el modelo elija otra entrada.
//   4. Bitacora de todo lo que sale, que es lo que despues lee el control de
//      trafico para que ningun otro agente le escriba al mismo telefono.
import { env } from './entorno.js';

const API = 'https://graph.facebook.com/v21.0';

// Numero de Start Companies: +1 786-935-4213, WABA 473595902494510.
// El PHONE_NUMBER_ID no es el telefono: sale de WhatsApp Manager -> API Setup.
export const PHONE_NUMBER_ID = env.META_PHONE_NUMBER_ID || null;
export const TOKEN = env.META_WHATSAPP_TOKEN || null;

/** El interruptor. Sin esto puesto en "1", nada sale. */
export const ENVIAR_DE_VERDAD = env.RESPUESTAS_ENVIAR === '1';

// Arranca en 5 por dia, por decision de Ignacio. Con ese volumen, si una
// respuesta esta mal escrita se ve el mismo dia y se apaga antes de que le
// llegue a nadie mas. Se sube cuando la calidad del numero no se haya movido.
export const TOPE_POR_CORRIDA = Number(env.RESPUESTAS_TOPE || 5);
export const TOPE_POR_DIA = Number(env.RESPUESTAS_TOPE_DIA || 5);
export const VENTANA_HORAS = Number(env.RESPUESTAS_VENTANA_HORAS || 12);

export function configurado() {
  return Boolean(PHONE_NUMBER_ID && TOKEN);
}

export function porQueNoConfigurado() {
  if (!TOKEN) return 'falta META_WHATSAPP_TOKEN';
  if (!PHONE_NUMBER_ID) return 'falta META_PHONE_NUMBER_ID';
  return null;
}

/**
 * El numero como lo quiere Meta: solo digitos, con codigo de pais y sin +.
 * Ojo con el 9 argentino y el 1 mexicano, que rompen el match en el CRM
 * (ver [[project_telefonos_duplicados]]). Aca NO se normalizan: se manda tal
 * cual vino de `mobile_number__s`, que es el numero con el que el cliente
 * escribio y por lo tanto el que Meta reconoce.
 */
export function aFormatoMeta(numero) {
  const solo = String(numero || '').replace(/[^\d]/g, '');
  return solo.length >= 8 ? solo : null;
}

/**
 * Manda un mensaje de texto. Devuelve `{ ok, id, error }` y nunca tira:
 * un fallo de envio no puede voltear la corrida entera del agente.
 */
export async function mandarTexto(numero, texto) {
  const para = aFormatoMeta(numero);
  if (!para) return { ok: false, error: `numero invalido: ${numero}` };
  if (!configurado()) return { ok: false, error: porQueNoConfigurado() };

  try {
    const r = await fetch(`${API}/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: para,
        type: 'text',
        // preview_url en false: el primer link del mensaje no se come la
        // pantalla con una tarjeta enorme.
        text: { preview_url: false, body: texto },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = j?.error || {};
      return {
        ok: false,
        codigo: e.code,
        error: `${e.code || r.status}: ${e.message || 'sin detalle'}`,
        ventanaCerrada: e.code === 131047,
      };
    }
    return { ok: true, id: j?.messages?.[0]?.id || null };
  } catch (e) {
    return { ok: false, error: String(e.message) };
  }
}

/**
 * Prueba de humo: manda un mensaje a un numero y cuenta que paso. Se usa una
 * sola vez, a mano, para dos cosas que hay que saber antes de prender nada:
 * si el token sirve, y si el mensaje aparece en el hilo de Zoho.
 */
export async function prueba(numero, texto = 'Prueba de Start Companies, ignorá este mensaje.') {
  if (!configurado()) return { ok: false, error: porQueNoConfigurado() };
  const r = await mandarTexto(numero, texto);
  return r;
}
