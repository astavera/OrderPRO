# Reporte de cambios — Local Walking Delivery V4

| Campo | Valor |
| --- | --- |
| Fecha de corte | 2026-07-17 |
| Estado de release | `DRAFT / STAGING` |
| Producción | No publicada y bloqueada de forma intencional |
| Migraciones versionadas | 15 en el repositorio; 15/15 aplicadas desde cero por la regresión aislada PGlite |
| Base administrada | 15/15 desplegadas; `npm run verify:db:v4` confirmó el estado seguro DRAFT/STAGING después del deploy |

## Resumen ejecutivo

OrderPro incorpora una nueva versión, sin modificar versiones históricas, para evaluar Local Walking Delivery de las tiendas `third_avenue` y `east_86th_street`. La versión define cinco ZIP admitidos, asignación fija o por la ruta walking más corta, diez tiers desde $0 hasta un máximo abierto de $25, slots exclusivos de la tienda seleccionada y un ciclo de holds que reserva capacidad e inventario como una unidad.

También se incorporó la decisión comercial solicitada para direcciones fuera de los cinco ZIP: si la dirección normalizada es válida y pertenece a Manhattan, la cotización responde HTTP 200 con `CONTACT_STORE` y el mensaje exacto `Contact store`. El resultado no se confunde con una dirección fuera de Manhattan ni con un punto fuera del polígono de un ZIP admitido.

La auditoría del contrato separa ahora dos decisiones: `eligible` es elegibilidad geográfica y `bookable` es disponibilidad actual para crear un hold. Una dirección dentro de la zona permanece `eligible: true` aunque la tienda seleccionada no tenga slots; en ese caso devuelve `bookable: false` y `NO_SLOTS_FOR_SELECTED_LOCATION`.

La superficie HTTP permanece cerrada con `M2M_AUTH_NOT_CONFIGURED`. Ya existen adapters Prisma desconectados para leer la publicación exacta de policy/zonas, persistir quotes y ejecutar el ciclo transaccional de holds/reservas, incluido el worker de expiración. Se agregó una estrategia conservadora y versionada de allocation que rechaza cualquier balance ausente o ambiguo. Auth0 y sus valores públicos ya están definidos, y el cliente durable está registrado únicamente como `PENDING_VERIFICATION`. Aún faltan su aprobación comercial, los proveedores reales, el verificador M2M, la activación auditada del cliente/grants y una composición certificada; por eso ningún tráfico puede calcular ni reservar usando datos simulados.

Los errores previos a completar una cotización —por ejemplo, dirección inválida, fuera de Manhattan, fuera del polígono o proveedor de rutas no disponible— se devuelven como respuestas de error y no crean una fila de quote. `CONTACT_STORE` sí es un resultado HTTP 200 persistido e idempotente porque representa una decisión comercial completa para una dirección válida de Manhattan fuera de los cinco ZIP admitidos.

## Identificadores inmutables

| Concepto | Valor |
| --- | --- |
| Política | `walking-route-distance-v4-base-10` |
| Versión de fee | `walking-route-distance-v4-base-10-2026-07-16` |
| Versión del conjunto de zonas | `upper-east-side-walking-zones-v1` |
| Estrategia | `WALKING_ROUTE_DISTANCE` |
| Base | `ONE_WAY_FROM_SELECTED_STORE` |
| Perfil/unidad/moneda | `walking` / `FEET` / `USD` |

## Artefactos incorporados

