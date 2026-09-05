import { Shell } from "../../../components/shell";

export default function NoWorkspaceAccess() {
  return (
    <Shell>
      <section className="page-card" aria-labelledby="no-access-title">
        <p className="eyebrow">Workspace access</p>
        <h1 id="no-access-title">No application area is assigned</h1>
        <p className="muted">
          Your account is active, but its current role does not include access
          to an application workspace. Ask a tenant administrator to review your
          role and scope assignments.
        </p>
      </section>
    </Shell>
  );
}
