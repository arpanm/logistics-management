import { Suspense } from "react";
import { AcceptAccessPage } from "../../components/access-pages";
export default function Page() {
  return (
    <Suspense fallback={<p role="status">Loading invitation…</p>}>
      <AcceptAccessPage />
    </Suspense>
  );
}
