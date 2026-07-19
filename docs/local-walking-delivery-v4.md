# Local Walking Delivery V4

## Estado de entrega

Esta especificación define la política versionada de Local Walking Delivery para OrderPro. La implementación permanece en `DRAFT` dentro de `STAGING`, sin publicación V4 activa y con sus cuatro feature flags deshabilitadas. No autoriza publicación, tráfico ni credenciales de producción.

| Campo | Valor exacto |
| --- | --- |
| `policyId` | `walking-route-distance-v4-base-10` |
| `feePolicyVersionId` | `walking-route-distance-v4-base-10-2026-07-16` |
| `zoneVersionId` | `upper-east-side-walking-zones-v1` |
| Estado inicial | `DRAFT` |
| Entorno inicial | `STAGING` |
| Estrategia | `WALKING_ROUTE_DISTANCE` |
| Base de distancia | `ONE_WAY_FROM_SELECTED_STORE` |
| Unidad | `FEET` |
| Perfil de ruta | `walking` |
| Moneda | `USD` |

OrderPro es la autoridad final para normalizar la dirección, decidir elegibilidad, seleccionar la tienda, calcular la ruta y la tarifa, mostrar slots, y reservar capacidad e inventario. El storefront no puede sustituir esas decisiones.

En el contrato V4, `eligible` significa exclusivamente elegibilidad geográfica: dirección exacta en Manhattan y punto dentro de la zona publicada de uno de los cinco ZIP admitidos. `bookable` indica si la cotización puede avanzar a un capacity hold en este momento. El storefront debe evaluar ambos campos y no inferir uno a partir del otro.

## Tiendas y asignación

| `locationId` | Nombre | Dirección | Coordenadas | Asignación fija |
| --- | --- | --- | --- | --- |
| `third_avenue` | 3rd Avenue Store | 1243 3rd Ave, New York, NY 10021 | 40.769473514641, -73.960715741688 | 10021, 10065 |
| `east_86th_street` | 86th Street Store | 112 E 86th St, New York, NY 10028 | 40.779922307507, -73.956748615355 | 10028, 10128 |

El ZIP compartido `10075` usa `NEAREST_WALKING_ROUTE`. OrderPro calcula las rutas desde las dos tiendas con el mismo proveedor y perfil, conserva ambas como evidencia y selecciona por:

1. menor `walkingDistanceFeet`;
2. menor `walkingDurationSeconds` si la distancia es idéntica;
3. `locationPriority` versionada y auditable si continúa el empate.

Después de seleccionar una tienda, solo se consultan sus slots. La falta de slots produce `NO_SLOTS_FOR_SELECTED_LOCATION`; nunca cambia silenciosamente a la tienda más lejana.

## Elegibilidad y `CONTACT_STORE`

La evaluación usa una dirección exacta, no ambigua y normalizada por un proveedor confiable. El resultado de jurisdicción `isManhattan` también debe provenir del proveedor; no se infiere por texto libre.

Toda respuesta HTTP 200 conserva `normalizedAddress.borough: "Manhattan"` como evidencia explícita. El request no acepta `borough`; es un dato derivado y confiable del geocodificador server-side.

El orden de decisión es obligatorio:

1. validar el request;
2. normalizar y geocodificar la dirección exacta;
3. confirmar Manhattan;
4. comparar el ZIP normalizado de cinco dígitos con `10021`, `10065`, `10075`, `10028` y `10128`;
5. para uno de esos cinco ZIP, cargar la política publicada y ejecutar point-in-polygon contra `upper-east-side-walking-zones-v1`;
6. solo entonces calcular rutas, tarifa, inventario y slots.

| Dirección normalizada | Resultado HTTP/negocio | `eligible` | `bookable` | ¿Se calcula ruta? |
| --- | --- | ---: | ---: | --- |
| Manhattan y ZIP fuera de los cinco admitidos | HTTP 200, `reasonCode: CONTACT_STORE`, `storefrontMessage: "Contact store"` | `false` | `false` | No |
| Fuera de Manhattan, cualquiera que sea el ZIP | HTTP 422, `ADDRESS_NOT_IN_MANHATTAN` | No hay quote | No hay quote | No |
| ZIP admitido, pero punto fuera del polígono publicado | HTTP 422, `OUTSIDE_WALKING_AREA` | No hay quote | No hay quote | No |
| Dirección no exacta, ambigua o inválida | HTTP 422, `INVALID_ADDRESS` | No hay quote | No hay quote | No |

`Contact store` es el texto exacto, incluyendo mayúsculas y espacio. La respuesta `CONTACT_STORE` se guarda de forma idempotente, conserva dirección normalizada, coordenadas, ZIP y correlación, devuelve `eligible: false` y `bookable: false`, y expira a los 300 segundos. No consulta ni expone versión de política, polígono, routing, fee, inventario, prioridad de tiendas ni slots.

