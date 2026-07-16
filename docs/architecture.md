# OrderPRO Architecture

OrderPRO is an independent modular monolith. It integrates with the existing storefront and Square but does not replace them.

The first permanent modules are identity/RBAC, operational locations, integration safety, audit and feature flags. Durable business state belongs in PostgreSQL. External calls will be performed by workers from transactional outbox records; inbound events enter a deduplicated webhook inbox.

Square production writes remain disabled until mappings, Sandbox certification, reconciliation and explicit approval are complete.

Dependency direction is `app → application services → domain → ports`; infrastructure implements ports. Route handlers do not contain domain transitions and modules do not write each other's tables directly.
