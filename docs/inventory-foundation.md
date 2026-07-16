# Inventory Foundation

Status: schema, pure domain invariants and read-only box inspection implemented; database-backed inventory mutations remain disabled.

## Implemented boundaries

- `Product` maps one OrderPRO product to an immutable Square variation ID.
- `InventoryLot` answers who commercially owns a quantity.
- `Container` answers where units are grouped physically. Every container has exactly one owner.
- `ManifestVersion` and `ManifestLine` preserve immutable closed content snapshots.
- `SealEvent` records application and break history; seal reuse is prohibited by unique constraints.
- `InventoryLedgerEntry` is append-only and idempotent. Corrections use compensating entries.
- `ContainerContentProjection` is derived state and may be rebuilt from the ordered ledger.

Box codes use a `BX-` prefix, a scanner-safe alphabet without ambiguous characters, random entropy and a check character. Codes are identifiers, not secrets.

## Read-only box inspection

Authorized users can search a box by scanner-safe code and open its detail page. Visibility is granted when the box is commercially owned by an assigned active location or is physically present there. The same scoped database predicate protects both the list and the detail query so an out-of-scope code is indistinguishable from a missing code.

The detail page exposes the current locations, aggregate version, latest manifest, content projection, recent ledger entries and seal history. It does not expose mutation controls while `inventory.mutations` and `warehouse.box_workflow` remain locked. Product and owner-lot synchronization is the prerequisite for the first packing command.

## Transaction boundary for a future scan command

One PostgreSQL transaction must:

1. Claim or replay the idempotency record.
2. Lock the container or update with the expected aggregate version.
3. Validate status, owner, product identifier and positive quantity.
4. Insert the append-only ledger entry.
5. Update the content projection with a nonnegative guarded quantity.
6. Increment the container version.
7. Write the audit event and transactional outbox message.
8. Store the committed response in the idempotency record.

The API must return `409` for a stale version and the original response for an identical retry. Reusing an idempotency key with a different request hash is a conflict.

## Migration safety

`20260715223000_foundation_inventory` is an initial empty-database migration. It adds database checks for positive quantities and versions, blocks ledger updates/deletes, and verifies that manifest lots share the container owner.

Rollback before any real data exists is database disposal and recreation. Once ledger data exists, rollback is forward-only: disable affected flags, deploy a compatible release, retain the ledger, and compensate through domain commands. Never drop or edit inventory history to roll back application behavior.
