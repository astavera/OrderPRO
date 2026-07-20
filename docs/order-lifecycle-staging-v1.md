# Order lifecycle STAGING v1

Status: design contract for a controlled STAGING pilot. This document does not enable Local Delivery V4, authorize production traffic, capture real payments, or activate Square writes.

## Purpose

This document defines the minimum checkout and order flow needed to connect a storefront page to OrderPRO Local Delivery V4 in STAGING:

```text
storefront browser
  -> storefront backend
  -> OrderPRO quote
  -> capacity + inventory hold
  -> external payment/order decision
  -> confirm or release
  -> fulfillment intake and execution
```

The browser is only a presentation surface. Machine credentials, access tokens, provider keys, inventory decisions, route metrics, fees, slot capacity, and hold mutations remain server-side.

## Current implementation boundary

### Implemented, but still fail-closed

- The versioned V4 HTTP contracts exist at:
  - `POST /api/v1/local-delivery/quote`
  - `POST /api/v1/local-delivery/holds`
  - `POST /api/v1/local-delivery/holds/{holdId}/confirm`
  - `POST /api/v1/local-delivery/holds/{holdId}/release`
- Quote application logic validates the request, geocodes through a port, checks Manhattan and supported ZIPs, evaluates a published polygon, selects a store, calculates trusted walking routes, applies the exact fee version, assesses inventory, filters slots, and persists an idempotent result.
- `CONTACT_STORE` is a persisted HTTP 200 result for an exact Manhattan address outside the five supported ZIP codes.
- Quote persistence has a Prisma adapter with serializable transactions and canonical policy, slot, inventory, and physical-evidence validation.
- Hold application logic uses the quoted TTL, capacity requirement, slot, inventory evidence, and an explicit versioned `orderLocationId` decision.
- Hold persistence has a Prisma adapter for atomic capacity and inventory reservation, idempotent replay, confirm, release, expiry, ordered locks, and exactly-once restoration.
- The conservative allocation strategy `exact_physical_tuple_unique_sufficient_balance/v1` exists and is tested.
- Auth0 token verification, scope checks, durable machine-client registry, correlation handling, and sanitized HTTP errors exist.
- The persisted capacity hold and inventory reservation lifecycle supports `HELD`, `CONFIRMED`, `RELEASED`, and `EXPIRED`.
- A fail-closed `POST /api/v1/local-delivery/auth-check` endpoint can verify the activated Auth0 client and both scopes without enabling quote or hold traffic.

### Not implemented or not connected

- The runtime intentionally has no READY branch. All four V4 routes currently return `503 M2M_AUTH_NOT_CONFIGURED`.
- The machine client, credential, and grants are approved but remain pending until the prepared forward-only activation is executed by an authenticated Owner.
- Real geocoder, Manhattan-jurisdiction, walking-router, polygon, inventory-assessment, slot-availability, and order-location providers are not wired.
- The V4 fee policy and zone set remain DRAFT/STAGING; official geometry, schedules, capacity, TTL, and buffers are not published.
- Prisma policy, quote, and hold adapters are not composed into the HTTP runtime.
- The allocation strategy still requires commercial approval and managed-PostgreSQL concurrency certification.
- The expiration worker method exists, but no production-like scheduler, alert, or runbook currently operates it.
- No OrderPRO `Order` aggregate, order table, order-intake API, fulfillment task queue, or delivery-status workflow exists.
- No page in this repository implements a customer checkout for V4.
- There is no V4 `GET hold/reservation status` endpoint. Creation and transitions can be recovered by idempotent retry, but a general external reconciliation read remains a contract decision.

## Trust and ownership boundaries

