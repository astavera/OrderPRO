# E-commerce integration for walking delivery

Status: versioned integration contract. It is not evidence that the endpoints, credentials or production configuration are enabled.

The e-commerce consumes OrderPRO through versioned HTTP APIs and signed webhooks only. It must never read or write OrderPRO tables directly, and OrderPRO must never write the e-commerce database directly.

## System responsibilities

OrderPRO owns walking-zone drafts and versions, published snapshots, the dependency-blocked server-side walking quote, operational slot capacity, reservation holds, inventory reservations, fulfillment execution and audit. The e-commerce owns address collection, cart and checkout presentation, the request to hold a selected slot, and its local copy of customer-visible status. It may validate and evaluate a downloaded snapshot locally for parity or an approved last-valid fallback, but it must not fabricate route metrics, fees, or live slots. Square remains the financial source for catalog, prices, taxes, Orders and Payments.

This integration does not authorize payment capture, production Square Orders or Square price changes.

## Endpoint readiness matrix

`Contracted` means the shape is documented. `Dependency-blocked` means a caller must not use the operation until the named phase and configuration are approved.

| Operation | Required scope | Phase | Status/dependencies |
| --- | --- | --- | --- |
| `GET /v1/walking-zones` | `walking-zones:read` | 2 | Administrative read; human/admin M2M policy required |
| `GET /v1/walking-zones/{id}` | `walking-zones:read` | 2 | Administrative read |
| `POST /v1/walking-zones/drafts` | `walking-zones:write` | 1–2 | Draft only; requires configured locations |
| `PUT /v1/walking-zones/drafts/{id}` | `walking-zones:write` | 1–2 | Draft only; idempotency and expected version required |
| `DELETE /v1/walking-zones/drafts/{id}` | `walking-zones:write` | 2 | Draft only; audit and reference checks required |
| `POST /v1/walking-zones/drafts/{id}/validate` | `walking-zones:write` | 2 | Requires GIS and policy validators |
| `POST /v1/walking-zones/drafts/{id}/preview-address` | `walking-zones:write` | 2 | Requires geocoder, route provider and a draft; never a checkout quote |
| `POST /v1/walking-zones/drafts/{id}/publish` | `walking-zones:publish` | 2 | Locked until commercial approval and publication gate |
| `GET /v1/walking-zones/versions` | `walking-zones:read` | 2 | Immutable history read |
| `GET /v1/walking-zones/versions/{id}` | `walking-zones:read` | 2 | Immutable history read |
| `POST /v1/walking-zones/versions/{id}/rollback` | `walking-zones:rollback` | 2 | Privileged new publication; never an in-place edit |
| `POST /v1/walking-zones/versions/{id}/archive` | `walking-zones:publish` | 2 | Cannot remove order/audit history |
| `GET /v1/walking-zones/published` | `walking-zones:read` | 3 | Checkout bootstrap; requires an approved publication |
| `GET /v1/walking-zones/published/{versionNumber}` | `walking-zones:read` | 3 | Immutable snapshot by version |
| `POST /v1/walking-delivery/quotes` | `walking-zones:read` + `availability:read` | 3 | Dependency-blocked by M2M auth, approved geocoder/router, official geometry, published fee policy and live slots |
| `GET /v1/availability/slots` | `availability:read` | 3 | Requires confirmed slot/capacity policy and live capacity service |
| `POST /v1/reservations` | `reservations:write` | 3 | Requires slot service and configured hold policy |
| `GET /v1/reservations/{id}` | `reservations:write` | 3 | Checkout recovery and reconciliation |
| `POST /v1/reservations/{id}/confirm` | `reservations:write` | 3 | Called after successful payment/order decision |
| `POST /v1/reservations/{id}/release` | `reservations:write` | 3 | Called after failure, cancellation or abandonment |

The complete provisional surface is in `openapi/orderpro-walking-zones-v1.yaml`. The machine authentication mechanism, issuer and client credentials must be configured before any M2M call.

## Snapshot bootstrap and refresh

