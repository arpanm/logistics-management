# JURIGARI-DEMO — Dedicated production demonstration profile

**Implementation status:** Implemented locally
**Test status:** Focused unit, PostgreSQL integration, and Playwright Passing

## Outcome

An explicitly authorized, versioned, idempotent bootstrap installs tenant `JG` as **Jurigari Pvt Limited** without changing the normal seed/deployment path. It reuses the reusable rich demo graph through a profile-driven engine, while keeping customer-specific identity and workbook exemplar values isolated in one profile.

## Acceptance contract

- Tenant code `JG`, GSTIN `36AAGCJ7322K1ZC`, `Asia/Kolkata`, `en-IN`, `INR`, registered Hyderabad address, protected support details and Jurigari branding are canonical.
- Exactly two main users exist: Piyana Bandyopadhyay (`piyana10@gmail.com`) and Siddhartha (`siddhartha09@gmail.com`). Both are `ACTIVE`, `INTERNAL`, linked to active employees, and assigned the protected `TENANT_OWNER` role at tenant root.
- The workbook chain is real canonical data: Tata Consumer Products Ltd / `TCPL`; Kunigal / `TCPL-KUN`; Sahil Roadlines / `VEN-0142`; `IND-4231`; `KA 25 AB 4471`; `JGL/24118`; invoice `INV-26-3427`; receipt `RCP-2026-0881`.
- Invoice minor units reconcile exactly: taxable `28,400,000` + GST `1,420,000` = total `29,820,000`. Receipt is `15,000,000`, deduction is `840,000`, and displayed invoice balance is `14,820,000`.
- TCPL credit terms are 45 days and POD mode is Portal. Other demonstration records come from the versioned reusable demo graph under collision-free Jurigari UUID namespaces.
- First execution is atomic. Same version/hash replay changes no business data or credentials. Tenant-code, reserved-email, or version/hash collision fails before partial materialization. An existing Jurigari tenant can be adopted only with an exact one-shot confirmation, matching Jurigari name, and the explicitly supplied UUIDs for its tenant, legal entity, root organization, tenant/legal scopes, and Piyana invitation membership.
- Passwords come only from `JURIGARI_USER_PASSWORD`; they are never committed, documented, logged, or returned by verification. Production requires exact dataset confirmation. A 12–15 character production password additionally requires the dedicated opt-in and exact risk confirmation; generic password policy is unchanged.
- Password mismatch fails closed unless explicit rotation is enabled; rotation updates both identities, increments auth versions, revokes sessions, and writes an audit event.
- `jurigari:verify` reads only canonical PostgreSQL state and reports secret-free counts/reconciliation.
- `db:seed`, recurring deployment, and reusable `demo:seed` never invoke this profile.

## Operational boundaries

This is demonstration data, not a customer fork or a destructive production-data importer. It must be installed only into the intended account after checking for code/email collisions. Posted invoices, reconciled receipts, and their ledgers are materialized once and are never rewritten by the profile. Removal is operationally handled by tenant deactivation; destructive deletion is intentionally absent.