| Concern | Authority in this flow |
| --- | --- |
| Address entry and presentation | Storefront browser/page |
| M2M token acquisition and OrderPRO calls | Storefront backend only |
| Address normalization, Manhattan decision and coordinates | Approved server-side geocoder |
| Geographic eligibility and selected store | OrderPRO |
| Walking distance, duration and fee | OrderPRO using the approved router and published policy |
| Inventory readiness and physical evidence | OrderPRO |
| Available slots and remaining capacity | OrderPRO |
| Capacity and inventory reservation | OrderPRO hold transaction |
| Catalog, price, tax, payment and Square Order | External storefront/Square systems |
| Walking fulfillment execution and operational audit | Future OrderPRO order/fulfillment module |

The storefront must not send coordinates, route metrics, selected store, fee, eligibility, inventory owner/node, or slot capacity as trusted inputs.

## Minimum STAGING checkout flow

### 0. Preconditions

Before this flow is allowed to leave a test harness, all of the following must be true on the same reviewed release:

- Auth0 client, credential, and exact scopes are approved and activated for STAGING.
- The V4 runtime composition is certified and has a reviewed READY path.
- The official fee policy, zone set, store identities, geometry, slot policy, and effective windows are published in STAGING.
- Real geocoder, walking router, inventory, slots, order-location resolver, Prisma stores, and expiry worker are connected.
- V4 database write flags are enabled only as required by the certified flow.
- The storefront uses a server-side secret manager; no token or Client Secret reaches browser JavaScript.
- Test/Sandbox payment behavior is selected explicitly. This document does not authorize real capture.
- Monitoring can correlate by deployment, client key, checkout attempt, OrderPRO correlation ID, quote ID, and hold ID without logging full addresses or authorization headers.

### 1. Create a checkout attempt

The storefront backend creates a durable `checkoutAttemptId` before calling OrderPRO. It stores:

- cart revision or hash;
- requested delivery date;
- current customer session/cart reference;
- lifecycle state;
- operation-specific idempotency keys and correlation IDs;
- later quote, hold, payment, and order mappings.

The `checkoutAttemptId` is a storefront identifier. V4 does not currently accept it as a body field, so the storefront binds it to its own record and may derive safe idempotency keys from it.

### 2. Request a quote

The storefront backend calls:

```http
POST /api/v1/local-delivery/quote
Authorization: Bearer <server-side STAGING access token>
Idempotency-Key: quote:<checkoutAttemptId>:<cartRevision>
X-Correlation-ID: <new quote correlation ID>
Content-Type: application/json
```

The body contains only:

- `address`;
- `cartLines` with `variantId` and `quantity`;
- `requestedDate`.

The storefront persists the exact request hash, idempotency key, correlation ID, returned `quoteId`, `expiresAt`, selected external location, policy versions, fee, eligibility, bookability, and returned slots.

The page branches as follows:

| Quote result | Page behavior |
| --- | --- |
| `eligible: true`, `bookable: true` | Show exact fee and only returned slots. Allow hold creation before quote expiry. |
| `eligible: true`, `bookable: false`, `NO_SLOTS_FOR_SELECTED_LOCATION` | Show no availability. Do not switch stores and do not create a hold. |
| `CONTACT_STORE` | Show the exact customer message `Contact store`. Do not show fee, route, store, or slots. |
| Validation or geographic 422 | Ask the customer to correct the address or choose another fulfillment mode. |
| Dependency 503 | Do not fabricate route, fee, inventory, or slots. Offer retry or another fulfillment method. |

A repeated quote request uses the same key and identical payload. A changed address, cart, quantity, or requested date creates a new cart revision and a new quote idempotency key.

### 3. Acquire capacity and inventory

After the customer selects a returned slot, the storefront backend calls:

```http
POST /api/v1/local-delivery/holds
Authorization: Bearer <server-side STAGING access token>
Idempotency-Key: hold:<checkoutAttemptId>:<quoteId>:<slotId>
X-Correlation-ID: <new hold correlation ID>
Content-Type: application/json

{
  "quoteId": "<quoteId>",
  "slotId": "<slotId>"
}
```

On success it stores, in one checkout-attempt record:

- `quoteId`;
- `slotId`;
- `capacityHoldId`;
- `inventoryReservationId`;
- `expiresAt`;
- original hold correlation ID;
- hold idempotency key;
- current hold status.