1. Fetch `GET /v1/walking-zones/published` using M2M credentials.
2. Validate the response against `schemas/walking-zones-snapshot-v1.schema.json`.
3. Remove only the top-level `digest` property, canonicalize the remaining snapshot with RFC 8785 JSON Canonicalization Scheme and verify the lowercase `sha256:` SHA-256 digest.
4. Persist the snapshot atomically as a new local candidate.
5. Make it current only after schema, digest and effective-date validation succeeds.
6. Retain the previous valid snapshot for fallback and audit.
7. Save the response `ETag`; later requests may send `If-None-Match`.

The e-commerce must reject an unknown `schemaVersion`, a digest mismatch, invalid geometry, missing durable `zoneVersionId`/policy-version references, or a publication with an invalid effective window. It must never discard its last valid snapshot merely because a new download fails validation.

When OrderPRO is temporarily unavailable, checkout may retain the last locally stored valid snapshot for approved fallback behavior, subject to an e-commerce staleness policy that is still pending approval. A cached snapshot is not live routing, fee, slot or hold evidence. Live quotes, slots and holds cannot be fabricated during that outage.

## Server-side quote contract

`POST /v1/walking-delivery/quotes` accepts only `address`, `serviceAt` and `subtotalCents`, plus required machine authentication, `Idempotency-Key` and `X-Correlation-ID` headers. The caller must not submit coordinates, route metrics, selected store, fee or slot availability.

When eventually enabled, OrderPRO will normalize/geocode the address, evaluate official geometry, select a store, obtain server-trusted `walking` route metrics, apply `WALKING_ROUTE_DISTANCE_STANDARD` `DRAFT_CALIBRATION_V1`, and return live slots for the selected store only. The response pins the exact zone and fee-policy version IDs and records the actual configured routing-provider ID.

The draft distance tiers are `0..1200 ft = $0`, `>1200..2300 ft = $10`, and `>2300..3250 ft = $15`. More than `3250 ft` returns `MANAGER_REVIEW` with `tierId: OVER_3250_FT_MANAGER_REVIEW`, a null fee and no slots. The policy has no avenue surcharge and does not reuse the historical balloon/street matrix. The possible 96th Street north boundary remains pending official geometry.

This route is a contract only. Missing M2M authentication, approved geocoder/router, official geometry, published fee configuration or live slot service returns `503 DEPENDENCY_BLOCKED`; OrderPRO must not substitute guessed data. See `walking-route-distance-standard.md` and `schemas/walking-delivery-quote-v1.schema.json`.

## Local snapshot evaluation

Local evaluation remains useful for snapshot validation, parity testing and an explicitly approved last-valid fallback. It is not by itself a live server quote. The e-commerce evaluates a published snapshot locally in this order:

1. Normalize and geocode the exact address using the approved provider.
2. Validate longitude, latitude, postal code and service date/time.
3. Use postal code only to narrow candidates.
4. Run boundary-inclusive point-in-polygon against each candidate geometry; polygon holes are excluded.
5. Filter by effective window and active service day.
6. Resolve overlaps by explicit zone priority. Ambiguous priority is an invalid publication, not a runtime coin toss.
7. For `FIXED`, use the sole configured location.
8. For `NEAREST_WALKING_ROUTE`, obtain walking metrics for every configured candidate from an approved server-side route service.
9. Sort by distance, duration and stable `locationId`.
10. Enforce configured distance, route-time and minimum-order rules.
11. Resolve the selected location's exact immutable fee- and slot-policy version references.
12. Ask OrderPRO for a server quote or, where separately certified, for that location's available slots.

The browser must not be trusted to provide the point, route metrics, fee, selected location or eligibility result. These inputs must be derived or verified by trusted e-commerce/OrderPRO services.

`10028` always uses `store-86th-street` when its approved polygon contains the point, even if Third Avenue has a shorter walking route. `10075` compares the walking route for both confirmed candidates.

## Slot hold flow

