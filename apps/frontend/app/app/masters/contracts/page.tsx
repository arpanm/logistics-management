import {
  CanonicalWorkspace,
  canonicalManifests,
} from "../../../../components/canonical";
export default function Page() {
  return <CanonicalWorkspace manifest={canonicalManifests.contracts} />;
}
