// El puente CRM -> pixel de Meta. Cuatro reglas, todas de lectura.
//
// Por que existe este archivo y no son reglas mas dentro de reglas.js: las de
// alla miran la higiene del CRM (duplicados, cadencias, LLCs sin propietario).
// Estas miran otra cosa, la senal que el CRM le manda a Meta, y se rompen por
// motivos distintos. Separadas se pueden apagar juntas si hacen ruido.
//
// Medido el 4 y 5-sep-2026, y de ahi salen los umbrales:
//   - Tratos con Social Lead ID: 0 de los ultimos 200, sobre 1.099. Sin ese
//     campo Meta no puede atribuir NINGUNA venta.
//   - De 5 leads de Meta del 4-sep, 3 arrancaron el flujo y 2 no. La diferencia
//     era `Tipo`: los que lo tienen entran a Captacion solos.
//   - `SQL_Calificado_Landing` mando 10 eventos en dos semanas y el ultimo fue
//     hace 7 dias. Si el CRM deja de producir leads calificados, el pixel se
//     queda sin con que optimizar y nadie se entera.
//
// LIMITE CONOCIDO: `paginado('Leads')` NO trae los leads convertidos, que salen
// del modulo (hay que pedirlos con &converted=true). Hay al menos 200, y 17 de
// ellos quedaron en SQL Calificado. O sea que la regla 3 mide por lo bajo: los
// que peor estan son justo los que no se ven. Arreglarlo pide una segunda
// bajada y por ahora no vale la llamada extra; queda anotado a proposito.
import { link } from './reglas.js';

const dias = (d) => (Date.now() - new Date(d)) / 864e5;
const vacio = (v) => v === null || v === undefined || v === '';

// Los estados que representan una senal para Meta: el lead califico o compro.
// Son los rotulos que guardan los registros, no los valores internos del
// picklist: medido sobre 2.400 leads, 2.399 guardan el rotulo.
const ESTADOS_SENAL = new Set(['SQL Calificado', 'Convertido']);

// Cuantos dias mira cada regla. Los tratos y los leads de Meta se miran cortos
// porque son fallas del dia; la senal se mira larga porque es una tendencia.
const VENTANA_TRATOS = 14;
const HORAS_LEAD_META = 48;
const VENTANA_SENAL = 60;
const DIAS_SIN_SENAL = 7;

const ID_META = 'leadchain0__Social_Lead_ID';

/**
 * Las reglas del puente. Misma forma que las de reglas.js para que `comparar` y
 * `fotoDe` funcionen igual: { clave, titulo, nivel, casos:[{id,texto,link,creado}] }.
 */
export function reglasPuente({ leads, tratos }) {
  const out = [];

  // 1. Tratos nuevos sin el id de Meta. Es el corte que impide atribuir ventas:
  //    el campo existe en Tratos y no es de solo lectura, pero no viaja en la
  //    conversion Posible cliente -> Trato.
  out.push({
    clave: 'puente-trato-sin-id',
    titulo: 'tratos nuevos sin Social Lead ID',
    nivel: 'alto',
    casos: tratos
      .filter((t) => dias(t.Created_Time) <= VENTANA_TRATOS && vacio(t[ID_META]))
      .map((t) => ({
        id: `trato:${t.id}`,
        texto: `${t.Deal_Name || 'sin nombre'} · ${t.Stage || 'sin fase'}`,
        link: link('Potentials', t.id),
        creado: t.Created_Time,
      })),
  });

  // 2. Leads de Meta que entraron sin `Tipo`. Sin ese campo no arranca el flujo
  //    de Captacion: quedan en Nuevo MQL y no los llama nadie.
  out.push({
    clave: 'puente-meta-sin-tipo',
    titulo: 'leads de Meta que entraron sin Tipo',
    nivel: 'alto',
    casos: leads
      .filter((l) => /meta/i.test(l.Lead_Source || '')
        && dias(l.Created_Time) * 24 <= HORAS_LEAD_META
        && vacio(l.Tipo))
      .map((l) => ({
        id: `sintipo:${l.id}`,
        texto: `${l.Full_Name || 'sin nombre'} · ${l.Lead_Status || 'sin estado'}`,
        link: link('Leads', l.id),
        creado: l.Created_Time,
      })),
  });

  // 3. Leads que llegaron a calificado o convertido SIN el id de Meta. Aunque el
  //    evento salga, Meta no lo puede atar a ningun anuncio: la senal se pierde.
  out.push({
    clave: 'puente-senal-sin-id',
    titulo: 'leads calificados que Meta no puede reconocer',
    nivel: 'medio',
    casos: leads
      .filter((l) => ESTADOS_SENAL.has(l.Lead_Status)
        && dias(l.Last_Activity_Time || l.Created_Time) <= VENTANA_SENAL
        && vacio(l[ID_META]))
      .map((l) => ({
        id: `senalsinid:${l.id}`,
        texto: `${l.Full_Name || 'sin nombre'} · ${l.Lead_Status} · ${l.Lead_Source || 'sin canal'}`,
        link: link('Leads', l.id),
        creado: l.Last_Activity_Time || l.Created_Time,
      })),
  });

  // 4. El detector de silencio. No es una lista de registros rotos sino una
  //    sola alarma: hace DIAS_SIN_SENAL que ningun lead llega a calificado ni a
  //    convertido, asi que Meta no tiene con que optimizar.
  //
  //    Va como caso unico y con id fijo a proposito: mientras el silencio dure,
  //    `comparar` lo ve como el mismo caso y no lo repite todos los dias como
  //    nuevo. Cuando vuelva a haber senal desaparece solo y cuenta como resuelto.
  const conSenal = leads
    .filter((l) => ESTADOS_SENAL.has(l.Lead_Status))
    .map((l) => new Date(l.Last_Activity_Time || l.Created_Time))
    .filter((d) => !isNaN(d));
  const ultima = conSenal.length ? new Date(Math.max(...conSenal)) : null;
  const sinSenalHace = ultima ? Math.floor(dias(ultima)) : null;

  out.push({
    clave: 'puente-sin-senal',
    titulo: 'el CRM no le manda senal de calidad a Meta',
    nivel: 'alto',
    casos: (sinSenalHace === null || sinSenalHace >= DIAS_SIN_SENAL)
      ? [{
          id: 'sin-senal',
          texto: ultima
            ? `hace ${sinSenalHace} dias que ningun lead llega a SQL Calificado ni a Convertido`
            : 'no hay ningun lead en SQL Calificado ni en Convertido',
          link: 'https://eventsmanager.facebook.com/events_manager2/list/dataset/3246575845534868/overview',
          creado: ultima ? ultima.toISOString() : new Date().toISOString(),
        }]
      : [],
  });

  return out;
}
