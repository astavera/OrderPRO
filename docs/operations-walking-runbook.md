# Walking delivery operations runbook

Status as of July 20, 2026: pre-production operating procedure. STAGING M2M registry activation and Auth0 runtime enablement are complete, but Local Delivery V4 remains disabled and dependency-blocked. Steps marked dependency-blocked are not authorization to run them in production.

This runbook governs administrative configuration, publication, rollback and integration recovery for walking delivery. It does not cover payment capture, Square writes, driver dispatch optimization or automatic refunds.

## Roles and separation of duties

- Owners can view, manage, publish and roll back fulfillment configuration.
- Operations admins can view and manage drafts but cannot publish or roll back.
- Inventory controllers, store managers, warehouse managers and auditors have read-only visibility.
- Store and warehouse staff do not receive the configuration module in the initial policy.
- M2M clients use independent Auth0 STAGING identities and scopes and never a human session. Follow the [safe Auth0 onboarding route](auth0-m2m-staging-setup.md); never collect a Client Secret in OrderPro.

For production publication, use a prepared-by/reviewed-by process even where one Owner technically holds both permissions. The approver must not infer readiness from a green UI badge alone; retain validation evidence and the pending-decision checklist.

## Phase/readiness check

Before any procedure, identify the environment and phase:

| Capability | Minimum readiness |
| --- | --- |
| Save a draft | Internal draft feature enabled, authorized user, active location mappings |
| Validate geometry | Approved GIS library and official GeoJSON available |
| Preview address | Approved geocoder and walking-route provider configured |
| Publish | All validation blockers cleared, publication flag enabled, Owner approval |
| Serve snapshots | M2M authentication and snapshot API enabled |
| Calculate walking quote | M2M auth, quote gate, approved geocoder/router, official geometry, published fee policy and live slots |
| Deliver webhooks | Subscriber, signing key, replay protection and worker monitoring enabled |
| Offer slots/holds | Slot/capacity/hold policies approved and live service enabled |
| Store-backed +2-day shipping | Catalog/lots, inventory mutations, retrieval batches, pickup calendar and reconciliation enabled |

If the environment cannot prove the minimum readiness, stop at the preceding safe phase. Do not work around a locked feature flag.

## Draft creation or edit

1. Confirm the target environment and authenticated user.
2. Confirm every referenced store by stable integration ID, not display name.
3. Create or open the DRAFT zone.
4. Enter only confirmed postal labels, assignment strategy and candidate stores.
5. Import official WGS84 Polygon/MultiPolygon GeoJSON when available.
6. Link only compatible fee and slot policies for each candidate.
7. Leave unknown days, limits, fees, slots or effective dates incomplete rather than guessing.
8. Save with a unique command ID/idempotency key and expected draft version.
9. Record the returned correlation ID and new version.
10. Verify the audit entry shows the intended actor, entity and before/after summary.

Saving does not publish. If the same request times out, retry with the same idempotency key. If the payload changes, generate a new key after reconciling the prior result.

## Validation

Run `POST /v1/walking-zones/drafts/{id}/validate` only after the Phase 2 validators are deployed. Validation must check at least:

- Polygon/MultiPolygon type, nonempty coordinates and WGS84 bounds.
- Closed rings, boundary inclusion, excluded holes and topology/self-intersection policy.
- Active referenced stores with stable IDs.
- Exactly one candidate for `FIXED`.
- At least two candidates for `NEAREST_WALKING_ROUTE`.
- Deterministic overlap priorities.
- Complete effective window and active-day policy.
- Complete fee and slot references for every candidate.
- No `DRAFT_INCOMPLETE` fee policy.
- No balloon-only fee reused as general local delivery without approval.

Store the complete validation result with the change evidence. Any edit after validation requires revalidation.

## Address preview

Preview is an administrative diagnostic against a DRAFT. It is not a customer quote and must be labeled DRAFT in the UI and response.

1. Use a test address approved for non-production diagnostics.
2. Submit address, subtotal and service time to `POST /v1/walking-zones/drafts/{id}/preview-address`.
3. Confirm geocoding returned one unambiguous point.
4. Confirm point-in-polygon, boundary and hole handling.
5. For `10028`, verify `store-86th-street` remains fixed regardless of route distance.
6. For `10075`, verify all candidates have walking metrics and deterministic ordering.
7. Confirm the selected store's fee/slot references are used exclusively.
8. Preserve the reason code and correlation ID.

