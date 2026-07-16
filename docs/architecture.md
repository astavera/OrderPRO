# OrderPRO Architecture

OrderPRO is an independent modular monolith. It integrates with the existing storefront and Square but does not replace them.

The first permanent modules are identity/RBAC, operational locations, integration safety, audit and feature flags. Durable business state belongs in PostgreSQL. External calls will be performed by workers from transactional outbox records; inbound events enter a deduplicated webhook inbox.

Identity administration uses fixed, reviewed roles with a visible permission matrix. Supabase owns authentication identities while PostgreSQL owns account status, roles and location grants. Invitations are the current bounded exception to worker-only external calls: Supabase Auth is invoked first, the local account is committed transactionally with audit/outbox records, and a newly created Auth identity is deleted as compensation if the local commit fails.

Square production writes remain disabled until mappings, Sandbox certification, reconciliation and explicit approval are complete.

Dependency direction is `app → application services → domain → ports`; infrastructure implements ports. Route handlers do not contain domain transitions and modules do not write each other's tables directly.

The inventory foundation is described in [inventory-foundation.md](inventory-foundation.md). Owner, physical location, availability state and container are deliberately separate dimensions of the same units.

The fulfillment configuration control plane is described in [fulfillment-walking-delivery.md](fulfillment-walking-delivery.md). It keeps walking delivery separate from carrier shipping backed by store inventory: walking is store-to-customer with no warehouse detour, while carrier shipping reserves at the store, retrieves through `warehouse-englewood` and applies a two-business-day adjustment. Draft editing is available internally, but publication, storefront availability, live capacity and external delivery remain independently gated. The versioned walking-quote contract and draft route-distance tiers are documented in [walking-route-distance-standard.md](walking-route-distance-standard.md); no runtime provider or production quote capability is configured by that contract.

Durable storage is Supabase-managed PostgreSQL. Runtime and migration connection modes, RLS and operational policy are documented in [supabase.md](supabase.md).
