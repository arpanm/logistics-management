import Link from "next/link";
import { Shell } from "../../../components/shell";

export default function OperationsPage() {
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>Transport execution</h1>
          <p className="muted">Demand, placement, and trip workflows.</p>
        </div>
      </div>
      <div className="responsive-list">
        <article className="access-card">
          <h2>Indents</h2>
          <p>Capture and own customer demand.</p>
          <Link href="/app/operations/indents">Open work queue</Link>
        </article>
        <article className="access-card">
          <h2>Vendor placement</h2>
          <p>Offer, allocate, assign, and place.</p>
          <Link href="/app/operations/allocations">Open placement</Link>
        </article>
        <article className="access-card">
          <h2>Trips</h2>
          <p>Loading, transit, unloading, and exceptions.</p>
          <Link href="/app/operations/trips">Open live trips</Link>
        </article>
      </div>
    </Shell>
  );
}