| Área | Artefactos | Resultado |
| --- | --- | --- |
| Dominio | `src/domain/walking-delivery/local-walking-delivery-v4.ts` | Constantes exactas, tiendas, ZIP, prioridad, diez tiers, ruta compartida y evaluación fail-closed. |
| Aplicación | `src/application/local-delivery-v4/contracts.ts` y `evaluate-local-delivery-quote.ts` | Puertos de geocoding/policy/zone/routing/inventory/slots/store; quote idempotente; `eligible`/`bookable`; `CONTACT_STORE`; selección, TTL y buffers versionados, y evidencia física por línea. |
| Holds | `src/application/local-delivery-v4/capacity-holds.ts` | Acquire con TTL cotizado y resolución explícita/versionada de `orderLocationId`; confirmación por `orderId`, liberación con razón, correlación de transición, expiración e idempotencia. |
| HTTP | `src/application/local-delivery-v4/local-delivery-http-handlers.ts` y rutas bajo `src/app/api/v1/local-delivery/` | Auth antes de PII, scopes, correlación, idempotencia y errores controlados. |
| Referencia transaccional | `src/infrastructure/local-delivery-v4/in-memory-stores.ts` | Adapter solo para tests/staging que reserva capacidad e inventario en una sección crítica y restaura exactamente una vez. No sustituye el adapter persistente. |
| Persistencia de quote | `src/infrastructure/local-delivery-v4/prisma-local-delivery-quote-store.ts` | Adapter serializable con replay idempotente, relectura canónica, validación de publicación/slots/balance certificado y escritura atómica de quote, rutas e inventario; existe, pero no está conectado al endpoint. |
| Persistencia de hold | `src/infrastructure/local-delivery-v4/prisma-capacity-hold-store.ts` | Adapter serializable desconectado con allocator síncrono/puro obligatorio y versionado, locks ordenados, reloj autoritativo posterior a locks, par atómico hold/reservation, confirm/release y expiración `SKIP LOCKED`; incluye la estrategia conservadora `exact_physical_tuple_unique_sufficient_balance/v1`, todavía pendiente de aprobación comercial y wiring certificado. |
| Datos | `prisma/schema.prisma` y migraciones V4 `20260716213000`, `20260717002500`, `20260717003000`, `20260717110000`, `20260717113000`, `20260717120000`, `20260717123000` y `20260717124500` | Base aditiva y endurecimiento forward-only para versiones, identidades, snapshots canónicos, lifecycle, slots/holds, reservas, ledger, aprobaciones Owner, compatibilidad histórica, paridad física, validaciones fuertes y concurrencia/reloj. La semilla es DRAFT/STAGING y no crea publicación activa. |
| Contratos | `docs/openapi/orderpro-local-delivery-v1.yaml` y `docs/schemas/local-delivery-quote-v4.schema.json` | Quote, hold, confirm/release, errores, ejemplos y restricciones de V4. |
| Operación | `docs/local-walking-delivery-v4.md` | Especificación comercial/técnica, bordes, casos y gates. |
| Regresión SQL | `scripts/check-walking-v4-migrations.mjs`, `package.json` y `package-lock.json` | PGlite 0.5.4 aplica las 15 migraciones desde cero; `npm run check` ejecuta esta regresión mediante `test:migrations:v4`. |
| Verificación administrada | `scripts/check-walking-v4-configured-state.mjs` | `npm run verify:db:v4` confirma migraciones correctivas, columnas de evidencia, flags off, cero publicaciones/quotes/holds/reservas y catálogos DRAFT/STAGING. |

## Diferencias funcionales frente a la versión anterior

- Se crea una versión nueva; no se reescribe una versión histórica publicada.
- El fee se divide en diez tiers. El último, `whole-zone-25`, queda abierto para cualquier distancia mayor de 4,250 ft que siga dentro de la zona.
- Superar 4,250 ft ya no produce revisión manual por sí solo y nunca supera $25.
- `10075` conserva las dos rutas candidatas y aplica desempate por distancia, duración y prioridad.
- No hay fallback de tienda por falta de slots ni por ubicación física del inventario.
- Inventario comercial, nodo físico y transferencia se separan de la tienda que realiza la entrega.
- Quote y holds son contratos distintos; obtener un quote no consume recursos.
- `eligible` representa zona geográfica; `bookable` exige al menos un slot retenible de la tienda seleccionada.
- Cada ruta candidata guarda la `locationPriority` usada; las ofertas guardan `inventoryOwnerLocationIds` e `inventoryNodeIds`.
- Cada oferta persiste `calculatedAt`, el TTL del hold y `preparationBufferSeconds`/`handoffBufferSeconds` por separado; capacidad suma ambos buffers y no usa un buffer operacional implícito.
- La evidencia interna por línea conserva producto, variante, cantidad, owner, nodo, contenedor/bin, storage, transferencia y readiness; los UUID internos no se exponen en la respuesta pública.
- `normalizedAddress.borough` conserva el valor confiable `Manhattan` y no proviene del request.
- El hold enlaza una reserva de capacidad y una de inventario, registra la orden confirmada o la razón de liberación y expira.
- La correlación original del quote/hold es inmutable; confirm/release usan una correlación propia de transición sin reemplazarla.
- Manhattan fuera de los cinco ZIP produce el resultado presentacional `Contact store` sin invocar routing.

## Los diez tiers

