# Plan de arreglo de captura en Zoho CRM

Estado al 2026-07-29. Datos medidos sobre los últimos 6 meses de Leads y Deals vía API.

El dashboard de métricas ya muestra todo lo que el CRM tiene. El problema es que el CRM no
tiene casi nada de lo que necesitamos medir. Este documento lista qué campo está roto, por qué,
y qué hay que hacer. Sin esto, poner una fecha de corte para "empezar de cero" no sirve: las
métricas nuevas van a estar igual de vacías que las viejas.

Para ver el avance en vivo: solapa **Calidad de Datos** del dashboard.

---

## 1. Los cinco agujeros, por prioridad

### 1.1 `¿Quién lo vendió?` en Deals — **0% desde siempre**

El campo existe (`Quien_lo_vendio`, tipo usuario) y nunca se usó, ni una sola vez en 715 Deals.
Como el dashboard cae al `Owner` del Deal, y el Deal lo crea la automatización, el **100% de las
LLCs figura vendida por "Start Companies Staff"**.

Consecuencia directa: no existe la métrica de ventas por vendedor. Nada de comisiones, ranking
ni conversión por persona es calculable hoy.

**Qué hacer**
- Workflow en Zoho: al crear un Deal desde un Lead, copiar el `Owner` del Lead a `Quien_lo_vendio`.
- Para los Deals que no vienen de un Lead: hacer el campo **obligatorio en el layout** de Deal.
- Regla de proceso: no se pasa un Deal a `Apertura Confirmada` sin `Quien_lo_vendio`.

### 1.2 `Confirmación de pago` en Deals — **se rompió en febrero 2026**

| Mes | % con pago cargado |
|---|---|
| oct-25 | 32% |
| nov-25 | 18% |
| dic-25 | 20% |
| ene-26 | 18% |
| **feb-26** | **2%** |
| mar-26 a jul-26 | 0% |

Nunca fue bueno, pero en febrero pasó a cero y no se recuperó. Febrero es también el mes en que
el volumen de Deals se duplicó (60 → 128). Muy probablemente entró una automatización nueva o
cambió el layout y el campo quedó fuera del flujo.

`Medios de pago` (el multiselect: Stripe / cripto / transferencia interna / transferencia AR /
transferencia internacional) va entre 8% y 60% según el mes, sin patrón.

**Qué hacer**
- Averiguar qué cambió en febrero (revisar historial de workflows y de layout en Zoho).
- Definir cuál de los dos campos es el bueno: hoy hay dos que dicen casi lo mismo
  (`Pago` = "Confirmación de pago" y `Medios_de_pago`). Sugerencia: dejar `Medios_de_pago` como
  único campo real y derivar el otro, o directamente retirar el duplicado.
- Regla: no se pasa a `Apertura Confirmada` sin medio de pago.

### 1.3 `Landing Origen` — **0% en Deals, 22-34% en Leads**

Este es el campo que responde tu pregunta de "¿de qué landing vino?". El picklist ya existe y
está bien pensado: Meta Ads, Google Ads, YouTube Ads, YouTube Orgánico, Reddit, SEO / Web
Orgánica, Marca Personal, Partner, Cliente actual, Email Marketing, Evento / AI, Relay / Banco,
SEO Satélite, Web Organic / SEO.

En Leads se empezó a usar en mayo (8%), llegó a 34% en junio y bajó a 22% en julio. En Deals
está en **0%**: la conversión de Lead a Deal no lo arrastra, así que la atribución se pierde
justo en el momento en que el lead se convierte en plata.

**Qué hacer**
- Que las landings manden el origen al form de Zoho (campo oculto con la UTM o un valor fijo por
  landing). Hoy depende de que alguien lo cargue a mano y por eso está en 22%.
- Workflow: al convertir Lead → Deal, copiar `Landing_Origen`.
- Los `fbclid`/`_fbc`/`_fbp` ya llegan al 19-24% desde junio; sirven para cruzar con Meta, pero
  no reemplazan a `Landing_Origen`.

### 1.4 Vendedor real en Leads — **solo 25%**

El 75% de los leads queda con `Owner` = "Start Companies Staff", el usuario genérico con el que
los crea la automatización. En el dashboard ahora se ve como **"Sin asignar"** en lugar de
fingir que Staff es una persona.

**Qué hacer**
- Regla de asignación automática (round-robin o por canal) al momento de crear el Lead.
- O, como mínimo, que reasignarlo sea el primer paso obligatorio al tomar un lead.

### 1.5 `Modalidad de Cierre` y `Modalidad de Pago` en Leads — **1-2%**

Ambos picklists existen y están prácticamente vacíos:
- `Modalidad de Cierre`: Llamada / Retargeting de vendedor / Retargeting empresa / Sin información
- `Modalidad de Pago`: Pago Total / Anticipo / No pago / Se autorizó

Hasta ahora el dashboard **inventaba** la modalidad de cierre a partir de si el lead había
agendado: si no agendaba escribía "Formulario Directo", si agendaba "Cierre en Llamada". Por eso
el panel mostraba 67% "Formulario Directo", una categoría que no existe en Zoho. Ya se sacó: hoy
dice "Sin dato" donde no hay dato.

**Qué hacer**
- Decidir si estos campos se usan o se retiran. Un campo al 1% es peor que no tenerlo: ocupa
  lugar en el layout y da la ilusión de que la información está.
- Si se usan: obligatorios al pasar el Lead a `SQL Calificado`.

---

## 1.6 El lead que agenda entra como un registro NUEVO — **el problema más grave**

Descubierto el 2026-07-30 al mirar por qué el embudo daba raro. La tasa de agendamiento por
canal, sobre los últimos 6 meses:

