# Fulfillment and walking delivery architecture

Status: staged design contract. This document does not certify production readiness.

Last reviewed: 2026-07-16.

## Safety boundary

OrderPRO is the operational source of truth for inventory, reservations, fulfillment execution, walking-zone configuration, publication history and operational audit. The e-commerce remains responsible for the storefront, cart, checkout presentation and its local copy of the last valid published snapshot. The versioned OrderPRO server-side walking quote route remains dependency-blocked; until it is certified, neither system may fabricate routing, fee or slot results. Square remains responsible for catalog, price, tax, payments, Square Orders and financial reporting.

The existence of a model, page, endpoint or contract does not enable production traffic. Production use additionally requires deployed migrations, reviewed feature flags, machine-to-machine authentication, confirmed commercial configuration, end-to-end tests and an explicit operational approval. In particular:

- `storefront.availability` must remain locked until inventory synchronization and reconciliation are certified.
- `square.production_writes` must remain locked; this delivery does not authorize Square writes.
- Walking-zone publication and external delivery must use independent gates.
- No configuration is published automatically after a draft save or validation.
- No process may write directly to the e-commerce database.

## Two distinct fulfillment paths

### Store-backed warehouse shipping

Store inventory may remain eligible for online sale after the destination store has received and activated it. A standard carrier order sourced from a store follows this path:

1. The checkout or order intake selects an eligible store-owned lot.
2. OrderPRO reserves the units immediately so they cannot also be sold in the store.
3. The store receives a retrieval task and places the units in a controlled pickup batch.
4. The units move from the store to the Englewood, New Jersey warehouse while remaining reserved.
5. The warehouse verifies the pickup batch, packs the order and hands it to the carrier.
6. The customer promise adds two business days to the normal warehouse-carrier promise.

The two-day adjustment is a policy value, not a complete promised-delivery calculator. An exact customer date also depends on a confirmed business calendar, pickup cadence, cutoff, holidays, carrier service and mixed-cart policy. Those inputs are not yet confirmed and must not be guessed.

Inventory traveling from the warehouse to a store is not online-eligible merely because its destination is a store. It becomes eligible only after receipt, reconciliation and activation at the store. Online availability should be computed from physical on-hand less reservations and a future product/location safety-stock policy.

### Walking local delivery

Walking delivery is fulfilled directly by the selected store and does not travel through the Englewood warehouse. Its target server-quote path is:

1. The e-commerce sends the exact customer address, requested service instant and subtotal to the versioned OrderPRO quote API using M2M authentication.
2. OrderPRO normalizes/geocodes the address and evaluates the point against the approved published Polygon or MultiPolygon snapshot.
3. It resolves overlapping zones by an explicit, deterministic priority.
4. A `FIXED` zone selects its sole configured store.
5. A `NEAREST_WALKING_ROUTE` zone compares server-trusted walking route metrics for all candidates.
6. The selected store's exact immutable fee-policy version is applied and live slots are read for that store only.
7. The e-commerce presents the quote and requests a capacity hold from OrderPRO for the selected slot.
8. Successful payment confirms the hold; failed or abandoned payment releases it.
9. The selected store picks, packs, dispatches and completes the walking delivery.

Walking assignment is never based only on ZIP-code center distance or on the cheapest fee. A ZIP is an index and label; point-in-polygon is the eligibility boundary. Candidate ordering is stable: shortest walking distance, then shortest walking duration, then stable location ID. If the selected store has no valid slot, the result is `NO_AVAILABLE_SLOTS`; the system does not silently switch stores.

`POST /v1/walking-delivery/quotes` and its `orderpro.walking-delivery-quote.v1` response are implemented behind a closed runtime gate. Evaluation requires independent external-quote gating, M2M authentication, an approved geocoder and walking router, official geometry, published fee configuration and live slot capacity. Missing dependencies return `503`; the current default is `M2M_AUTH_NOT_CONFIGURED`. The exact draft distance tiers and examples are documented in `walking-route-distance-standard.md`.

## Confirmed location assignments

The external integration identifiers are stable and do not depend on display names.

| Postal code | Strategy | Candidate location IDs |
| --- | --- | --- |
| `10065` | `FIXED` | `store-3rd-avenue` |
| `10021` | `FIXED` | `store-3rd-avenue` |
| `10075` | `NEAREST_WALKING_ROUTE` | `store-3rd-avenue`, `store-86th-street` |
| `10028` | `FIXED` | `store-86th-street` |
| `10128` | `FIXED` | `store-86th-street` |

