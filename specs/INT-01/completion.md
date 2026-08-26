# INT-01 — AWS SES Owner Invitation Completion

**Implementation status:** Implemented
**Automated test status:** Implemented / Not Run
**AWS activation status:** Pending identity verification, IAM permission, protected environment configuration, production-access request, deployment, and explicit provider smoke

## Implemented evidence

- Migration `202608250026_owner_invitation_email_delivery` adds nullable encrypted-token/provider-evidence fields without breaking legacy attempts.
- Tenant creation and audited reissue seal the stable activation token with AES-256-GCM and tenant/invitation associated data; plaintext remains memory-only.
- The NestJS backend leases eligible PostgreSQL attempts with `SKIP LOCKED`, calls SES v2 through the EC2 instance profile, conditionally reconciles provider acceptance, and bounds safe pre-acceptance retries.
- A normal in-process scheduler polls the existing queue; no Redis, broker, Mailpit, separate worker, or project-specific PostgreSQL was added.
- Inactive tenants defer delivery, terminal invitation states clear queued secret material, stale/ambiguous attempts fail closed for manual reissue, and reactivation no longer fabricates delivery success.
- Production configuration, EC2 IAM policy template, first-setup generation, validation, and operator runbook are documented.

## Remaining explicit release evidence

- Verify `mukh.bad@gmail.com` in SES `eu-north-1` and approve the one-identity EC2 send permission.
- Request/obtain SES production access before arbitrary tenant recipients; sandbox testing is limited to verified recipients or simulator addresses.
- Deploy migration/configuration, run the focused authored tests once, then run the opt-in real SES acceptance and Gmail receipt smoke without recording activation tokens.
- General access invitations and password-reset delivery remain an INT-01 follow-up and continue to use the audited copy-once administrator fallback.
