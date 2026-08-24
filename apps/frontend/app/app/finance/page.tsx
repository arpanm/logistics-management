import Link from "next/link";
import { Shell } from "../../../components/shell";

export default function FinancePage() {
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">Finance</p>
          <h1>Billing, collections, and payables</h1>
          <p className="muted">
            Exact minor-unit ledgers and approval workflows.
          </p>
        </div>
      </div>
      <div className="responsive-list">
        <article className="access-card">
          <h2>Client invoices</h2>
          <Link href="/app/finance/invoices">Open billing</Link>
        </article>
        <article className="access-card">
          <h2>Receipts & collections</h2>
          <Link href="/app/finance/receipts">Open collections</Link>
        </article>
        <article className="access-card">
          <h2>Vendor bills</h2>
          <Link href="/app/finance/vendor-bills">Open payables</Link>
        </article>
      </div>
    </Shell>
  );
}
