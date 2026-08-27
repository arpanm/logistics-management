# OPS-03 — Trip register and execution CTA completion

**Status:** Implemented
**Evidence reviewed:** current trip routes/actions/UI and `FEATURES.md`. No tests were run.

## Problem and outcome

The trip page exposes basic lifecycle buttons but must become the complete operational register for accepted, started, loaded, in-transit, arrived, unloaded, delivered and exception trips. Every CTA must collect contextual evidence instead of inventing timestamps/default receiver data.

## Scope, dependencies, and actors

- `/app/operations/trips` all-trip register, live/exception views and trip detail timeline.
- Accept, Start/gate-in, loading start/end, depart/start transit, checkpoint/exception, destination arrival, unloading start/end, End/deliver, cancel/recover actions.
- Depends on OPS-02 assignment, MST-03 vehicle/driver eligibility and DOC-01 delivery handoff.
- Operations readers see scoped trips; dispatch/field roles mutate only permitted/assigned trips; drivers cannot access unrelated trips or collect GPS outside an active assignment.

## UX behavior and states

1. Tabs: Live, Awaiting acceptance/start, Loading, In transit, At destination, Exceptions, Delivered/Cancelled, and All trips. KPI clicks apply the same filters.
2. Register columns: trip/LR/indent, client/location/lane, vendor, vehicle/driver, state/milestone, planned/actual times, ETA/variance, GPS freshness, detention/exception, POD state and actions.
3. Accept confirms the assignment. Start captures actual time and optional odometer/location. Loading and unloading actions use date/time pickers plus quantity/package/document/evidence/exception fields required by the milestone.
4. Transit/checkpoint captures source, timestamp, optional point, odometer and note; SOS/exception requires type/severity/note and routes alerts.
5. End & deliver captures delivered quantity, receiver, OTP/signature/stamp or governed exception, shortage/damage and evidence. It never supplies a hard-coded receiver or current time without user confirmation.
6. Detail shows planned and append-only actual event timeline, ordering conflicts, assignment history, evidence and audit. Record CTA opens DOC-01 after delivery.
7. Mobile layout makes the next valid assigned action primary, keeps emergency/contact/navigation accessible, and shows offline queued/sync/conflict state.
8. Invalid transition, duplicate event, stale assignment, permission loss, GPS silence and upload failure receive recoverable contextual feedback.

## Data model and invariants

- Events are append-only with tenant/trip, stable external/device event ID, event type, device time, received time, source, actor, optional location/evidence and ordering status.
- Lifecycle is derived from canonical events under an allowed transition graph. Corrections append compensating/correction events.
- Quantity uses exact units; timestamps are UTC and displayed in tenant timezone. GPS data is retained/visible according to configured privacy policy.
- Delivery completion atomically records event and outbox handoff; the DOC-01 consumer is idempotent.

## API/events/idempotency

- `GET /operations/trips` supports state/milestone/risk/client/location/vendor/vehicle/driver/date/search/sort/page and returns allowed actions, as-of and pagination.
- `GET /operations/trips/:id` returns projected detail/timeline. Existing action endpoint accepts typed action-specific payloads, `expectedVersion`, stable idempotency key and evidence references; batch/offline sync returns per-event results.
- Events publish `trip.accepted/started/milestone/exception/delivered/cancelled`; delivery emits one `delivery.completed` per canonical completion.

## Reports, alerts, audit, observability, recovery

- Live counts, ETA/detention/completeness and Control Tower Trip lens reconcile to filtered trip rows.
- Alerts cover missed milestones, detention, route deviation, GPS silence, exception/SOS, document gaps, shortage/damage and offline-sync failure.
- Audit retains actor, source/device, device/received timestamps, old/new derived state and correlation key. Location is access controlled and excluded from general logs.
- Duplicate sync returns original event. Out-of-order input is retained and flagged. Failed evidence upload can be retried without duplicating the milestone.

## Acceptance criteria

- **OPS03-AC01:** All scope-visible trips are discoverable in a paginated register with live, exception and historical views; KPIs reconcile to rows.
- **OPS03-AC02:** Valid Accept/Start/loading/transit/arrival/unloading/End CTAs appear by state and actor and collect their required date/time, quantity and evidence fields.
- **OPS03-AC03:** No action silently invents receiver/evidence; invalid transitions and unrelated-trip access are rejected server-side.
- **OPS03-AC04:** Duplicate/offline events are idempotent, ordering conflicts remain visible, and corrections are append-only.
- **OPS03-AC05:** End/deliver creates exactly one consistent POD task and surfaces a link to it.
- **OPS03-AC06:** Tracking is collected only during the active assigned trip and is permission/retention controlled.
- **OPS03-AC07:** The register/detail supports loading, empty, error/retry, offline/sync/conflict, responsive and keyboard states without losing filters.

## Assumptions and readiness

Required delivery evidence and correction authority are tenant/contract configuration. No blocking decision remains. Production behavior is implemented and independently reviewed, including atomic versioned trip actions; focused contract/Playwright cases are `Implemented / Not Run` and deeper cases remain `Planned`.
