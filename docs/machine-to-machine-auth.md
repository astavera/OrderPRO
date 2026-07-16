# Machine-to-machine authentication and webhook signing

Status: target security contract. No issuer, client credential, signing secret, token endpoint or production rate limit is configured by this document.

Human Supabase sessions and administrative cookies are never valid machine credentials. E-commerce and worker integrations use a separate identity, scope and secret lifecycle. Secrets stay server-side and must not use `NEXT_PUBLIC_` environment variables.

## Recommended API authentication

The preferred target is OAuth 2.0 Client Credentials with short-lived bearer access tokens. The identity provider, issuer, audience, token URL, token format and credential storage mechanism remain deployment decisions. Until those are selected and certified, the `/v1` API is dependency-blocked for production M2M use.

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
| `fulfillment:write` | Future operational order/fulfillment commands; no stable endpoint is defined in v1 yet |

Scopes are additive but not interchangeable. A client with `walking-zones:write` cannot publish. Human permissions such as `fulfillment.publish` do not create M2M scopes, and M2M scopes do not grant access to the administrative panel.

`POST /v1/walking-delivery/quotes` requires both `walking-zones:read` and `availability:read`: the first authorizes immutable zone/policy evaluation and the second authorizes live slots. Possession of only one scope is insufficient. The endpoint remains dependency-blocked until the target M2M verifier and client grants exist.

## API request headers

Every authenticated API request should carry:

```http
Authorization: Bearer <short-lived-access-token>
Accept: application/json
X-Correlation-ID: <caller-generated-unique-id>
```

Every mutation additionally requires the headers below. The walking-delivery quote operation also requires `Idempotency-Key` even though it does not create a capacity hold, so a lost response can be replayed without recalculating against changed live inputs:

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

## Decisions required before enablement

- OAuth issuer, audience, token endpoint, signing algorithms and token lifetime.
- Whether a signed-request HMAC fallback is necessary.
- Client inventory, owners and exact scope grants.
- Rate and payload-size limits.
- Webhook subscriber URLs and network restrictions.
- Replay window and tolerated clock skew.
- Secret manager, rotation cadence and emergency revocation owner.
- Retry/backoff/dead-letter policy.
- Customer-data redaction and retention controls.
