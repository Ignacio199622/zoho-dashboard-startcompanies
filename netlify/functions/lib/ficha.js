// A quien pertenece la llamada dentro del CRM: un Posible cliente o un Contacto.
//
// POR QUE HAY QUE MIRAR LOS DOS (encontrado el 2026-09-03):
// El agente buscaba solo en Leads. La primera llamada que no encontro ficha fue
// justamente una VENTA CERRADA: el cliente contrato durante la llamada, con lo
// cual ya habia sido convertido a Contacto y en Leads no estaba mas.
//
// O sea que el agujero se comia exactamente los casos que mas importa registrar.
// Y no es un caso raro: toda venta que cierra termina como Contacto, igual que
// cualquier llamada de soporte o de seguimiento con un cliente actual.
//
// Se busca primero en Leads porque la mayoria de las llamadas de venta son con
// gente que todavia no compro, y asi el caso comun se resuelve en una sola
// consulta.
const API = 'https://www.zohoapis.com/crm/v6';

const CAMPOS_LEAD =
  'id,Full_Name,Email,Phone,Mobile,Lead_Status,Description,Owner,Retargeting,Nombre_retargeting';
// Contactos NO tiene Lead_Status ni los campos de la cadencia: son de Leads.
// Pedirlos igual devuelve un error de campo invalido, no un campo vacio.
const CAMPOS_CONTACTO = 'id,Full_Name,Email,Phone,Mobile,Description,Owner';

/**
 * @returns {Promise<null | {modulo:'Leads'|'Contacts', ...campos}>}
 */
export async function buscarFicha(mail, token) {
  if (!mail) return null;
  const H = { Authorization: `Zoho-oauthtoken ${token}` };
  const q = encodeURIComponent(mail);

  const buscar = async (modulo, campos) => {
    const r = await fetch(`${API}/${modulo}/search?criteria=(Email:equals:${q})&fields=${campos}`, { headers: H });
    if (r.status === 204) return null;
    const j = await r.json();
    const f = (j.data || [])[0];
    return f ? { ...f, modulo } : null;
  };

  return (await buscar('Leads', CAMPOS_LEAD)) || (await buscar('Contacts', CAMPOS_CONTACTO));
}

/** Como se liga una tarea a la ficha. Los dos modulos usan campos distintos. */
export function vinculoDeTarea(ficha) {
  if (!ficha?.id) return {};
  // Leads va por What_Id ("Relacionado con") y Contactos por Who_Id
  // ("Nombre de contacto"). Cruzarlos hace que la tarea quede huerfana.
  return ficha.modulo === 'Contacts'
    ? { Who_Id: ficha.id, $se_module: 'Contacts' }
    : { What_Id: ficha.id, $se_module: 'Leads' };
}