Quote creation does not reserve resources. Only hold creation reserves capacity and inventory atomically.

### 4. Create the external order and make the payment decision

The storefront must obtain one stable external `orderId` before confirming the hold. The exact system that creates this ID remains a pending decision; candidates include the e-commerce order ID or a namespaced stable ID that later maps to Square.

The STAGING sequence is:

1. Verify the hold is still within its server-provided expiry.
2. Create or update the external draft order and persist its mapping to the checkout attempt.
3. Start the approved sandbox payment authorization/order operation.
4. Persist the payment decision durably before calling confirm or release.
5. Never create a second hold merely because a payment or network response was lost.

`orderId` must be stable across retries. It must not be a payment attempt ID that changes on every retry.

### 5. Confirm after a successful order/payment decision

When the external decision is durably successful, call:

```http
POST /api/v1/local-delivery/holds/{holdId}/confirm
Authorization: Bearer <server-side STAGING access token>
X-Correlation-ID: <new confirmation correlation ID>
Content-Type: application/json

{
  "orderId": "<stable external order ID>"
}
```

Retry a lost confirmation response with the same `holdId` and exact same `orderId`. The expected idempotent result is the existing confirmed hold with `changed: false`.

Payment success plus an unresolved confirm is a reconciliation incident. Do not automatically release, refund, create another hold, or dispatch fulfillment until confirmation is reconciled.

### 6. Release after a failed or abandoned pre-confirmation checkout

If payment/order creation fails, the customer cancels before confirmation, or the checkout is deliberately abandoned, call:

```http
POST /api/v1/local-delivery/holds/{holdId}/release
Authorization: Bearer <server-side STAGING access token>
X-Correlation-ID: <new release correlation ID>
Content-Type: application/json

{
  "reason": "PAYMENT_FAILED"
}
```

Caller-selectable reasons are:

- `PAYMENT_FAILED`;
- `ORDER_CANCELLED`;
- `MANUAL`.

Retry a lost release response with the same hold ID and same reason. A contradictory transition must not be forced.

The current hold model does not permit release of a `CONFIRMED` hold. Cancellation after confirmation belongs to the future order cancellation, refund, inventory, and capacity-compensation workflow.

### 7. Expire abandoned holds

OrderPRO's expiration worker transitions overdue `HELD` records to `EXPIRED` with the internal reason `QUOTE_EXPIRED` and restores capacity and inventory exactly once.

The storefront timer is presentational only. It must not be the authority that restores resources. After a client-side timeout, the backend reconciles or retries the same operation; it does not assume release succeeded.

### 8. Create fulfillment work

A confirmed hold proves that capacity and inventory were reserved for an external order ID. It does not currently create an OrderPRO order or a store task.

Before a real operational pilot, a new, idempotent fulfillment-intake boundary must convert the confirmed mapping into durable work for the selected store. At minimum it must pin:

- the external e-commerce and Square identifiers available at intake;
- OrderPRO quote, hold, and inventory reservation IDs;
- selected delivery location;
- immutable policy and zone versions;
- customer-delivery data under an approved retention policy;
- order lines and quantities;
- requested slot;
- fulfillment state and version;
- audit and correlation evidence.

Until that boundary exists, the quote/hold flow may be tested as a checkout reservation pilot but must not be presented as complete walking fulfillment.

## Existing and proposed states

### States already implemented

| Resource | Existing states or outcomes |
| --- | --- |
| Quote | `eligible` / `bookable` plus stable reason codes, including `ELIGIBLE`, `TRANSFER_REQUIRED`, `NO_SLOTS_FOR_SELECTED_LOCATION`, and `CONTACT_STORE` |
| Capacity hold | `HELD`, `CONFIRMED`, `RELEASED`, `EXPIRED` |
| Inventory reservation | `HELD`, `CONFIRMED`, `RELEASED`, `EXPIRED` |

Capacity hold and inventory reservation must transition together. They are not two independent checkout controls.