| `tierId` | Límite inferior | Límite superior | `feeCents` |
| --- | ---: | ---: | ---: |
| `free-local` | 0 inclusivo | 1,200 inclusivo | 0 |
| `base-delivery` | 1,200 exclusivo | 2,200 inclusivo | 1,000 |
| `extended-12` | 2,200 exclusivo | 2,700 inclusivo | 1,200 |
| `extended-14` | 2,700 exclusivo | 2,950 inclusivo | 1,400 |
| `extended-15` | 2,950 exclusivo | 3,250 inclusivo | 1,500 |
| `extended-17` | 3,250 exclusivo | 3,500 inclusivo | 1,700 |
| `extended-19` | 3,500 exclusivo | 3,750 inclusivo | 1,900 |
| `extended-21` | 3,750 exclusivo | 4,000 inclusivo | 2,100 |
| `extended-23` | 4,000 exclusivo | 4,250 inclusivo | 2,300 |
| `whole-zone-25` | 4,250 exclusivo | abierto | 2,500 |

## Matriz de decisiones geográficas

| Condición | `eligible` | `bookable` | Resultado | HTTP | Trabajo omitido |
| --- | ---: | ---: | --- | ---: | --- |
| Dirección exacta en Manhattan, ZIP normalizado no admitido | `false` | `false` | `CONTACT_STORE`, mensaje `Contact store` | 200 | policy, zona, rutas, fee, inventario y slots |
| Dirección fuera de Manhattan | Sin quote | Sin quote | `ADDRESS_NOT_IN_MANHATTAN` | 422 | policy, zona, rutas, fee, inventario y slots |
| ZIP admitido, punto fuera del polígono publicado | Sin quote | Sin quote | `OUTSIDE_WALKING_AREA` | 422 | rutas, fee, inventario y slots |
| Dentro de zona, slots disponibles | `true` | `true` | `ELIGIBLE` o `TRANSFER_REQUIRED` | 200 | Ninguno |
| Dentro de zona, tienda seleccionada sin slots | `true` | `false` | `NO_SLOTS_FOR_SELECTED_LOCATION` | 200 | Hold no permitido |
| Dirección no exacta/ambigua | Sin quote | Sin quote | `INVALID_ADDRESS` | 422 | toda decisión posterior |
| Proveedor de rutas no confiable o no disponible | Sin quote | Sin quote | `DISTANCE_UNAVAILABLE` o `ROUTING_PROVIDER_UNAVAILABLE` | 503 | fee, inventario y slots |

Esta precedencia es relevante: una dirección fuera de Manhattan nunca debe recibir `Contact store` solo porque también use un ZIP no admitido.

## Contratos HTTP

| Endpoint | Scope | Request principal | Éxito |
| --- | --- | --- | --- |
| `POST /api/v1/local-delivery/quote` | `local-delivery:quote` | address, cartLines, requestedDate | HTTP 200 con `eligible`/`bookable`, oferta o `CONTACT_STORE` |
| `POST /api/v1/local-delivery/holds` | `local-delivery:holds` | quoteId, slotId | HTTP 201 nuevo; 200 replay |
| `POST /api/v1/local-delivery/holds/{holdId}/confirm` | `local-delivery:holds` | `{ "orderId": "..." }` | `{ hold, changed }` |
| `POST /api/v1/local-delivery/holds/{holdId}/release` | `local-delivery:holds` | `{ "reason": "ORDER_CANCELLED|PAYMENT_FAILED|MANUAL" }` | `{ hold, changed }` |

Los resultados del hold exponen `inventoryReservationId`, `confirmedOrderId`, `releaseReason`, `confirmedAt` y `releasedAt`. `QUOTE_EXPIRED`, `INVENTORY_UNAVAILABLE` y `CAPACITY_UNAVAILABLE` son razones internas válidas; los clientes solo pueden solicitar las tres razones de release definidas por el endpoint.

Los límites del contrato se alinean con persistencia y validación de aplicación: `clientId` y correlación admiten hasta 120 caracteres; idempotency key, variant, quote, slot, hold y order admiten hasta 160. Los identificadores estables comienzan con un carácter alfanumérico y después aceptan letras, números, punto, guion bajo, dos puntos o guion. Los IDs externos de location se conservan con límite de 64 y el nombre del routing provider con 80 dentro de la persistencia.

## Atomicidad e idempotencia

La creación del hold verifica antes de mutar:

1. quote del mismo cliente y no expirado;
2. quote elegible y slot de `selectedLocationId`;
3. capacidad suficiente para `requiredCapacitySeconds`;
4. un balance certificado capaz de cubrir cada tupla física cotizada sin dividir una línea entre lotes.