La distancia nunca decide la elegibilidad geográfica. Los anillos del mapa son ilustrativos; solo el polígono publicado decide. Una dirección dentro de la zona continúa elegible aunque su ruta supere 4,250 ft.

## Rutas, tiempos y capacidad

El fee usa la distancia walking de solo ida desde la tienda seleccionada hasta la entrada geocodificada:

```text
roundTripDistanceFeet = walkingDistanceFeet × 2
estimatedRoundTripDurationSeconds = walkingDurationSeconds × 2
requiredCapacitySeconds = estimatedRoundTripDurationSeconds
  + preparationBufferSeconds
  + handoffBufferSeconds
```

`preparationBufferSeconds` y `handoffBufferSeconds` se versionan y persisten por separado. Representan preparación, acceso al edificio, elevador/recepción y entrega final. El round trip y ambos buffers consumen capacidad, pero no cambian directamente el tier del fee. `holdTtlSeconds` también pertenece a la versión cotizada y determina el vencimiento del hold; no se recibe del caller ni se reemplaza por el TTL del quote.

La distancia recibida en metros se convierte server-side a feet y se redondea a dos decimales antes de seleccionar el tier. Si el proveedor no responde, mezcla proveedores en la comparación de `10075`, devuelve un perfil distinto de `walking` o entrega métricas inválidas, OrderPro falla cerrado sin adivinar distancia, tarifa ni slots.

## Tabla definitiva de fees

Los límites inferiores son exclusivos y los superiores inclusivos. El primer tier incluye cero y el último no tiene máximo.

| `tierId` | Rango de `walkingDistanceFeet` | `feeCents` | Precio |
| --- | ---: | ---: | ---: |
| `free-local` | 0 a 1,200 inclusive | 0 | $0 |
| `base-delivery` | >1,200 a 2,200 inclusive | 1,000 | $10 |
| `extended-12` | >2,200 a 2,700 inclusive | 1,200 | $12 |
| `extended-14` | >2,700 a 2,950 inclusive | 1,400 | $14 |
| `extended-15` | >2,950 a 3,250 inclusive | 1,500 | $15 |
| `extended-17` | >3,250 a 3,500 inclusive | 1,700 | $17 |
| `extended-19` | >3,500 a 3,750 inclusive | 1,900 | $19 |
| `extended-21` | >3,750 a 4,000 inclusive | 2,100 | $21 |
| `extended-23` | >4,000 a 4,250 inclusive | 2,300 | $23 |
| `whole-zone-25` | >4,250, sin máximo dentro de la zona | 2,500 | $25 |

No existen tiers de $2, $4, $6 ni $8. Una distancia mayor de 4,250 ft no produce revisión manual por sí sola.

## Casos de calibración

Las distancias son referencias que deben recalibrarse con el proveedor aprobado; el tier y el fee se evalúan con la distancia real guardada.

| Dirección | Asignación/distancia de referencia | Resultado esperado |
| --- | --- | --- |
| 599 E 85th St, 10028 | `east_86th_street`, ~3,924 ft | `extended-21`, $21 |
| 500 E 80th St, 10075 | Third ~4,261 ft; 86th ~4,490 ft | `third_avenue`, `whole-zone-25`, $25 |
| 316 E 82nd St, 10028 | `east_86th_street`, ~2,816 ft | `extended-14`, $14 |
| E 96th St y Park Ave | desde 86th, ~2,929 ft | `extended-14`, $14 |
| E 96th St y Lexington Ave | desde 86th, ~2,951 ft | `extended-15`, $15 |
| E 96th St y 3rd Ave | desde 86th, ~3,447 ft | `extended-17`, $17 |
| E 96th St y 2nd Ave | desde 86th, ~4,110 ft | `extended-23`, $23 |

## Pruebas exactas de bordes

| Distancia | Resultado |
| ---: | --- |
| 1,200 ft | $0 / `free-local` |
| 1,200.01 ft | $10 / `base-delivery` |
| 2,200 ft | $10 / `base-delivery` |
| 2,200.01 ft | $12 / `extended-12` |
| 2,700 ft | $12 / `extended-12` |
| 2,700.01 ft | $14 / `extended-14` |
| 2,950 ft | $14 / `extended-14` |
| 2,950.01 ft | $15 / `extended-15` |
| 3,250 ft | $15 / `extended-15` |
| 3,250.01 ft | $17 / `extended-17` |
| 3,500 ft | $17 / `extended-17` |
| 3,500.01 ft | $19 / `extended-19` |
| 3,750 ft | $19 / `extended-19` |
| 3,750.01 ft | $21 / `extended-21` |
| 4,000 ft | $21 / `extended-21` |
| 4,000.01 ft | $23 / `extended-23` |
| 4,250 ft | $23 / `extended-23` |
| 4,250.01 ft dentro de la zona | $25 / `whole-zone-25` |
| cualquier distancia finita mayor dentro de la zona | $25 / `whole-zone-25` |
| cualquier punto fuera del polígono de un ZIP admitido | `OUTSIDE_WALKING_AREA` |