| Canal | Leads | "Agendaron" | % |
|---|---|---|---|
| WhatsApp | 719 | 1 | **0%** |
| Meta Ads | 535 | 7 | **1%** |
| Landing Page | 466 | 457 | **98%** |
| Web Orgánica | 131 | 131 | **100%** |
| Marca Personal | 22 | 22 | **100%** |

Ningún canal cae en el medio: o es 0% o es 100%. Eso no es una tasa de conversión, es una
clasificación. Lo que está pasando es que **cuando alguien agenda se crea un lead nuevo** con
`Lead_Source` = Landing Page o Web Orgánica, en vez de marcar el agendamiento sobre el lead
original que entró por WhatsApp o por Meta.

La prueba: hay **87 teléfonos repetidos** en el CRM, y en **52 casos** el mismo teléfono aparece
una vez en un canal de entrada y otra en un canal de agenda. Por ejemplo:

```
WhatsApp (13-feb, agendó=No)   ||   Landing Page (12-feb, agendó=Sí)
WhatsApp (27-jun, agendó=No)   ||   Landing Page (27-jun, agendó=Sí)
WhatsApp (14-jul, agendó=No)   ||   Web Orgánica  (28-jun, agendó=Sí)
```

Consecuencias, todas graves:
- **El total de leads está inflado**: una misma persona se cuenta dos veces.
- **La tasa de agendamiento no significa nada**: mide qué porcentaje de los registros nació de
  una reserva, no cuánta gente agendó.
- **La atribución se rompe**: la llamada queda anotada contra "Landing Page" aunque la persona
  haya venido de un anuncio de Meta. Cualquier decisión de presupuesto basada en esto está mal.
- Ningún mail se repite (0 duplicados por mail) porque los registros de WhatsApp no traen mail:
  el único campo que los une es el teléfono.

**Qué hacer**
- Regla de deduplicación por teléfono al crear leads (Zoho la soporta de fábrica).
- Que el flujo de reserva **busque el lead por teléfono y lo actualice** en vez de crear uno nuevo.
- Mientras tanto, el panel muestra una advertencia en el embudo para que nadie lea ese número
  como si fuera una conversión.

Este punto va **antes** que todos los demás: sin esto, ni siquiera el conteo de leads es correcto.

## 2. Higiene del picklist de canales

`Lead_Source` tiene el mismo canal escrito de varias formas y valores que no son canales:

| Se ve así en Zoho | Qué es |
|---|---|
| `WHATSAPP - Start Companies` | WhatsApp |
| `WhatsApp - Startcompanies-+17869354213` | WhatsApp (mismo) |
| `WHATSAPP wwebjs - Mensaje entrante wwebjs` | WhatsApp (mismo) |
| `TimelinesAI: +17868250365` | WhatsApp (mismo, vía herramienta) |
| `Forma Captacion Apertura` | Meta Ads |
| `Formulario Directo` (en Deals) | No es un canal, es una modalidad |
| `Google Calendar`, `Zoho Bookings` | No son canales, son herramientas |

El dashboard hoy los unifica al vuelo, pero eso es un parche: cualquier reporte hecho
directamente en Zoho va a seguir partiendo un canal en cinco.

**Qué hacer**: limpiar el picklist en Zoho a una lista corta y cerrada, y migrar los valores
viejos. Que las integraciones (wwebjs, TimelinesAI, Lead Chain) escriban el valor canónico.

---

## 3. Registros de prueba

Hay Deals de prueba en producción (el caso visible: `Ejemplo`, del 24-jul, sin nombre ni email,
en etapa "Apertura Confirmada"). Contaban como LLC abierta.

El dashboard ya los filtra, pero **hay que borrarlos en Zoho**: el token del dashboard es de solo
lectura a propósito, así que desde ahí no se puede. Y mientras existan, cualquier reporte hecho
en Zoho los sigue contando.

---

## 4. Fecha de corte

Recién cuando lo de arriba esté hecho tiene sentido decir "las métricas valen desde acá".

La función soporta la variable de entorno `ZOHO_LEADS_SINCE=AAAA-MM-DD` en Netlify para fijar
desde cuándo se leen los leads. La propuesta es:

1. Ejecutar los arreglos de las secciones 1 a 3.
2. Mirar la solapa **Calidad de Datos** una o dos semanas después.
3. Cuando `¿Quién lo vendió?`, `Landing Origen` y el medio de pago estén en verde (≥70%), fijar
   ese mes como corte y comunicarlo al equipo: los números de ahí en adelante son los oficiales.

Poner la fecha de corte antes de tapar los agujeros solo cambia la fecha de los datos vacíos.

---

## 5. Orden sugerido

| # | Acción | Dónde | Impacto |
|---|---|---|---|
| 0 | **Deduplicar por teléfono y que la reserva actualice el lead en vez de crear otro** (§1.6) | Zoho | Sin esto ni el conteo de leads es correcto |
| 1 | Borrar registros de prueba | Zoho | Bajo esfuerzo, saca ruido ya |
| 2 | Workflow Lead → Deal que copie `Owner` a `Quien_lo_vendio` | Zoho | Desbloquea métricas por vendedor |
| 3 | Averiguar qué rompió `Pago` en febrero y reponerlo | Zoho | Desbloquea métricas de facturación |
| 4 | Landing Origen automático desde las landings + arrastre a Deal | Landings + Zoho | Desbloquea atribución real |
| 5 | Limpiar picklist de canales y migrar valores | Zoho | Reportes consistentes |
| 6 | Asignación automática de vendedor en Leads | Zoho | Sube el 25% de vendedor real |
| 7 | Definir fecha de corte | Netlify | Cierra el tema |

Los puntos 1 a 6 son de Zoho y de las landings: el dashboard no puede resolverlos, solo mostrar
si avanzan. El 7 es una línea de configuración.