### Storefront checkout-attempt states proposed for STAGING

These states are not currently OrderPRO database enums. They are the minimum storefront-side saga states recommended for integration:

| State | Meaning |
| --- | --- |
| `CREATED` | Durable checkout attempt exists. |
| `QUOTED` | A current quote was saved. |
| `HOLD_PENDING` | Hold request is in flight or its result is unknown. |
| `HELD` | Capacity and inventory are reserved. |
| `PAYMENT_PENDING` | External order/payment decision is in progress. |
| `CONFIRM_PENDING` | Payment/order succeeded; OrderPRO confirmation is not yet reconciled. |
| `CONFIRMED` | Hold is confirmed with the stable external order ID. |
| `RELEASE_PENDING` | Release is in flight or its result is unknown. |
| `RELEASED` | Hold and inventory reservation were released. |
| `EXPIRED` | OrderPRO expired the hold. |
| `MANUAL_REVIEW` | Payment, hold, mapping, or transition state is contradictory or unresolved. |

### Future OrderPRO order and fulfillment states

These are design placeholders, not implemented contracts:

```text
ACCEPTED -> PICKING -> PACKED -> OUT_FOR_DELIVERY -> DELIVERED
    |          |          |              |
    +----------+----------+--------------+-> EXCEPTION
    +-------------------------------------> CANCELLED
```

Cancellation rules, reversals, and allowed transitions require a separate versioned order-state review.

## Identifier and idempotency rules

| Identifier | Created by | Rule |
| --- | --- | --- |
| `clientId` | OrderPRO M2M authentication | Derived from the verified token and registry; never trusted from request JSON. |
| `checkoutAttemptId` | Storefront backend | One durable checkout saga; never reused for an unrelated cart. |
| `Idempotency-Key` for quote | Storefront backend | Same key only for the identical address/cart/date/environment request. |
| `quoteId` | OrderPRO | Persist with the checkout attempt; do not guess or recreate. |
| `slotId` | OrderPRO | Must come from that quote and selected store. |
| `Idempotency-Key` for hold | Storefront backend | Same key only for identical quote and slot. |
| `capacityHoldId` | OrderPRO | Primary reservation transition ID. |
| `inventoryReservationId` | OrderPRO | Persist for reconciliation; paired atomically with the hold. |
| `orderId` on confirm | External order authority | Stable across retries and unique to the order, not the payment attempt. |
| `ecommerceOrderId` | E-commerce | Future mapping field; source of truth decision pending. |
| `squareOrderId` | Square | Future mapping field; Square writes remain separately gated. |
| `orderProOrderId` | Future OrderPRO order intake | Does not exist yet. |
| `X-Correlation-ID` | Calling backend per operation | New for each quote, hold, confirm, or release operation; safe for logs. |

The original quote/hold correlation ID is immutable. Confirm and release use their own transition correlation IDs and must not overwrite creation evidence.

## Failure and reconciliation matrix

| Failure | Required behavior |
| --- | --- |
| Quote request times out | Retry the same request with the same quote idempotency key. Do not issue a changed request under that key. |
| Quote returns dependency 503 | Do not fabricate fee, route, slots, or store. Retry later or offer another fulfillment method. |
| Quote expires before hold | Request a new quote with a new quote idempotency key/revision. |
| Hold request times out | Retry identical quote/slot with the same hold idempotency key. Do not create another hold. |
| Payment fails while hold is HELD | Release with `PAYMENT_FAILED`; retry the same release if its response is lost. |
| Customer cancels while hold is HELD | Release with `ORDER_CANCELLED`. |
| Hold expires during payment | Stop automatic fulfillment. Void or reconcile the payment according to the approved payment policy. |
| Payment succeeds and confirm times out | Retry confirm with the same hold ID and order ID; enter `CONFIRM_PENDING` until reconciled. |
| Confirm reports expired/invalid after payment success | Enter `MANUAL_REVIEW`; do not silently create a replacement hold or dispatch. Apply the approved void/refund procedure. |
| Release and confirm race | Accept only the state returned by OrderPRO; contradictory intent becomes manual review. |
| Cancellation occurs after CONFIRMED | Do not call the current release endpoint as compensation. Use the future order cancellation/refund/restock workflow. |
| Expiry worker is delayed | Alert and run the idempotent worker; do not directly edit hold, reservation, capacity, or ledger rows. |
| Storefront loses all local state | A V4 read/reconciliation endpoint or privileged operational recovery procedure is required before launch. |
| OrderPRO is unavailable after confirmation | Preserve the confirmed mapping and retry fulfillment intake idempotently when the service returns. |