El hold solo acepta un quote `bookable: true`. El commit de capacidad e inventario es todo-o-nada. Un fallo de inventario no consume capacidad y un fallo de capacidad no crea reserva de inventario. Dos operaciones concurrentes no pueden consumir la misma capacidad ni la misma unidad disponible. Confirmar registra un `orderId`; liberar/expirar restaura ambos recursos una sola vez y conserva la razón. Una repetición compatible devuelve `changed: false`; una transición contradictoria falla.

La implementación in-memory y los adapters Prisma focalizados demuestran esas invariantes en tests. Las migraciones persistentes agregan locks por slot y balance físico, relación diferida 1:1 entre capacity hold e inventory reservation, vínculo exacto con el slot ofertado, claves idempotentes únicas y ledger append-only `RESERVED` / `RESERVATION_RELEASED`. La evidencia de quote conserva identidades externas owner/node canónicas e inmutables; la paridad diferida exige que cada reserva preserve exactamente línea, producto, variante, cantidad, owner, nodo, contenedor, storage y estado de transferencia cotizados. Como el contrato no permite dividir una línea entre lotes, el quote exige un único balance certificado que cubra la cantidad total de cada tupla física. La estrategia `exact_physical_tuple_unique_sufficient_balance/v1` selecciona solamente cuando existe un único balance individual suficiente; cero o varios candidatos provocan `INVENTORY_UNAVAILABLE` antes de cualquier escritura. La reserva persiste de forma inmutable la decisión de order location y la versión de la estrategia de allocation. Los snapshots de slots se reconstruyen desde la base, descuentan holds activos y eliminan campos no canónicos. Un slot futuro no puede cerrarse con holds activos; después de un release sincronizado sí puede cerrarse. El provider de policy solo acepta la versión V4 exacta, publicada, efectiva y consistente con sus snapshots/digests; ante ausencia, duplicado o deriva devuelve indisponibilidad sin fallback histórico. La superficie HTTP todavía no usa esos adapters y el runtime no tiene una rama READY, por lo que permanece cerrado incluso si alguien cambia el gate de entorno.

## Evidencia de pruebas incorporada

- La suite de dominio cubre IDs, tiendas, los cinco ZIP, los diez tiers, todos los bordes `.00/.01`, los siete casos de calibración, el tier abierto y la ausencia de manager review por distancia.
- Las pruebas de asignación cubren las dos rutas de `10075`, desempate auditable y ausencia de fallback cuando la ganadora no tiene slots.
- Las pruebas de aplicación cubren proveedor homogéneo, fallo cerrado, transfer readiness, slots de la tienda seleccionada, `CONTACT_STORE` sin routing y precedencia de Manhattan.
- Las pruebas de holds cubren replay idempotente, dos reservas concurrentes, rollback lógico cuando falla inventario, expiración, confirmación y release explícito.
- Las pruebas focalizadas de adapters Prisma cubren publicación exacta de policy/zonas, deriva de snapshots/digests, snapshots históricos, P2002 seguro, quote vencido, locks/orden transaccional, allocator versionado, cleanup de un hold vencido, transiciones auditadas y worker `SKIP LOCKED`.
- Las pruebas HTTP cubren auth antes de PII, scopes/headers/body, sanitización de errores del autenticador, IDs de ambas reservas y transiciones.
- La prueba de runtime confirma HTTP 503 para quote y todo el ciclo de holds con gate apagado, entorno incorrecto, dependencias incompletas y también con un bundle completo que aún carece de certificación real.

La corrida final del 2026-07-17 aprobó **31 archivos y 297 pruebas**, ESLint sin warnings, generación de tipos de Next/TypeScript, validación del schema Prisma y build de producción con Next.js 16.2.10. La reauditoría de seguridad del incremento no dejó hallazgos P0/P1 abiertos.

La regresión reproducible `npm run test:migrations:v4` usa PGlite 0.5.4 y aplica las **15 migraciones** completas desde una base vacía. El gate compuesto `npm run check` ahora incluye lint, typecheck, tests de Vitest y esta regresión SQL; un release candidate debe conservar evidencia de una corrida completa del gate sobre el mismo commit que se pretende publicar.

La regresión persistente verifica: compatibilidad cerrada entre schemas v1/v2, `CONTACT_STORE` con el gate exacto, snapshots canónicos, rechazo de un slot no ofertado, rechazo de ledger sin reserva real, identidades owner/node canónicas e históricas, producto/variant activo, evidencia física completa, bin/nodo, transferencia/readiness, rechazo de una identidad externa discordante, un balance certificado suficiente sin sumar lotes, quote transfer-ready sin slots que permanece `NO_SLOTS_FOR_SELECTED_LOCATION`, reserva atómica de capacidad/inventario, ledger `RESERVED`, paridad física exacta contra la evidencia del quote, rechazo de sustitución por otro contenedor certificado, persistencia/auditoría/inmutabilidad de las decisiones de order location y allocation, orden global de locks, reloj de pared posterior a esperas, rechazo fail-closed de evidencia pendiente de auditoría, rechazo de cierre con hold activo, release sincronizado, ledger `RESERVATION_RELEASED`, restauración del balance y cierre posterior del slot.