1. Query slots for the selected location and the exact zone publication/version used at checkout.
2. Show only returned slots; do not synthesize capacity.
3. Create a reservation hold with a unique `checkoutAttemptId` and `Idempotency-Key`.
4. Store `orderProReservationId`, expiration and correlation ID with the checkout attempt.
5. On successful payment/order creation, confirm the reservation idempotently.
6. On failed payment, cancellation or abandonment, release it idempotently.
7. If the client loses the response, call `GET /v1/reservations/{id}` or retry with the same idempotency key.

The hold lifetime is intentionally not specified here because it has not been commercially approved. The e-commerce must use the server-provided expiration and must not hard-code one.

No available slot at the selected store returns `NO_AVAILABLE_SLOTS`. It does not authorize switching to another candidate store silently.

### Provisional slot endpoint example

This contract fixture demonstrates an empty result and does not establish a production service date, operating schedule or capacity rule.

```http
GET /v1/availability/slots?locationId=store-3rd-avenue&serviceDate=2026-07-20&orderProZoneVersionId=zonev_staging_1 HTTP/1.1
Authorization: Bearer <staging-access-token>
X-Correlation-ID: cor_staging_slots_1
```

```json
{
  "locationId": "store-3rd-avenue",
  "serviceDate": "2026-07-20",
  "orderProZoneVersionId": "zonev_staging_1",
  "slots": [],
  "reasonCode": "NO_AVAILABLE_SLOTS",
  "correlationId": "cor_staging_slots_1"
}
```

### Provisional reservation endpoint example

These timestamps and IDs are staging fixtures only. Their difference does not define the hold lifetime.

```http
POST /v1/reservations HTTP/1.1
Authorization: Bearer <staging-access-token>
Content-Type: application/json
Idempotency-Key: checkout_staging_1_hold
X-Correlation-ID: cor_staging_hold_1

{
  "checkoutAttemptId": "checkout_staging_1",
  "locationId": "store-3rd-avenue",
  "slotId": "slot_staging_1",
  "orderProZoneVersionId": "zonev_staging_1",
  "ecommerceOrderId": null
}
```

```json
{
  "data": {
    "orderProReservationId": "reservation_staging_1",
    "checkoutAttemptId": "checkout_staging_1",
    "locationId": "store-3rd-avenue",
    "slotId": "slot_staging_1",
    "orderProZoneVersionId": "zonev_staging_1",
    "ecommerceOrderId": null,
    "squareOrderId": null,
    "status": "HELD",
    "expiresAt": "2026-07-20T18:15:00Z",
    "version": 1,
    "createdAt": "2026-07-20T18:00:00Z",
    "updatedAt": "2026-07-20T18:00:00Z"
  },
  "correlationId": "cor_staging_hold_1"
}
```

## Store-backed carrier shipping

Walking delivery and standard carrier shipping are separate offers. If an online item is physically active at a store and the customer chooses carrier shipping, OrderPRO reserves it at that store, retrieves it to the Englewood warehouse and processes it there. The standard warehouse delivery promise receives a two-business-day adjustment.

Do not apply the adjustment to walking delivery. Do not show an exact adjusted date until the pickup calendar, cutoff, holidays and mixed-cart behavior are configured. The storefront availability integration also remains gated until the product/location inventory feed is reconciled.

## Reason codes

Integrations branch on stable reason codes, not user-facing text:

- `ELIGIBLE`
- `INVALID_INPUT`
- `INVALID_ADDRESS`
- `GEOCODING_FAILED`
- `AMBIGUOUS_ADDRESS`
- `OUTSIDE_WALKING_ZONE`
- `NO_ACTIVE_ZONE`
- `SERVICE_DAY_UNAVAILABLE`
- `INVALID_ZONE_CONFIGURATION`
- `STORE_NOT_AVAILABLE`
- `ROUTE_METRICS_REQUIRED`
- `DISTANCE_EXCEEDED`
- `ROUTE_TIME_EXCEEDED`
- `MINIMUM_ORDER_NOT_MET`
- `FEE_POLICY_INCOMPLETE`
- `SLOT_POLICY_INCOMPLETE`
- `NO_AVAILABLE_SLOTS`
- `MANAGER_REVIEW`