Known store addresses are:

- `store-3rd-avenue`: 3rd Avenue Store, 1243 3rd Ave, New York, NY 10021.
- `store-86th-street`: 86th Street Store, 112 E 86th St, New York, NY 10028.

OrderPRO's internal `ST72`, `ST86` and `WH01` codes are operational labels, not the public integration contract. The stable external ID for WH01 is `warehouse-englewood`; its exact street address and coordinates remain pending.

No production geometry is included in this repository documentation. Approved official GeoJSON must be imported and reviewed; a screenshot or hand-traced approximation is not acceptable production evidence.

## Configuration lifecycle

### Draft

`DRAFT` is mutable administrative configuration. Saving a draft is idempotent, authorized, location-scoped and audited. Incomplete commercial values are allowed in a draft and must be shown as blockers. A save never changes the e-commerce snapshot.

### Validate

Validation is deterministic and produces stable reason codes. A valid result may move a draft to `VALIDATED`, but it does not publish it. A subsequent edit invalidates prior validation evidence and returns the configuration to `DRAFT`.

### Publish

Publication is a separate privileged command. It must:

1. Re-run all validation against the exact candidate content.
2. Claim an `Idempotency-Key` and reject the same key with different content.
3. Resolve and pin each durable `zoneVersionId`, `feePolicyVersionIdByLocation` and `slotPolicyVersionIdByLocation`.
4. Canonicalize the publication content.
5. Create a new immutable version and stable SHA-256 digest.
6. Set explicit effective dates.
7. Write audit evidence and a transactional outbox event in the same commit.
8. Leave prior versions immutable.

A published version is never edited or deleted. The snapshot schema is `orderpro.walking-zones.v1`; its JSON Schema is in `schemas/walking-zones-snapshot-v1.schema.json`.

### Digest and ETag

The publication digest covers the exact immutable content, including publication metadata and all zones, but excludes the `digest` property itself to avoid a recursive value. Serialize that object with JSON Canonicalization Scheme (RFC 8785), hash the UTF-8 bytes with SHA-256 and encode lowercase hexadecimal with the `sha256:` prefix. The response ETag is the quoted digest string. The webhook payload, response body and digest header must all carry the same digest.

Changing array order, geometry coordinates, policy references, effective dates, publication ID or version changes the digest. Implementations must use the canonicalizer; ordinary `JSON.stringify` output is not a cross-platform digest contract.

### Archive

Archiving removes a non-current version from future selection without deleting history. A version referenced by an order or audit record remains queryable. The currently effective version cannot be archived until a safe replacement is effective.

### Rollback

Rollback is an explicit privileged publication action, not an in-place database reversal. It copies a selected historical snapshot into a new version with a new publication ID, monotonically increasing version number, new digest, effective time, audit event and publication webhook. The target historical version is unchanged.

## Publication validation blockers

Publication must be rejected when any of these conditions exists:

- Missing, empty or corrupt GeoJSON.
- Geometry other than WGS84 Polygon or MultiPolygon.
- Unclosed rings, invalid longitude/latitude, excluded holes handled incorrectly or unacceptable self-intersection.
- A referenced location is missing, inactive or lacks a stable integration ID.
- `FIXED` has anything other than one candidate.
- `NEAREST_WALKING_ROUTE` has fewer than two candidates.
- Overlap priorities are ambiguous or nondeterministic.
- Required active days, effective dates, distance or route-time policy is incomplete.
- A candidate lacks a compatible fee policy or slot policy.
- A `DRAFT_INCOMPLETE` fee policy is referenced.
- A balloon-only draft is being used as `GENERAL_LOCAL_DELIVERY` without explicit approval.
- The digest does not match the exact canonical publication content.
- An idempotency key is reused with different content.
- The publication or external-delivery feature gate is locked.

The known Third Avenue amounts are balloon-delivery draft information only. They are not a confirmed general walking-delivery fee schedule. The 86th Street fee policy remains incomplete. No fee from those notes may be published as general local delivery without explicit confirmation.

## Human authorization

Human panel permissions are distinct from machine scopes:

| Role | View | Manage drafts | Publish | Rollback |
| --- | ---: | ---: | ---: | ---: |
| Owner | Yes | Yes | Yes | Yes |
| Operations admin | Yes | Yes | No | No |
| Inventory controller | Yes | No | No | No |
| Store manager | Yes | No | No | No |
| Warehouse manager | Yes | No | No | No |
| Auditor | Yes | No | No | No |
| Store staff | No | No | No | No |
| Warehouse staff | No | No | No | No |

Hiding a control in the browser is not authorization. Every Server Action and Route Handler must authenticate, authorize, validate untrusted input and apply the user's active location grants.

## Delivery phases

| Phase | Capability | Production status |
| --- | --- | --- |
| 1 | Human RBAC, draft configuration, readiness visualization and pure validation | Internal only; not a production quote source |
| 2 | GIS editor/import, deterministic preview, immutable versions, publish and rollback | Requires official geometry, policies and approval |
| 3 | Published snapshot API, server-side walking quotes, slots, capacity holds and reservations | Requires M2M auth, approved geocoder/router, official geometry, capacity rules and integration certification |
| 4 | Signed webhook delivery, replay worker and operational walking fulfillment | Requires secrets, subscribers, monitoring and runbooks |
| 5 | Store-backed inventory reservation, bulk retrieval to Englewood and customer promises | Requires catalog/lots, inventory mutations, pickup calendar and reconciliation |

Endpoints and schemas may be documented before their phase is implemented. Consumers must use the readiness matrix in `ecommerce-walking-integration.md` and must not infer availability from an HTTP route being present.

## Event catalog

Every event uses the common `orderpro.event.v1` envelope, unique `eventId`, occurrence time, correlation ID, entity ID/version and idempotent delivery. Only `orderpro.walking_zones.published` has an approved payload-specific v1 schema in this phase. The remaining names are reserved so teams do not create conflicting names; their payloads must not be integrated until a payload-specific schema is reviewed.

| Event type | Intended phase/status |
| --- | --- |
| `orderpro.walking_zones.published` | Payload-specific schema defined; delivery still Phase 4 dependency-blocked |
| `orderpro.inventory.changed` | Reserved for certified inventory availability integration |
| `orderpro.reservation.created` | Reserved for Phase 3 reservations |
| `orderpro.reservation.confirmed` | Reserved for Phase 3 reservations |
| `orderpro.reservation.released` | Reserved for Phase 3 reservations |
| `orderpro.reservation.expired` | Reserved for Phase 3 reservations |
| `orderpro.fulfillment.accepted` | Reserved for future fulfillment intake |
| `orderpro.picking.started` | Reserved for future fulfillment execution |
| `orderpro.order.packed` | Reserved for future fulfillment execution |
| `orderpro.shipping.label_created` | Reserved for future warehouse shipping |
| `orderpro.order.shipped` | Reserved for future warehouse shipping |
| `orderpro.order.out_for_delivery` | Reserved for future walking/local fulfillment |
| `orderpro.order.delivered` | Reserved for future fulfillment completion |
| `orderpro.fulfillment.exception` | Reserved for future operational exceptions |
| `orderpro.order.cancelled` | Reserved for future cancellation orchestration |

The generic catalog is `schemas/orderpro-webhooks-v1.schema.json`; transport signing is defined in `machine-to-machine-auth.md`.

## Pending commercial and operational decisions

- Official GeoJSON for each ZIP-labelled service area.
- Numeric zone priorities for any overlapping geometries.
- Confirmed general walking-delivery fee policy for Third Avenue.
- Complete fee ranges, limits, modifiers and exceptions for 86th Street.
- Active service days, holiday calendar, hours and cutoffs.
- Maximum walking distance and route duration.
- Minimum-order rules.
- Slot length, capacity model, hold lifetime and overbooking policy.
- Store pickup cadence and cutoff for the two-business-day shipping adjustment.
- Exact Englewood warehouse street address and coordinates.
- Product/location safety-stock rules.
- Mixed-cart behavior: one conservative promise or split shipments.
- Inventory-shortage reallocation policy; no silent fallback is assumed.
- Geocoder, walking-route provider, map editor and topology-validation library.
- OAuth issuer or approved HMAC alternative, rate limits and secret rotation cadence.
- Webhook subscriber URLs, retry schedule and dead-letter ownership.

Until these are resolved, the relevant configuration remains DRAFT or dependency-blocked.