## Quote, slots e inventario

`POST /api/v1/local-delivery/quote` recibe dirección, líneas del carrito y fecha solicitada. Una oferta con precio siempre devuelve `eligible: true`, porque el punto ya pasó la zona publicada. Devuelve `bookable: true` únicamente cuando `availableSlots` contiene al menos un slot real de la tienda seleccionada. `NO_SLOTS_FOR_SELECTED_LOCATION` conserva `eligible: true`, pero devuelve `bookable: false` y `availableSlots: []`; no se puede crear un hold.

La oferta guarda tienda, regla de asignación, rutas candidatas, métricas de ida y round trip, capacidad requerida, fee, tier, slots, proveedores, correlación, `calculatedAt`, vencimiento y las versiones exactas de zona y fee. También conserva el `holdTtlSeconds` y los buffers de preparación y handoff de esa versión. Cada entrada de `candidateRoutes` conserva la `locationPriority` usada en el desempate. La oferta pública expone `inventoryOwnerLocationIds` e `inventoryNodeIds` externos; la persistencia interna conserva por línea producto, variante, cantidad, owner, nodo, contenedor/bin, ubicación de storage, estado de transferencia y primera hora lista. Los UUID internos no se filtran al JSON público. Estos campos de auditoría son obligatorios en una oferta con precio y no aparecen en `CONTACT_STORE`.

El adapter Prisma de quotes persiste `CONTACT_STORE` sin linaje de policy/routing y persiste una oferta con sus rutas, slots e inventario en una transacción serializable. Antes del commit verifica que la versión y publicación exactas sigan vigentes, que los slots sean canónicos y que un único balance certificado pueda cubrir cada grupo físico cotizado sin dividir una línea entre lotes. La elección y bloqueo del balance/lote concreto ocurre al adquirir el hold; el quote no consume inventario.

Los conceptos de inventario no son intercambiables:

- `orderLocationId`: tienda comercial responsable;
- `deliveryLocationId`: tienda que despacha al caminante;
- `inventoryOwnerLocationId`: propietario comercial;
- `inventoryNodeId`: ubicación física;
- `warehouseBoxId`/`binId`: posición física dentro del warehouse;
- `reservationId` y `transferStatus`: evidencia de reserva y movimiento.

Si el inventario está físicamente en warehouse, OrderPro puede devolver `TRANSFER_REQUIRED` y `transferEarliestReadyAt`. Solo ofrece slots de la tienda ya seleccionada que comiencen después de esa preparación. Nunca cambia la tienda por motivos de inventario.

## Holds atómicos

El flujo público es:

1. `POST /api/v1/local-delivery/holds` crea el hold para un `quoteId` y `slotId`.
2. `POST /api/v1/local-delivery/holds/{holdId}/confirm` recibe `{ "orderId": "..." }` y confirma el hold antes de finalizar la orden.
3. `POST /api/v1/local-delivery/holds/{holdId}/release` recibe una razón explícita: `ORDER_CANCELLED`, `PAYMENT_FAILED` o `MANUAL`. La expiración automática utiliza la razón auditable `QUOTE_EXPIRED`.

Crear un hold debe revalidar cliente, quote no expirado, `bookable: true`, slot perteneciente a la tienda seleccionada, capacidad e inventario. También debe resolver explícitamente la tienda comercial responsable (`orderLocationId`) mediante una decisión identificada y versionada; no puede asumir que siempre es igual a `deliveryLocationId`. La deducción de `capacitySeconds` y la creación de `inventoryReservationId` forman una sola operación atómica: ambas se confirman o ninguna cambia. El adapter Prisma implementado usa una transacción serializable, locks ordenados y restricciones diferidas. La estrategia conservadora `exact_physical_tuple_unique_sufficient_balance/v1` solo asigna cuando existe un único balance individual capaz de cubrir toda la tupla física; si falta o hay más de uno, falla sin escribir ni dividir lotes. Todo permanece desconectado hasta su aprobación comercial y las pruebas concurrentes en PostgreSQL administrado.