New reason codes require a versioned contract review. Display text may be localized independently.

## Webhook consumption

The first fully defined outgoing webhook is `orderpro.walking_zones.published`. Other event names in the generic envelope schema are reserved for later fulfillment phases; their payloads are not yet stable integration contracts.

For each delivery:

1. Read the raw request bytes before JSON parsing.
2. Verify the configured signature and timestamp according to `machine-to-machine-auth.md`.
3. Reject an invalid signature or stale timestamp.
4. Deduplicate by `eventId` before applying side effects.
5. Validate the envelope schema and event-specific schema.
6. Download `snapshotUrl`; do not treat the webhook payload as the complete snapshot.
7. Verify snapshot schema and digest.
8. Persist and activate the new snapshot atomically.
9. Return success only after durable deduplication.

Event ordering is not assumed. `entityVersion` and snapshot `versionNumber` prevent an older replay from replacing a newer valid publication.

### Contract-valid publication envelope

This is a structural example only; it is not evidence of an emitted production event or an approved zone publication.

```json
{
  "eventId": "evt_01JZZZZZZZZZZZZZZZZZZZZZZZ",
  "schemaVersion": "orderpro.event.v1",
  "eventType": "orderpro.walking_zones.published",
  "occurredAt": "2026-07-20T18:00:00Z",
  "correlationId": "cor_01JZZZZZZZZZZZZZZZZZZZZZZZ",
  "entityId": "publication_4",
  "entityVersion": 4,
  "payload": {
    "publicationId": "publication_4",
    "versionNumber": 4,
    "schemaVersion": "orderpro.walking-zones.v1",
    "digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "snapshotUrl": "/v1/walking-zones/published/4"
  }
}
```

The event ID and digest above are example values. A real digest must be computed from the exact canonical snapshot content.

### Contract-valid API error envelopes

These examples contain no customer data and are safe contract fixtures:

```json
{
  "code": "FEE_POLICY_INCOMPLETE",
  "message": "The selected location does not have a publishable general local delivery fee policy.",
  "correlationId": "cor_01JZZZZZZZZZZZZZZZZZZZZZZZ",
  "details": [
    {
      "path": "feePolicyByLocation.store-86th-street",
      "reasonCode": "FEE_POLICY_INCOMPLETE"
    }
  ]
}
```

```json
{
  "code": "IDEMPOTENCY_CONFLICT",
  "message": "The idempotency key was already used with different content.",
  "correlationId": "cor_01JYYYYYYYYYYYYYYYYYYYYYYYYY",
  "details": []
}
```

## Retry and reconciliation

- Safe retries reuse the same `Idempotency-Key` and identical payload.
- A reused key with different content is a conflict and must not be retried as a new command automatically.
- Use exponential retry with jitter for transient `429` and `5xx` responses; concrete limits remain configuration-dependent.
- Do not retry validation, authorization or configuration errors without correcting the request or configuration.
- Reconcile the locally active publication ID/version against OrderPRO on a schedule defined before launch.
- Reconcile reservation state after checkout timeouts before creating another hold.
- Persist correlation IDs in both systems without logging authorization headers or full sensitive addresses.

## Integration decisions still required

- M2M issuer/token endpoint or approved signed-request alternative.
- Webhook subscriber URL, signing secret, replay window and rotation schedule.
- Rate limits, retry ceilings and dead-letter escalation.
- Snapshot staleness tolerance during OrderPRO outage.
- Official geometry and route/geocoding providers.
- Fees, slot policies, capacity and hold lifetime.
- Customer address retention/redaction policy.
- Store-backed pickup calendar, carrier cutoff and mixed-cart promise.
- Mapping between OrderPRO, e-commerce and future Square Order identifiers.

Production certification must test fixed assignments, nearest-route selection, boundary and hole behavior, deterministic ties, unavailable slots, idempotent holds, webhook replay and last-valid-snapshot fallback.