A preview returning `FEE_POLICY_INCOMPLETE`, `SLOT_POLICY_INCOMPLETE` or another blocker is expected while commercial configuration is incomplete. Do not override it manually.

## Publication checklist

Publication is dependency-blocked until all boxes below can be evidenced:

- [ ] Exact draft version reviewed and unchanged since validation.
- [ ] Official GeoJSON source and reviewer recorded.
- [ ] Every assignment and overlap priority tested.
- [ ] General walking fee policies explicitly approved.
- [ ] Slot/capacity policies and active days approved.
- [ ] Effective dates and timezone reviewed.
- [ ] Snapshot schema and canonical digest tests pass.
- [ ] `walking-zones:publish`/human publish permission verified.
- [ ] Publication and outbound integration flags intentionally enabled in the target environment.
- [ ] E-commerce accepts the schema in staging and retains last-valid fallback.
- [ ] Webhook signing, deduplication, retry and replay tested in staging.
- [ ] Rollback target and on-call owners identified.
- [ ] Change approval attached to the audit/change record.

Publish with a new `Idempotency-Key`, explicit effective time and reason. Confirm the response publication ID, version, digest and ETag. Then verify:

1. `GET /v1/walking-zones/published/{versionNumber}` returns the immutable snapshot.
2. Recomputed digest matches.
3. The outbox contains one publication event.
4. The subscriber durably accepts the signed event.
5. The e-commerce validates and activates the intended version.
6. The previous valid snapshot remains recoverable.

Never publish by editing a database row, changing a status in a database console or copying a digest manually.

## Walking quote safe state

`POST /v1/walking-delivery/quotes` remains dependency-blocked until every readiness item in `walking-route-distance-standard.md` is certified. A reachable route or contract-valid example is not evidence that the operation is enabled.

- Require M2M credentials with both `walking-zones:read` and `availability:read`.
- Require `Idempotency-Key` and `X-Correlation-ID`; an identical replay returns the original quote and never creates a hold.
- Never accept client-supplied coordinates, route metrics, selected store, fee or slot availability.
- Record the exact zone and fee-policy version IDs and the actual routing-provider ID.
- Return slots only for the selected store.
- Return `MANAGER_REVIEW` with `tierId: OVER_3250_FT_MANAGER_REVIEW`, a null fee and no slots above 3,250 feet.
- Return `NO_AVAILABLE_SLOTS` without trying another store.
- Return `503 DEPENDENCY_BLOCKED` rather than guessing when M2M, geocoder, router, geometry, policy or live slots are unavailable.

Quote addresses and coordinates are customer data. Do not include them in ordinary audit events or application logs.

## Auth0 verifier and JWKS operation

- The implemented STAGING verifier accepts Auth0's pilot header `typ=at+jwt` only, uses RS256, and never follows `jku`, `jwk` or `x5u` from a token.
- The trusted JWKS URL is derived exactly from the configured issuer. Keys are selected by `kid`; an unknown `kid` is `401 UNAUTHORIZED`, while network, timeout, HTTP, JSON or malformed-JWKS failures are temporary `503` authentication unavailability.
- Remote JWKS requests time out after 5 seconds. A successful set is fresh for 10 minutes and new fetches cool down for 30 seconds. These values were accepted for the STAGING activation and must be reassessed before production.
- The 10-minute freshness window supports normal key rotation but may continue trusting a removed key during that window. For suspected key compromise, lock the API immediately rather than relying only on JWKS removal.
- A normal rotation must publish the new public key before Auth0 begins issuing its `kid`, retain overlap long enough for issued tokens, and verify both old/new paths in STAGING before retiring the old key.
- Never store or attach raw access tokens to logs, alerts or the evidence package. Correlate using OrderPro client key, correlation ID and sanitized outcome only.

### One-time STAGING token certification

