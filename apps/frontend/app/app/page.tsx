import Link from "next/link";
import { Shell } from "../../components/shell";
export default function Page() {
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>Operations access home</h1>
          <p className="muted">
            Your navigation and queues are derived from effective server
            permissions.
          </p>
        </div>
      </div>
      <div className="cards">
        <Link className="panel" href="/app/access/probes">
          Open work queue
        </Link>
        <Link className="panel" href="/app/access/users">
          Manage access
        </Link>
      </div>
    </Shell>
  );
}