La repetición de creación con el mismo cliente, `Idempotency-Key` y payload devuelve el mismo resultado. Reutilizar la clave con otro payload produce `IDEMPOTENCY_CONFLICT`. Release/expiry restaura capacidad e inventario exactamente una vez; confirm/release repetidos con el mismo `orderId` o `reason` deben ser transiciones idempotentes. Cada respuesta de transición conserva `confirmedOrderId` y `releaseReason`, además de `confirmedAt` y `releasedAt`, para auditar qué orden consumió la reserva o por qué se restauraron los recursos.

## Seguridad y errores

Los cuatro endpoints son APIs machine-to-machine, nunca sesiones humanas de Supabase. Quote requiere scope `local-delivery:quote`; holds y transiciones requieren `local-delivery:holds`. Todos requieren `X-Correlation-ID`; quote y creación de hold también requieren `Idempotency-Key`. `clientId` y `X-Correlation-ID` admiten como máximo 120 caracteres; idempotency keys, IDs de quote, slot, hold, order y variant admiten como máximo 160. Las identidades externas de location/node se persisten con máximo 64 y el routing provider con máximo 80. Los IDs estables usan letras, números, punto, guion bajo, dos puntos o guion, y comienzan con un carácter alfanumérico.

El `correlationId` guardado dentro del quote o del hold es evidencia inmutable de su creación. Confirm y release reciben una correlación propia para la transición y la devuelven en el header HTTP; no sobrescriben la correlación original del recurso.

Errores controlados: `INVALID_CORRELATION_ID`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_REQUEST`, `INVALID_ADDRESS`, `ADDRESS_NOT_IN_MANHATTAN`, `OUTSIDE_WALKING_AREA`, `DISTANCE_UNAVAILABLE`, `ROUTING_PROVIDER_UNAVAILABLE`, `NO_SLOTS_FOR_SELECTED_LOCATION`, `INVENTORY_NOT_READY`, `TRANSFER_REQUIRED`, `QUOTE_EXPIRED`, `CAPACITY_HOLD_FAILED`, `POLICY_VERSION_UNAVAILABLE`, `SLOTS_UNAVAILABLE` e `IDEMPOTENCY_CONFLICT`.

## Staging, fail-closed y bloqueadores de publicación

La superficie HTTP existe, pero permanece cerrada con HTTP 503 y `M2M_AUTH_NOT_CONFIGURED`. Ya existen adapters Prisma desconectados para leer la publicación exacta de política/zonas, persistir quotes y ejecutar el ciclo transaccional de holds/reservas, incluido el worker de expiración. También existe una estrategia conservadora y versionada de allocation. El runtime no contiene una rama activable: incluso con el gate de STAGING y un bundle de funciones completo continúa bloqueado hasta incorporar una composición real certificada. Auth0 ya fue seleccionado, sus valores públicos se recibieron y el verificador RFC 9068 fail-closed está implementado; el cliente durable existe únicamente como `PENDING_VERIFICATION`. Siguen pendientes la aprobación de la estrategia, una prueba Auth0 de extremo a extremo, la activación auditada del cliente y sus grants, los proveedores reales y el wiring certificado. Esta es una condición segura, no una señal para usar datos simulados en tráfico real.

Antes de habilitar siquiera tráfico de staging deben existir y quedar auditados:

- prueba Auth0 RFC 9068 de extremo a extremo, aprobación/activación auditada del cliente pendiente, rotación y scopes;
- geocodificador aprobado con exactitud, ambigüedad y jurisdicción Manhattan confiables;
- proveedor de rutas walking y estrategia de timeout/retry, usando el mismo proveedor para ambos candidatos de `10075`;
- GeoJSON oficial, digest, validación point-in-polygon y publicación de `upper-east-side-walking-zones-v1`;
- publicación auditable en STAGING de `walking-route-distance-v4-base-10-2026-07-16` con los diez tiers exactos;
- identidades, coordenadas y prioridad oficial de ambas tiendas;
- horarios, cutoff, buffers y capacidad real por slot;
- fuente de inventario, tiempos de transferencia y separación owner/node/bin;
- aprobación comercial de `exact_physical_tuple_unique_sufficient_balance/v1` y conexión certificada de los adapters Prisma de policy/quote/hold;
- proveedor auditable para resolver `orderLocationId` y pruebas de la estrategia de balance/lote con inventario real;
- programación/observabilidad del worker de expiraciones y coordinación de cancelaciones/fallos de pago;
- observabilidad, alertas, runbook y aprobación comercial documentada.

Producción requiere una aprobación separada, nuevas credenciales/gates y evidencia de pruebas end-to-end. Publicar en STAGING no puede activar PRODUCTION implícitamente.

El contrato HTTP completo está en `docs/openapi/orderpro-local-delivery-v1.yaml` y el esquema de respuesta de quote en `docs/schemas/local-delivery-quote-v4.schema.json`.
