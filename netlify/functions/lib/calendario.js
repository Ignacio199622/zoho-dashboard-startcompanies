// Deduce el canal del cliente a partir del calendario donde reservo.
//
// POR QUE HACE FALTA. El cliente que crea el portal no tiene lead detras.
// Cruzando los 1.073 clientes contra los 8.466 leads dan CERO coincidencias por
// mail y 20 por telefono, de las cuales 3 aportan algo. Ese camino esta agotado,
// medido dos veces. Pero 395 clientes SI tienen una reunion agendada, y la
// reunion guarda en que calendario reservaron.
//
// LA REGLA NO SE INVENTA, SE APRENDE. Para cada calendario se mira que canal
// traian los LEADS que reservaron ahi, y solo se usa cuando la respuesta es
// contundente. Con los numeros de septiembre 2026:
//   "Asesoria estrategica 1 a 1 para tu LLC"  264 reservas  97% Meta Ads  -> se usa
//   "Consulta Gratuita de 30 Min sobre tu LLC" 96 reservas  51% mezcla    -> no
//   "30 Min Meeting"                            6 reservas  83% Meta Ads  -> no, muestra chica
// El calendario mas usado por los clientes ("30 Min Meeting", 195 reuniones) es
// justo el que no tiene leads con canal para aprender. Por eso de 383 clientes
// sin canal solo 39 son asignables: el resto no es que se descarte, es que el
// dato para decidirlo no existe.

const MIN_RESERVAS = 8;    // menos que esto es anecdota, no patron
const MIN_PUREZA = 75;     // un calendario que recibe de todos lados no dice nada
const MIN_COBERTURA = 60;  // % de los leads del calendario que tienen canal cargado

// POR QUE HACE FALTA LA COBERTURA (y por que casi me como el error).
// La pureza sola se puede fabricar sin querer. El 6-sep-2026 se le puso
// "Meta Ads" a 854 leads que tenian huella dura de Meta. Al recalcular, el
// calendario "30 Min Meeting" paso a dar 99% Meta sobre 1.513 leads... pero
// solo 160 tenian canal cargado. Los otros 1.353 no votan, y 697 de ellos no
// tienen ninguna huella, o sea que muy probablemente NO son de Meta.
// El 99% no medía el calendario: medía a quien yo habia etiquetado.
// Sin este tercer requisito se asignaban 202 clientes a Meta por construccion.
// Con el, sobrevive solo "Asesoria estrategica 1 a 1": 268 de 323 leads con
// canal, 83% de cobertura, y ahi el 97% si dice algo.

const tiene = (v) => v !== null && v !== undefined && String(v).trim() !== '';

/** El titulo sin el "entre Fulano y Mengano" que le agrega el calendario. */
export const normalizarTitulo = (t) =>
  String(t || '(sin titulo)').replace(/\s+(entre|between)\s+.*/i, '').replace(/\s+/g, ' ').trim();

/**
 * Que canal implica cada calendario, aprendido de los leads.
 * @returns {{regla: object, filas: object[]}} filas incluye tambien los descartados,
 *   para poder mostrar por que un calendario no se uso.
 */
export function aprenderRegla(eventos, leads) {
  const L = new Map(leads.map((l) => [l.id, l]));
  const dist = {};
  const universo = {}; // TODOS los leads del calendario, tengan canal o no
  for (const e of eventos) {
    if (e.$se_module !== 'Leads' || !e.What_Id?.id) continue;
    const l = L.get(e.What_Id.id);
    if (!l) continue;
    const t = normalizarTitulo(e.Event_Title);
    universo[t] = (universo[t] || 0) + 1;
    // 18-sep-2026: el canal del lead vive en Lead_Source (antes en Landing_Origen). Las fuentes
    // transitorias de integracion (WHATSAPP - ..., Chatbot) y "Sin dato histórico" no enseñan nada.
    if (!tiene(l.Lead_Source) || /^WHATSAPP|^WhatsApp - |wwebjs|^Chatbot|Bot$|^TimelinesAI|^Sin dato|^Sin origen|^No lo sé|^Landing Page$|^Web Organic$/.test(l.Lead_Source)) continue;
    (dist[t] ||= {})[l.Lead_Source] = (dist[t][l.Lead_Source] || 0) + 1;
  }

  const filas = Object.entries(dist)
    .map(([titulo, d]) => {
      const tot = Object.values(d).reduce((a, b) => a + b, 0);
      const [canal, n] = Object.entries(d).sort((a, b) => b[1] - a[1])[0];
      const pct = (n / tot) * 100;
      const leadsTotales = universo[titulo] || tot;
      const cobertura = (tot / leadsTotales) * 100;
      return {
        titulo, d, tot, canal, pct, leadsTotales, cobertura,
        sirve: tot >= MIN_RESERVAS && pct >= MIN_PUREZA && cobertura >= MIN_COBERTURA,
      };
    })
    .sort((a, b) => b.leadsTotales - a.leadsTotales);

  const regla = {};
  for (const f of filas) if (f.sirve) regla[f.titulo] = f;
  return { regla, filas };
}

/**
 * A que clientes se les puede poner canal. Solo los que no tienen ninguno.
 * @returns {{plan: object[], yaTenian:number, noConcluyente:number, ambiguo:number, conReunion:number}}
 */
export function planificarClientes(eventos, contactos, regla) {
  const C = new Map(contactos.map((c) => [c.id, c]));
  const porContacto = new Map();
  for (const e of eventos) {
    if (!e.Who_Id?.id) continue;
    if (!porContacto.has(e.Who_Id.id)) porContacto.set(e.Who_Id.id, []);
    porContacto.get(e.Who_Id.id).push(e);
  }

  const plan = [];
  let yaTenian = 0, noConcluyente = 0, ambiguo = 0;
  for (const [cid, evs] of porContacto) {
    const c = C.get(cid);
    if (!c) continue;
    if (tiene(c.Lead_Source) && !/^WHATSAPP|^WhatsApp - |wwebjs|^Chatbot|Bot$|^TimelinesAI|^Sin dato|^Sin origen|^No lo sé|^Landing Page$|^Web Organic$/.test(c.Lead_Source)) { yaTenian++; continue; }
    const usables = [...new Set(evs.map((e) => normalizarTitulo(e.Event_Title)).filter((t) => regla[t]))];
    if (!usables.length) { noConcluyente++; continue; }
    const canales = [...new Set(usables.map((t) => regla[t].canal))];
    // Reservo en dos calendarios que apuntan a canales distintos: no se elige.
    if (canales.length !== 1) { ambiguo++; continue; }
    plan.push({ id: cid, nombre: c.Full_Name, canal: canales[0], calendario: usables[0], pct: regla[usables[0]].pct });
  }
  return { plan, yaTenian, noConcluyente, ambiguo, conReunion: porContacto.size };
}