## Fastest safe delivery path

1. Build an internal STAGING calibration page first. It must be human-authenticated, clearly labeled non-customer, use approved test addresses/cart fixtures, and perform no payment or Square write.
2. Connect and certify the real geocoder and one walking router with timeout, retry, provider identity, Manhattan decision, and `10075` same-provider enforcement.
3. Import and publish official GeoJSON plus the exact V4 fee/slot configuration through an audited forward-only STAGING change.
4. Implement the missing polygon, inventory, slot, and order-location adapters; instantiate the existing Prisma quote and hold stores.
5. Certify M2M activation and a real runtime composition while all production gates remain closed.
6. Exercise quote-only E2E from a storefront backend. Do not expose a token to the page.
7. Add hold acquisition, expiry scheduling, managed-PostgreSQL concurrency tests, and reconciliation.
8. Use sandbox order/payment identifiers to test confirm and release.
9. Add the minimum OrderPRO fulfillment-intake record and store queue before calling the flow operational.
10. Treat production as a separate release, credential, data, load, rollback, and commercial approval.

## Decisions required before implementation is complete

- Which system creates the stable `orderId` used by confirm, and at what exact point?
- Will STAGING confirm after payment authorization, after capture, or after Square Order creation?
- What compensation is mandatory when payment succeeds but hold confirmation fails or expires?
- What is the durable mapping among checkout attempt, e-commerce order, Square Order, payment attempt, OrderPRO quote, hold, reservation, and future OrderPRO order?
- Is a V4 `GET hold/status` endpoint required, or will reconciliation use another reviewed interface?
- What is the commercially approved quote TTL, hold TTL, slot length, capacity model, buffers, hours, cutoff, holiday calendar, and overbooking rule?
- Which official geocoder, walking router, geometry source, and provider timeout/retry policies are approved?
- What inventory source and reconciliation prove owner, node, bin/container, damage, reservation, and transfer readiness?
- Is `exact_physical_tuple_unique_sufficient_balance/v1` approved for the initial product set?
- What is the versioned rule for resolving `orderLocationId` when commercial owner and delivery location differ?
- What customer address fields may OrderPRO retain, for how long, and how are logs redacted?
- Who owns expiry-worker alerts, payment/hold reconciliation, dead letters, and manual review?
- What are the allowed post-confirm cancellation, refund, inventory release/restock, and capacity compensation transitions?
- What store roles and UI receive picking, packing, out-for-delivery, delivered, and exception work?
- Which fulfillment events become stable external contracts, and what subscriber/replay policy applies?
- What load, race, provider-failure, and rollback evidence is required before production?

## Exit criteria for a STAGING pilot

The minimum STAGING pilot is complete only when:

- the exact reviewed release and database migration state are recorded;
- all real dependencies pass fail-closed readiness checks;
- quote, hold, confirm, release, expiry, and idempotent replay pass E2E;
- managed PostgreSQL demonstrates no double capacity or inventory allocation under concurrency;
- payment success/failure and lost-response scenarios reconcile without duplicate holds or orders;
- the selected store receives durable, auditable fulfillment work;
- customer data and credentials are absent from ordinary logs;
- M2M, V4, database write, Square, and production gates can be closed independently;
- rollback closes traffic without mutating historical quotes, holds, reservations, orders, or audit evidence;
- an Owner and the operational owners record explicit STAGING approval.