PGlite valida que el SQL sea reproducible y que esas restricciones funcionen en el fixture aislado. **No certifica** carreras concurrentes reales, orden/contención de locks, privilegios/roles, extensiones y configuración del servicio, duración de migraciones ni comportamiento operacional de PostgreSQL administrado. En esta corrida se ejecutó además `prisma migrate deploy` y `npm run verify:db:v4` contra la base configurada; eso certifica el nivel de migración y el estado seguro observado, pero no sustituye pruebas concurrentes ni operativas.

La última verificación de lectura de la base configurada, después de aplicar las 15 migraciones, confirmó que:

- la política y el conjunto de zonas continúan `DRAFT / STAGING`;
- existen exactamente 10 tiers y el último permanece abierto;
- existen 5 zonas y 6 candidatos (dos para `10075`);
- geometrías, días activos, prioridades, TTL y buffers siguen sin configurar para publicación;
- las cuatro feature flags están en `false`;
- no existen publicaciones V4, quotes V2, holds ni reservations creados por la migración.

Ese estado debe volver a verificarse después de cada deploy y antes de cualquier aprobación; el script es deliberadamente fail-closed si aparecen publicaciones o escrituras V4 inesperadas.

## Bloqueadores oficiales para habilitar STAGING

Todos son obligatorios:

| Integración pendiente | Estado actual seguro |
| --- | --- |
| Lectura de policy/zonas | Provider Prisma fail-closed implementado y probado para la publicación V4 exacta; permanece desconectado. |
| Persistencia de quotes | Adapter Prisma implementado y probado de forma focalizada, pero no conectado al endpoint. |
| Persistencia de holds | Adapter Prisma, worker y allocation conservador implementados/probados; falta aprobación comercial y conexión certificada. |
| Geocoding, zona, routing, inventario y slots | Puertos definidos, proveedores reales no conectados. |
| Verificador/issuer M2M | No configurado; todas las rutas devuelven `M2M_AUTH_NOT_CONFIGURED` y sus errores internos no se reflejan al cliente. |
| Composición del runtime | Guard central fail-closed implementado; no existe una rama READY hasta certificar todas las integraciones reales. |

1. aprobación comercial de la tabla V4, prioridad de tiendas y regla `Contact store`;
2. publicación auditable de la versión exacta de fee en STAGING;
3. GeoJSON oficial completo, digest y publicación de `upper-east-side-walking-zones-v1`;
4. identidades/coordenadas oficiales de `third_avenue` y `east_86th_street`;
5. emisor M2M aprobado, audience, scopes y rotación de secretos;
6. geocodificador aprobado con exact address, ambigüedad y jurisdicción Manhattan;
7. router walking aprobado, timeout/retry y un solo proveedor por comparación `10075`;
8. horarios, cutoff, buffers, capacidad por slot y fuente confiable de disponibilidad;
9. fuente de inventario con owner/node/bin/reserved/damaged y tiempos de transferencia;
10. aprobar `exact_physical_tuple_unique_sufficient_balance/v1`, instanciar los adapters Prisma y conectarlos mediante una composición certificada;
11. programar y observar el worker de expiraciones ya implementado, certificando restauración exactamente una vez en PostgreSQL administrado;
12. certificar concurrencia contra PostgreSQL administrado usando los locks y constraints ya instalados;
13. observabilidad sin PII, alertas, runbook y evidencia end-to-end del storefront.

## Gates para producción

STAGING y PRODUCTION son aprobaciones separadas. Después de resolver los bloqueadores anteriores y completar la calibración en STAGING, producción todavía requiere:

- publicación explícita de versiones aprobadas y ventana efectiva;
- credenciales y feature flags exclusivas de producción;
- prueba de carga/concurrencia y reconciliación;
- validación de los casos reales con el proveedor elegido;
- plan de rollback que cierre el gate sin alterar quotes/órdenes históricas;
- aprobación comercial y operativa registrada en auditoría.

Hasta entonces, el comportamiento correcto de todos los endpoints desplegados es fail-closed; no deben existir tarifas, rutas, slots ni holds estimados por fallback.