1. Confirm RFC 9068, RS256, 3600 seconds and the exact two Local Delivery scopes in Auth0.
2. Review and commit the certification code; require a completely clean Git tree before generating a token.
3. Generate the token in the authorized consumer/Auth0 Test flow; never move the Client Secret into OrderPro.
4. Run `npm run m2m:certify:staging` and paste only the token into the hidden prompt. The wrapper makes a best-effort attempt to clear the current clipboard with the Windows clipboard API. Confirm the cleanup and manually remove the token from Windows **Win+V** history or cloud sync if enabled.
5. Require `CERTIFIED_PENDING_APPROVAL`, the exact audience, source commit, audit event ID and evidence digest. Store only that sanitized output in the change record.
6. Confirm client, credential and grants remain `PENDING_VERIFICATION`, M2M mode remains `DISABLED`, the V4 gate remains false and all locked routes still return 503.
7. Treat registry activation and runtime enablement as later, separate approvals. Certification alone authorizes nothing.

### Audited M2M approval without activation

After `CERTIFIED_PENDING_APPROVAL`, deploy the reviewed approval-registry
 migration. The normal approval path is `/operations/admin/m2m`: an active
Supabase-authenticated Owner reviews the exact certification and submits a
10–500 character non-secret reason plus the exact no-activation confirmation.
The action derives the actor from the session, revalidates the pending snapshot
inside a serializable transaction and calls the audited database function.

Keep `ORDERPRO_M2M_STAGING_APPROVAL_UI_ENABLED=false` by default. A reviewed
STAGING release may set it temporarily to `true` only when CI supplies the exact
release commit, release tree and certified verifier digest through the
`ORDERPRO_RELEASE_*` server-only variables. CI must also bind the exact certified
commit/tree and attest that the certified commit is an ancestor of the release.
Production build, STAGING runtime, disabled M2M/V4 gates, canonical Auth0 public
configuration, executable SECURITY DEFINER RPC, RLS, append-only guards and all
three no-activation triggers are mandatory. Local development stays read-only.

The PowerShell wrapper remains a contingency path and may receive only an active
OWNER UUID, a non-secret reason, the certification audit event ID and its
evidence digest. Run it only from its committed, clean Git tree and with a signed
change record binding the privileged operator to the Owner decision. A
successful result must be `APPROVED_PENDING_ACTIVATION` and must still report the
client, credential and grants as `PENDING_VERIFICATION`, M2M mode as `DISABLED`
and the Local Delivery V4 API gate as false.

The CLI validates the referenced Owner in the database but does not authenticate
that human. Treat `actorId` as a privileged-operator attribution, not independent
non-repudiation. Do not run the approval until a change record approved by that
Owner binds the operator to the decision, or an authenticated Supabase Owner
session replaces the CLI assertion. Schema deployment alone remains safe and
must leave the approval table empty.

The approval command cannot receive a bearer token, Client Secret, Management
API token, Authorization header, external Client ID or runtime flag. Retain the
approval ID, audit ID, correlation ID, approval digest and source commit in the
change record. At the approval step, activation and runtime enablement remain later forward-only
changes; never bypass the three database activation guards with manual SQL.

### Current STAGING M2M activation state

The immutable activation was recorded on July 20, 2026 at 04:15:33 ET by
sebastian. The client, credential and exact two grants are `ACTIVE`. The
activation UI was closed and redeployed, the approval UI remains closed, and
Auth0 runtime verification was enabled in a separate deployment. Local Delivery
V4 remains disabled.

Post-deployment checks established the following safe baseline:

- `POST /api/v1/local-delivery/auth-check` without a token returns `401 UNAUTHORIZED`.
- Local Delivery quote and holds return `503 M2M_AUTH_NOT_CONFIGURED` while the V4 gate is false.
- `GET /api/health` returns `200` with `productionOperationsEnabled: false`.
- `GET /api/health/ready` returns `200` with both Supabase database and auth dependencies ready.

The anonymous `401` confirms fail-closed rejection, not successful machine
authentication. Before any broader STAGING use, call `auth-check` with a valid
ephemeral token and retain only the sanitized `AUTHENTICATED` result. Do not open
the V4 gate as part of that verification.

## Rollback

Rollback creates a new publication from a historical snapshot. It never mutates or reactivates the old row in place.

