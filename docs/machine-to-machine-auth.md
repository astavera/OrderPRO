# Machine-to-machine authentication and webhook signing

Status as of July 20, 2026: the Auth0 STAGING M2M certification, immutable Owner approval and audited registry activation are complete. The client, credential and exact two grants are `ACTIVE`; both administrative M2M UI gates are closed and the deployed runtime uses `ORDERPRO_M2M_AUTH_MODE="AUTH0"`. Local Delivery V4 remains intentionally disabled and dependency-blocked.

Human Supabase sessions and administrative cookies are never valid machine credentials. E-commerce and worker integrations use a separate identity, scope and secret lifecycle. Secrets stay server-side and must not use `NEXT_PUBLIC_` environment variables.

## Recommended API authentication

The selected STAGING target is Auth0 OAuth 2.0 Client Credentials with short-lived RFC 9068 bearer access tokens. The fixed pilot contract uses RS256, a maximum configured token lifetime of 3600 seconds and explicit grants for `local-delivery:quote` and `local-delivery:holds`. Certification, human approval, registry activation and Auth0 runtime deployment are complete. The Local Delivery APIs remain dependency-blocked because their independent V4 gate and provider composition are not enabled.

### Auth0 STAGING decision

OrderPro does not accept the existing human Supabase Auth session as M2M identity. Supabase remains the human login provider and PostgreSQL platform. Auth0 is isolated to machine callers for the STAGING pilot; this does not migrate users or change human sessions.

The operator provides only the canonical Auth0 Tenant Domain, the API Identifier/Audience and the public M2M Client ID. The STAGING pilot values and sanitized certification evidence were received, and the durable machine client, credential and exact grants are now `ACTIVE`. The issuer and static JWKS URI are derived from the tenant domain. OrderPro never receives the Auth0 Client Secret, a Management API token or credentials used by the caller to acquire tokens. See [Auth0 M2M STAGING setup](auth0-m2m-staging-setup.md).

Connecting the implemented JWT verifier to a runtime requires an audited decision record that certifies all of the following together:

- issuer and exact HTTPS JWKS URI;
- audience and one approved asymmetric signing algorithm;
- token lifetime, clock-skew policy and outage behavior;
- exact client identity and scope claim names;
- durable client inventory, environment, owner, revocation state and grants;
- rotation, incident response and monitoring ownership.

The resource server must use a statically trusted JWKS URI; it must never follow `jku` or `x5u` supplied by a token. A successful signature check is not authorization by itself: the client must also be active in OrderPro's registry and have the exact required scope and environment grant.

The STAGING verifier is implemented in `src/infrastructure/m2m/auth0-machine-authenticator.ts`. It requires a compact Bearer JWT with `typ=at+jwt`, `alg=RS256`, a bounded `kid`, the exact issuer and only the configured audience, `client_id`, `<client_id>@clients` subject, `jti`, `iat`, `exp`, and a space-delimited `scope`. It rejects token-supplied key URLs/material, lifetimes over 3600 seconds, malformed or duplicate scopes, and unknown or inactive clients. Sender-constrained (`cnf`) and Auth0 Organization (`org_id`/`org_name`) tokens are rejected until their proof/binding is deliberately implemented. Its authenticated principal contains OrderPro's internal client key and only the intersection of token scopes with active registry grants; raw Auth0 identifiers and tokens never cross the application boundary.

The tenant discovery document and JWKS are public and were checked without credentials. The current JWKS exposes multiple RSA/RS256 signing keys, so resolution is by `kid` with bounded remote caching and rotation support. The end-to-end STAGING token test then confirmed the exact issuer, audience, profile, lifetime, Client ID and two scopes without retaining the token.

