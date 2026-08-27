"use client";
import { FormEvent, useState } from "react";
import { api, type ApiError } from "../api";
import { Shell } from "../shell";
import { SmartField } from "../forms/smart-field";

const governedResources: Record<string, string> = {
  ORGANIZATION_NODE: "organization-nodes",
  EMPLOYEE: "employees",
  CLIENT: "clients",
  VENDOR: "vendors",
  VEHICLE: "vehicles",
  DRIVER: "drivers",
  INDENT: "indents",
  ALLOCATION: "allocations",
  TRIP: "trips",
  POD: "pod-tasks",
  INVOICE: "invoices",
  RECEIPT: "receipts",
  VENDOR_BILL: "vendor-bills",
};

export function GovernanceWorkspace() {
  const [targetType, setTargetType] = useState("TRIP"),
    [targetId, setTargetId] = useState(""),
    [comment, setComment] = useState(""),
    [visibility, setVisibility] = useState("INTERNAL"),
    [comments, setComments] = useState<Array<Record<string, unknown>>>([]),
    [notice, setNotice] = useState(""),
    [error, setError] = useState<ApiError | null>(null);
  const [definitions, setDefinitions] = useState<
      Array<Record<string, unknown>>
    >([]),
    [definitionId, setDefinitionId] = useState("");
  const [file, setFile] = useState<File | null>(null),
    [category, setCategory] = useState("POD"),
    [confidentiality, setConfidentiality] = useState("INTERNAL");
  async function loadComments() {
    try {
      setComments(
        await api(
          `/domain/governance/comments/${encodeURIComponent(targetType)}/${targetId}`,
        ),
      );
      const available = await api<Array<Record<string, unknown>>>(
        "/domain/governance/approval-definitions",
      );
      setDefinitions(available);
      if (!definitionId && available[0])
        setDefinitionId(String(available[0].id));
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function requestApproval() {
    try {
      await api("/domain/governance/approvals", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          definitionId,
          targetType,
          targetId,
          snapshot: {
            targetType,
            targetId,
            capturedAt: new Date().toISOString(),
          },
        }),
      });
      setNotice("Approval requested from the configured role sequence.");
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function addComment(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/domain/governance/comments", {
        method: "POST",
        body: JSON.stringify({
          targetType,
          targetId,
          body: comment,
          visibility,
        }),
      });
      setComment("");
      setNotice("Comment added with audience visibility.");
      await loadComments();
    } catch (value) {
      setError(value as ApiError);
    }
  }
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    const formElement = event.currentTarget as HTMLFormElement;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const checksum = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      )
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      let binary = "";
      for (const value of bytes) binary += String.fromCharCode(value);
      await api("/domain/governance/documents", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          targetType,
          targetId,
          category,
          confidentiality,
          fileName: file.name,
          mediaType: file.type,
          contentBase64: btoa(binary),
          checksumSha256: checksum,
        }),
      });
      setFile(null);
      formElement.reset();
      setNotice("Verified document version stored in PostgreSQL.");
    } catch (value) {
      setError(value as ApiError);
    }
  }
  return (
    <Shell>
      <div className="heading">
        <div>
          <p className="eyebrow">GOV-01</p>
          <h1>Governed evidence</h1>
          <p className="muted">
            Versioned files, audience-aware comments, approval snapshots and
            immutable audit.
          </p>
        </div>
      </div>
      {error && (
        <div role="alert" className="error">
          {error.message}
        </div>
      )}
      {notice && (
        <p role="status" className="success">
          {notice}
        </p>
      )}
      <section className="panel" aria-labelledby="governed-target">
        <h2 id="governed-target">Record context</h2>
        <div className="access-form">
          <label>
            Record type
            <select
              value={targetType}
              onChange={(event) => {
                setTargetType(event.target.value);
                setTargetId("");
              }}
            >
              {Object.keys(governedResources).map((type) => (
                <option key={type} value={type}>
                  {type.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <SmartField
            field={{
              key: "governedRecord",
              label: "Record",
              kind: "reference",
              referenceResource: governedResources[targetType],
              required: true,
              help: "Search and select the business record whose documents, comments and approvals you want to manage.",
            }}
            value={targetId}
            onChange={setTargetId}
          />
          <button type="button" onClick={() => void loadComments()}>
            Load governed tabs
          </button>
        </div>
      </section>
      <section className="panel" aria-labelledby="documents-tab">
        <h2 id="documents-tab">Documents</h2>
        <form
          className="access-form"
          noValidate
          onSubmit={(event) => void upload(event)}
        >
          <label>
            Category
            <input
              required
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            />
          </label>
          <label>
            Visibility
            <select
              value={confidentiality}
              onChange={(event) => setConfidentiality(event.target.value)}
            >
              <option>INTERNAL</option>
              <option>CLIENT</option>
              <option>VENDOR</option>
              <option>DRIVER</option>
            </select>
          </label>
          <label>
            PDF or image
            <input
              required
              type="file"
              accept="application/pdf,image/jpeg,image/png"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <button className="primary">Upload verified version</button>
        </form>
      </section>
      <section className="panel" aria-labelledby="comments-tab">
        <h2 id="comments-tab">Comments</h2>
        <form
          className="access-form"
          onSubmit={(event) => void addComment(event)}
        >
          <label>
            Audience
            <select
              value={visibility}
              onChange={(event) => setVisibility(event.target.value)}
            >
              <option>INTERNAL</option>
              <option>CLIENT</option>
              <option>VENDOR</option>
              <option>DRIVER</option>
            </select>
          </label>
          <label>
            Comment
            <textarea
              required
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
          <button className="primary">Add comment</button>
        </form>
        <div className="responsive-list">
          {comments.map((row) => (
            <article className="access-card" key={String(row.id)}>
              <h3>{String(row.visibility)}</h3>
              <p>{String(row.body)}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="panel" aria-labelledby="approvals-tab">
        <h2 id="approvals-tab">Approvals and audit</h2>
        <p className="muted">
          Approval requests retain the submitted snapshot; decision makers and
          immutable before/after audit are enforced by the domain API.
        </p>
        <div className="access-form">
          <label>
            Approval policy
            <select
              value={definitionId}
              onChange={(event) => setDefinitionId(event.target.value)}
            >
              <option value="">Select…</option>
              {definitions.map((definition) => (
                <option
                  key={String(definition.id)}
                  value={String(definition.id)}
                >
                  {String(definition.code)} — {String(definition.targetType)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!definitionId || !targetId}
            onClick={() => void requestApproval()}
          >
            Request snapshot approval
          </button>
        </div>
      </section>
    </Shell>
  );
}
