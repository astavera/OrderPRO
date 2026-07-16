# Walking route distance standard

Status: `DRAFT_CALIBRATION_V1`. This is a reviewable contract fixture, not an approved production fee policy or a runtime-readiness statement.

Last reviewed: 2026-07-16.

## Safety and ownership boundary

`POST /v1/walking-delivery/quotes` is the versioned server-side quote operation. Its route and contract exist, but runtime evaluation remains `dependency-blocked` until all of the following are configured and certified together:

- Machine-to-machine authentication with both `walking-zones:read` and `availability:read` scopes.
- An approved server-side geocoder.
- An approved server-side routing provider using the `walking` profile.
- Official reviewed Polygon/MultiPolygon geometry.
- Published immutable zone and fee-policy versions.
- A live slot/capacity service.
- An independent external quote feature gate.

The browser and caller submit only `address`, `serviceAt`, and `subtotalCents`. They do not submit coordinates, route distance, route duration, selected store, fee, tier, or slot availability. Those facts must be derived by trusted server-side dependencies. The response identifies the actual configured routing provider; the contract deliberately does not choose one.

The quote is not a slot hold. Returned slots are informational live availability until a separate reservation operation succeeds.

## Assignment before pricing

Official point-in-polygon geometry is the eligibility boundary. ZIP codes are labels and candidate filters; they cannot prove that an address is inside a service area.

The currently confirmed assignment labels are:

| Postal label | Assignment | Candidate locations |
| --- | --- | --- |
| `10021` | `FIXED` | `store-3rd-avenue` |
| `10065` | `FIXED` | `store-3rd-avenue` |
| `10028` | `FIXED` | `store-86th-street` |
| `10128` | `FIXED` | `store-86th-street` |
| `10075` | `NEAREST_WALKING_ROUTE` | `store-3rd-avenue`, `store-86th-street` |

For `10075`, compare every candidate using trusted walking route distance, then trusted walking duration, then stable `locationId`. Pricing is applied only after a store is selected. A cheaper fee never changes the selected store.

The statement that the 86th Street service area may extend north to 96th Street is not geometry. Its exact north boundary and the rest of the official Polygon/MultiPolygon remain pending; no street line, ZIP boundary, screenshot, or hand-drawn approximation may be activated as a substitute.

## Draft calibration tiers

The `WALKING_ROUTE_DISTANCE_STANDARD` policy is versioned as `DRAFT_CALIBRATION_V1` and uses the trusted route distance in feet:

OrderPRO converts provider meters to feet and normalizes the auditable value to two decimal places before tier classification; the classified value and the persisted `distanceFeet` are therefore identical.

| Tier ID | Distance | Automatic fee |
| --- | ---: | ---: |
| `UP_TO_1200_FT` | `0 <= distanceFeet <= 1200` | `$0.00` (`0` cents) |
| `UP_TO_2300_FT` | `1200 < distanceFeet <= 2300` | `$10.00` (`1000` cents) |
| `UP_TO_3250_FT` | `2300 < distanceFeet <= 3250` | `$15.00` (`1500` cents) |
| `OVER_3250_FT_MANAGER_REVIEW` | `distanceFeet > 3250` | `MANAGER_REVIEW`; `feeCents: null` |

The boundaries are exact and inclusive on each upper limit. Non-finite, negative, or otherwise invalid route metrics are invalid input, not a manager-review quote.

This draft standard contains no avenue surcharge and does not import the historical street/avenue or balloon-delivery matrix. In particular, it does not add fees based on 1st, 2nd, 3rd, Lexington, or Park Avenue and does not activate a historical free-delivery exception. Any future modifier requires an explicitly approved, versioned fee-policy change.

## Slots and no-fallback rule

After assignment and fee evaluation, OrderPRO queries slots for `selectedLocationId` only. Every returned slot must carry that same stable location ID.

If the selected store has no slots:

- Return `eligible: false` and `reasonCode: NO_AVAILABLE_SLOTS`.
- Return `slots: []`.
- Preserve the selected location and calculated tier/fee for audit.
- Do not query another candidate as an automatic fallback.
- Do not recalculate the quote using another store.

If distance exceeds 3,250 feet, return `MANAGER_REVIEW` with the structural tier `OVER_3250_FT_MANAGER_REVIEW`, no automatic fee and no slots. Retaining the tier ID preserves the exact classification used by the quote; manager review is not authorization to fabricate a fee or bypass geometry/capacity checks.

## Versioned quote contract

The OpenAPI operation is in [orderpro-walking-zones-v1.yaml](openapi/orderpro-walking-zones-v1.yaml), and its response schema is [walking-delivery-quote-v1.schema.json](schemas/walking-delivery-quote-v1.schema.json).

Every request requires `Idempotency-Key` and `X-Correlation-ID`. The key is scoped to the authenticated machine client and operation. An identical retry returns the original calculated response; reuse with different semantic content returns `409 IDEMPOTENCY_CONFLICT`. Idempotency does not create a slot hold.

A successful HTTP response can still represent a non-offer through `MANAGER_REVIEW` or `NO_AVAILABLE_SLOTS`. Missing M2M, geocoder, router, official geometry, published policy, or live slot capability is different: return `503 DEPENDENCY_BLOCKED` and do not synthesize a quote.

The quote response always records:

- An immutable quote ID and whether the response is an idempotent replay.
- The provider-normalized address and customer coordinates.
- Postal code and exact selected stable location ID.
- Exact immutable zone and fee-policy version IDs.
- Actual routing provider, `walking` profile, distance and duration.
- Structural tier ID for every quote, nullable fee, stable reason code and calculation time.
- Slots belonging only to the selected store.
- Correlation ID.

Addresses and coordinates are customer data. Keep them out of ordinary logs and audit summaries; retain only the minimum evidence approved by the pending data-retention policy.

## Contract fixtures

The named `eligible`, `managerReview`, and `noSlots` examples are embedded in both the OpenAPI operation and the quote JSON Schema. Their addresses, coordinates, providers, IDs, timestamps, and slots are synthetic fixtures. They do not establish official geometry, select a vendor, approve a service date, or prove runtime availability.

## Publication dependency

`DRAFT_CALIBRATION_V1` cannot be promoted merely because its pure boundary tests pass. Its audited STAGING approval requires an Owner, active grants for both stores, the `walking_fee_policy.admin` and `walking_fee_policy.staging_publish` gates, exact policy validation, an immutable snapshot/digest, audit evidence, and a transactional outbox event. Zone publication remains separately controlled by `walking_delivery.publish`; production fee publication by `walking_fee_policy.publish`; quote persistence, API access, and external delivery all remain independently gated after publication.

Authorized operators review and approve this policy at `/operations/fulfillment/fee-policies/WALKING_ROUTE_DISTANCE_STANDARD`. Approval requires a 10–500 character reason and the exact confirmation phrase shown by the UI; it creates a new immutable publication and never edits an already-published version.