The one-time command `npm run m2m:certify:staging` accepts an access token only through a hidden prompt and anonymous stdin pipe. It refuses command-line arguments, regular-file stdin, a dirty Git tree or an uncommitted verifier, and gives the child only an allowlisted environment. It reuses the production verifier/JWKS while a private certification-only registry wrapper proves that the real registry still denies the pending credential. A successful run records only `verifiedAt` and sanitized audit evidence tied to the source commit/tree; no status becomes active and no raw token, JTI, external Client ID or authorization header is retained. See the [Auth0 STAGING setup](auth0-m2m-staging-setup.md#certificación-real-sin-activar-el-api).

This STAGING workstation ceremony attests the committed sources and dependency lockfile, but it is not a signed hermetic build attestation for the Node executable or installed `node_modules` bytes. Production certification must run the same command from a reviewed, immutable CI artifact or container with dependency-integrity evidence.

Local Delivery V4 uses an additional all-or-nothing runtime gate. `ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED` is server-only and remains disabled. Even the active STAGING machine credential cannot reach quote or hold behavior unless authentication, client registry, all real providers, persistent stores, the versioned allocation strategy and the requested environment are ready at the same time. Partial configuration remains HTTP 503 and must not invoke business providers.

An access token should identify one client and carry only approved scopes. A verifier must check signature, issuer, audience, expiration and scope on every request. Expected security claims include a stable client subject, expiration, audience and granted scopes; their exact names depend on the selected issuer.

OpenAPI describes the current target as a bearer security scheme and lists required scopes through `x-orderpro-required-scopes`. That description is not a token issuer and must not be used to fabricate tokens.

If OAuth cannot be provided, a signed-request HMAC alternative may be designed after threat-model review. It must include method, normalized path/query, body hash, timestamp, client/key ID and a unique request identifier. The webhook signature defined below is not automatically a valid inbound API-request scheme.

## Scope catalog

| Scope | Authorized capability |
| --- | --- |
| `walking-zones:read` | Read administrative zones, immutable versions and published snapshots |
| `walking-zones:write` | Create, edit, delete, validate and preview drafts |
| `walking-zones:publish` | Publish validated drafts and archive eligible versions |
| `walking-zones:rollback` | Create a new publication from historical content |
| `availability:read` | Read live slots for an already selected location |
| `reservations:write` | Create, read, confirm and release capacity holds |
| `local-delivery:quote` | Evaluate a Local Walking Delivery V4 address/cart and return geographic eligibility, fee and selected-store slots |
| `local-delivery:holds` | Create, confirm and release V4 capacity plus inventory holds |
| `fulfillment:write` | Future operational order/fulfillment commands; no stable endpoint is defined in v1 yet |

Scopes are additive but not interchangeable. A client with `walking-zones:write` cannot publish. Human permissions such as `fulfillment.publish` do not create M2M scopes, and M2M scopes do not grant access to the administrative panel.

`POST /v1/walking-delivery/quotes` requires both `walking-zones:read` and `availability:read`: the first authorizes immutable zone/policy evaluation and the second authorizes live slots. Possession of only one scope is insufficient. The endpoint remains dependency-blocked until its complete runtime, policies and providers are certified; activation of the separate Local Delivery V4 grants does not open this older contract.

Local Walking Delivery V4 uses a separate versioned contract: `POST /api/v1/local-delivery/quote` requires `local-delivery:quote`, while `/api/v1/local-delivery/holds` and its `confirm`/`release` transitions require `local-delivery:holds`. Quote and hold creation require `Idempotency-Key`; confirm/release are state transitions keyed by the hold plus the same `orderId` or release `reason`. Prisma quote/hold adapters exist but remain disconnected. The client and grants are active, but all four routes continue returning `503 M2M_AUTH_NOT_CONFIGURED` while the V4 gate is false and real providers plus the complete runtime composition remain uncertified. See the [V4 OpenAPI contract](openapi/orderpro-local-delivery-v1.yaml).

## API request headers

Every authenticated API request should carry:

```http
Authorization: Bearer <short-lived-access-token>
Accept: application/json
X-Correlation-ID: <caller-generated-unique-id>
```

Every operation whose contract requires idempotency additionally uses the headers below. Both walking-delivery quote operations and Local Delivery V4 hold creation require `Idempotency-Key`, so a lost response can be replayed without recalculating against changed live inputs:

```http
Content-Type: application/json
Idempotency-Key: <caller-generated-unique-command-id>
```

The server returns a correlation ID in the response. Authorization headers, raw tokens and client secrets must never be logged. Customer address logging must be minimized and redacted according to the pending retention policy.

## Idempotency contract

- The key is scoped to the client and operation.
- The server hashes the normalized semantic request.
- An identical retry returns the original committed response.
- The same key with different content returns `409 IDEMPOTENCY_CONFLICT`.
- An in-progress command returns a retryable conflict or accepted response defined by the operation.
- Key retention duration is configuration-dependent and must be longer than the approved client retry window.

Idempotency does not replace optimistic version checks. Draft updates carry an expected aggregate version so two distinct valid commands cannot silently overwrite each other.

## Authorization failures

| HTTP status | Meaning |
| --- | --- |
| `401` | Missing, invalid, expired or incorrectly targeted machine credential |
| `403` | Valid client without the required scope or resource/location grant |
| `409` | Idempotency conflict, stale entity version or incompatible state transition |
| `422` | Authenticated request with invalid domain configuration or input |
| `429` | Authenticated client exceeded its configured rate policy |

No response should reveal whether an out-of-scope private resource exists. Concrete rate limits are intentionally not specified until capacity testing and client inventory are complete.

## Outgoing webhook signature v1

This is the target signing contract for OrderPRO outgoing webhooks. It must be implemented with reviewed test vectors before subscribers rely on it.

Transport headers:

```http
Content-Type: application/json
X-OrderPRO-Key-Id: <rotatable-key-id>
X-OrderPRO-Timestamp: <unix-seconds>
X-OrderPRO-Event-Id: <same-eventId-as-body>
X-OrderPRO-Signature: v1=<base64url-hmac-sha256>
```

The signed bytes are the UTF-8 raw request body exactly as transmitted. Build the canonical signing input with LF separators and no final LF:

```text
orderpro-webhook-v1
<timestamp>
<eventId>
<lowercase-hex-sha256-of-raw-body>
```

Compute HMAC-SHA-256 over that canonical input using the secret identified by `X-OrderPRO-Key-Id`, then encode the result as unpadded base64url. Compare signatures using a constant-time operation.

The signature is transport metadata and is intentionally not a JSON property. Event JSON is validated by `schemas/orderpro-event-envelope-v1.schema.json` and its event-specific schema.

## Subscriber verification

A subscriber must perform these steps before applying an event:

1. Read and retain the raw body bytes.
2. Require all five transport headers.
3. Resolve an active secret by key ID without exposing it to logs.
4. Recompute and constant-time compare the signature.
5. Reject a timestamp outside the configured replay window.
6. Parse JSON only after cryptographic verification.
7. Require header event ID to match body `eventId`.
8. Insert the event ID into a durable deduplication inbox before side effects.
9. Validate the generic envelope and event-specific payload schema.
10. Process idempotently and retain outcome/audit evidence.

The exact replay window is pending operational approval and clock-skew testing. A subscriber must not invent one silently. Duplicate delivery inside or outside that window must not duplicate effects when the event ID is already known.

## Delivery, retry and replay

- OrderPRO writes the event to its transactional outbox in the same commit as the publication or domain transition.
- A worker delivers the same `eventId` on every retry.
- Network failure and `5xx`/configured `429` responses are retryable.
- Most `4xx` responses require configuration or contract correction and should enter an escalation/dead-letter path.
- Manual replay reuses the original event ID and semantic payload. Delivery timestamp/signature may change, while `occurredAt` remains the original domain-event time.
- Retry schedule, maximum attempts and dead-letter owner are pending launch configuration.

## Secret issuance and storage

- Create one machine identity per consuming system and environment.
- Never share development, staging and production credentials.
- Store secrets only in an approved server-side secret manager.
- Give each credential an owner, purpose, environment, scopes, created date and rotation deadline.
- Do not place credentials in source control, issue trackers, screenshots or browser storage.
- Restrict administrative access to create, rotate and revoke credentials.
- Audit issuance, scope changes, last use, rotation and revocation without logging secret material.

## Rotation procedure

1. Create a new credential or webhook signing key with a distinct key ID.
2. Distribute it through the approved secret channel.
3. Allow a reviewed overlap where sender and receiver recognize both key IDs.
4. Send a signed non-production verification event or call.
5. Switch the active sender/client credential.
6. Verify authentication, signature, deduplication and monitoring.
7. Revoke the old credential.
8. Record the change and evidence in the audit/change system.

No production credential is rotated solely by editing `.env.local`; deployment secret changes and rollback procedures are environment-specific.

## Incident response

If a machine credential or signing key is suspected compromised:

1. Lock the relevant external feature flag or ingress route.
2. Revoke the credential/key without deleting audit or inbox/outbox records.
3. Identify calls/events by client ID, key ID, event ID and correlation ID.
4. Rotate affected credentials and inspect subscriber deduplication state.
5. Reconcile publications, reservations and fulfillment changes.
6. Restore traffic only after a documented security approval.

Do not disable authentication, reuse a human cookie or expose a secret to the browser as a recovery shortcut.

## Completed STAGING M2M controls

- The approval-registry and activation migrations are deployed.
- An authenticated Owner recorded the immutable approval and separate activation against the certified evidence.
- The client, credential and exact two grants are active; the approval and activation UIs were closed afterward.
- Auth0 runtime verification was enabled in a separate deployment. An anonymous `auth-check` request is rejected with `401 UNAUTHORIZED`.
- Health and readiness checks pass, while quote and holds remain safely locked with HTTP 503.

## Decisions required before Local Delivery enablement

- Complete a post-activation `auth-check` using a valid ephemeral token and retain only the sanitized `AUTHENTICATED` outcome.
- Whether a signed-request HMAC fallback is necessary.
- Broader client inventory, operational owners and scope grants beyond this completed pilot identity.
- Rate and payload-size limits.
- Webhook subscriber URLs and network restrictions.
- Replay window and tolerated clock skew.
- Secret manager, rotation cadence and emergency revocation owner.
- Retry/backoff/dead-letter policy.
- Customer-data redaction and retention controls.

`ORDERPRO_RUNTIME_ENVIRONMENT=STAGING` is already part of the closed runtime guard. The server-only Auth0 configuration inputs are `ORDERPRO_M2M_AUTH_MODE`, `ORDERPRO_M2M_ISSUER`, `ORDERPRO_M2M_AUDIENCE`, `ORDERPRO_M2M_JWKS_URI` and `ORDERPRO_M2M_ALLOWED_ALGORITHM`. None may use the `NEXT_PUBLIC_` prefix. Their parser can validate configuration but cannot activate Local Delivery V4. The M2M client's own secret and token acquisition configuration belong in that client's secret manager, not in the OrderPro resource server.