1. Identify the last known-good immutable version and incident/change reason.
2. Compare it with the current version and confirm it is compatible with the consumer's supported schema.
3. Confirm referenced stores and policies remain operational for the new effective time.
4. Obtain Owner rollback approval.
5. Call `POST /v1/walking-zones/versions/{id}/rollback` with a unique idempotency key, explicit effective time and reason.
6. Verify a new publication ID, increasing version number, new digest, audit entry and outbox event.
7. Verify e-commerce download, digest validation and activation.
8. Record incident timeline, correlation ID and reconciliation evidence.

If rollback validation fails, keep the current last-valid consumer snapshot and lock new publication while the configuration is repaired. Do not bypass validators.

## Archive

Archive only a non-current version after confirming it is not required as the active publication. Archiving changes administrative lifecycle state; it does not delete snapshot, order reference, event or audit history. A current effective version requires a replacement before archive.

## Webhook delivery incident

When a publication succeeds but a subscriber does not activate it:

1. Compare publication ID/version/digest in OrderPRO, outbox and subscriber logs.
2. Confirm subscriber URL and active signing key ID without exposing the secret.
3. Inspect HTTP status, contract validation and replay/deduplication outcome.
4. Correct configuration or subscriber behavior.
5. Replay the original event with the same `eventId` and semantic payload.
6. Confirm duplicate processing is harmless and the intended version becomes active once.
7. Reconcile the subscriber's active version using the published snapshot endpoint.

Do not create a second publication merely to force notification. A delivery failure and a domain publication are separate concerns.

## Slot/reservation incident

- If create-hold times out, retry with the same idempotency key or read the known reservation ID.
- If payment succeeds but confirmation response is lost, reconcile before creating another hold.
- If payment fails, release the hold; repeated release is idempotent.
- If the selected store has no slots, return `NO_AVAILABLE_SLOTS`; do not switch stores silently.
- If OrderPRO is unavailable, do not fabricate live capacity from the cached zone snapshot.
- Escalate stale/expired holds according to the capacity policy once that policy is approved.

## Store-backed shipping operations

The two-business-day policy applies only to standard carrier shipping sourced from active store inventory:

1. Reserve the item at the source store immediately.
2. Add it to a controlled store-to-Englewood retrieval batch.
3. Keep it reserved during movement.
4. Verify receipt at WH01 and process the carrier shipment.
5. Preserve the promise-policy snapshot used by the order.

Do not make inventory online-eligible during the initial warehouse-to-store trip. Do not promise an exact date until pickup days, cutoff, holidays and carrier behavior are configured. Walking delivery is direct from the selected store and does not receive this adjustment.

## Emergency safe-state actions

Use the narrowest relevant gate:

- Lock walking publication to stop new snapshots while retaining reads of the last valid version.
- Lock outbound webhook delivery only when signature/subscriber safety is compromised; preserve outbox records.
- Lock reservation creation if live capacity integrity is unknown; preserve existing reservations for reconciliation.
- Keep `storefront.availability` locked if inventory reconciliation is unsafe.
- Keep `square.production_writes` locked unless separately certified and approved.

Feature flags are not data repair tools. After stabilizing, reconcile durable state, apply forward-only fixes and retain all audit/history.

## Evidence to retain

- Change/incident ID and business approver.
- Actor/client ID and required permission/scope.
- Idempotency key and correlation ID.
- Draft, durable zone-version, fee-policy-version, slot-policy-version and publication IDs.
- Validation result and exact blocker list.
- Snapshot digest and schema version.
- GeoJSON source and review evidence.
- Effective window and referenced policy versions.
- Outbox event ID, signature key ID and subscriber result.
- Rollback/reconciliation outcome.

Never retain access tokens, signing secrets, full authorization headers or unnecessary full customer addresses in the evidence package.

## Known blockers before production

- Official polygons and overlap priorities.
- Complete approved general fees for both stores.
- Slot schedules, capacity rules and hold lifetime.
- Geocoding/routing providers and map/topology tooling.
- M2M certification, Owner approval, registry activation and Auth0 runtime enablement are complete in STAGING; valid-token runtime evidence, rate limits and production authorization remain pending.
- Webhook subscriber, signing secrets, retry/dead-letter ownership.
- Store-backed pickup schedule, cutoff, holiday calendar and safety stock.
- Product/lots synchronization and inventory mutation certification.
- End-to-end staging certification and explicit launch approval.
