import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { DataProvider } from "../data/data.provider.js";
import { ConversationFileService } from "./conversation-file.service.js";

const hash = (content: Buffer) =>
  createHash("sha256").update(content).digest("hex");
const minimalPdf = () => {
  const header = "%PDF-1.4\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] >>\nendobj\n",
  ];
  const offsets: number[] = [];
  let body = header;
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body, "ascii");
  const xref = `xref\n0 4\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body + xref, "ascii");
};
const actor = {
  userId: "10000000-0000-4000-8000-000000000001",
  email: "operator@example.test",
  platformAdmin: false,
  contextVersion: 1,
  csrfToken: "csrf-test-token",
  activeTenantId: "10000000-0000-4000-8000-000000000002",
  membershipId: "10000000-0000-4000-8000-000000000003",
};
const attachmentId = "10000000-0000-4000-8000-000000000004";

describe("INT02-FILE-001 attachment validation", () => {
  const service = new ConversationFileService({} as never);

  it("accepts a checksum-bound CSV dataset and prepares it for DAT-01", () => {
    const content = Buffer.from("Client Code,Client Name\nC1,Acme\n");
    expect(
      service.validateAttachment({
        filename: "clients.csv",
        mediaType: "text/csv",
        byteSize: content.length,
        checksumSha256: hash(content),
        contentBase64: content.toString("base64"),
        dataset: "CLIENT",
        sourceTimezone: "Asia/Kolkata",
        importMode: "UPSERT",
      }),
    ).toMatchObject({
      filename: "clients.csv",
      dataset: "CLIENT",
      scanState: "PENDING",
      importMetadata: {
        sourceTimezone: "Asia/Kolkata",
        importMode: "UPSERT",
      },
    });
  });

  it("validates and parses actual CSV bytes without mocking DAT persistence", async () => {
    const content = Buffer.from(
      'Client Code,Client Name\nC1,"Acme, India"\nC2,Northwind\n',
      "utf8",
    );
    const prepared = service.validateAttachment({
      filename: "clients.csv",
      mediaType: "text/csv",
      byteSize: content.length,
      checksumSha256: hash(content),
      contentBase64: content.toString("base64"),
      dataset: "CLIENT",
      sourceTimezone: "Asia/Kolkata",
      importMode: "UPSERT",
    });
    const parsed = await new DataProvider({} as never).parseFile(
      prepared.filename,
      prepared.mediaType,
      prepared.content.toString("base64"),
    );

    expect(parsed).toMatchObject({
      headers: ["Client Code", "Client Name"],
      rows: [
        { "Client Code": "C1", "Client Name": "Acme, India" },
        { "Client Code": "C2", "Client Name": "Northwind" },
      ],
      byteSize: content.length,
      checksum: hash(content),
    });
  });

  it("validates and parses a generated single-sheet XLSX using its real ZIP bytes", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Clients");
    sheet.addRow(["Client Code", "Client Name"]);
    sheet.addRow(["C1", "Acme India"]);
    const encoded = await workbook.xlsx.writeBuffer();
    const content = Buffer.from(encoded);
    const prepared = service.validateAttachment({
      filename: "clients.xlsx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: content.length,
      checksumSha256: hash(content),
      contentBase64: content.toString("base64"),
      dataset: "CLIENT",
      sourceTimezone: "Asia/Kolkata",
      importMode: "APPEND",
    });
    const parsed = await new DataProvider({} as never).parseFile(
      prepared.filename,
      prepared.mediaType,
      prepared.content.toString("base64"),
    );

    expect(prepared.content.subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    );
    expect(parsed).toMatchObject({
      headers: ["Client Code", "Client Name"],
      rows: [{ "Client Code": "C1", "Client Name": "Acme India" }],
      byteSize: content.length,
      checksum: hash(content),
    });
  });

  it("accepts real PDF bytes as quarantined governed content", () => {
    const content = minimalPdf();
    expect(
      service.validateAttachment({
        filename: "proof.pdf",
        mediaType: "application/pdf",
        byteSize: content.length,
        checksumSha256: hash(content),
        contentBase64: content.toString("base64"),
      }),
    ).toMatchObject({
      mediaType: "application/pdf",
      scanState: "QUARANTINED",
      dataset: null,
    });
  });

  it("accepts decoded 1x1 PNG bytes as quarantined governed content", () => {
    const content = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    expect(
      service.validateAttachment({
        filename: "pod.png",
        mediaType: "image/png",
        byteSize: content.length,
        checksumSha256: hash(content),
        contentBase64: content.toString("base64"),
      }),
    ).toMatchObject({
      mediaType: "image/png",
      scanState: "QUARANTINED",
      dataset: null,
    });
  });

  it("preserves the raw checksum for a valid UTF-8 BOM CSV", () => {
    const content = Buffer.from("\uFEFFClient Code,Client Name\nC1,Acme\n");
    expect(
      service.validateAttachment({
        filename: "clients.csv",
        mediaType: "text/csv",
        byteSize: content.length,
        checksumSha256: hash(content),
        contentBase64: content.toString("base64"),
        dataset: "CLIENT",
      }).checksumSha256,
    ).toBe(hash(content));
  });

  it("rejects extension/content mismatches before bytes are stored", () => {
    const content = Buffer.from("not a pdf");
    expect(() =>
      service.validateAttachment({
        filename: "proof.pdf",
        mediaType: "application/pdf",
        byteSize: content.length,
        checksumSha256: hash(content),
        contentBase64: content.toString("base64"),
      }),
    ).toThrow(/extension, declared type and content/i);
  });

  it("rejects a forged checksum", () => {
    const content = Buffer.from("Client Code\nC1\n");
    expect(() =>
      service.validateAttachment({
        filename: "clients.csv",
        mediaType: "text/csv",
        byteSize: content.length,
        checksumSha256: "0".repeat(64),
        contentBase64: content.toString("base64"),
        dataset: "CLIENT",
      }),
    ).toThrow(/checksum/i);
  });
});

describe("INT02-FILE-002 governed handoffs", () => {
  it("passes validated content to the mocked DAT preview boundary and records its handoff", async () => {
    const content = Buffer.from("Client Code,Client Name\nC1,Acme\n");
    const data = {
      parseFile: vi.fn().mockResolvedValue({
        headers: ["Client Code", "Client Name"],
        rows: [{ "Client Code": "C1", "Client Name": "Acme" }],
        byteSize: content.length,
        checksum: hash(content),
      }),
      previewInTransaction: vi.fn().mockResolvedValue({
        id: "10000000-0000-4000-8000-000000000005",
        state: "VALIDATED",
        version: 1,
        summary: { rows: 1 },
      }),
    };
    const tx = {
      $queryRawUnsafe: vi.fn(async (sql: string) => {
        if (sql.includes("FROM app.conversation_attachments"))
          return [
            {
              id: attachmentId,
              filename: "clients.csv",
              mediaType: "text/csv",
              byteSize: content.length,
              checksum: hash(content),
              content,
              scanState: "PENDING",
              dataset: "CLIENT",
              metadata: {
                sourceTimezone: "Asia/Kolkata",
                importMode: "UPSERT",
              },
            },
          ];
        if (sql.includes("FROM app.conversation_file_handoffs")) return [];
        return [];
      }),
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    };
    const service = new ConversationFileService(data as never);
    const result = await service.previewImportInTransaction(
      tx as never,
      actor,
      {
        attachmentId,
        idempotencyKey: "preview-key-001",
        correlationId: "corr-001",
      },
    );

    expect(result).toMatchObject({
      importJobId: "10000000-0000-4000-8000-000000000005",
      state: "VALIDATED",
    });
    expect(data.previewInTransaction).toHaveBeenCalledWith(
      tx,
      actor,
      expect.objectContaining({ dataset: "CLIENT", importMode: "UPSERT" }),
    );
    expect(
      tx.$executeRawUnsafe.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO app.conversation_file_handoffs"),
      ),
    ).toBe(true);
  });

  it("does not expose an attachment owned by another membership", async () => {
    const data = { parseFile: vi.fn(), previewInTransaction: vi.fn() };
    const tx = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
      $executeRawUnsafe: vi.fn(),
    };
    const service = new ConversationFileService(data as never);

    await expect(
      service.previewImportInTransaction(tx as never, actor, {
        attachmentId,
        idempotencyKey: "preview-key-002",
        correlationId: "corr-002",
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_NOT_FOUND" });
    expect(data.previewInTransaction).not.toHaveBeenCalled();
  });

  it("replays the same preview without creating a second DAT-01 job", async () => {
    const content = Buffer.from("Client Code,Client Name\nC1,Acme\n");
    const idempotencyKey = "preview-key-003";
    const request = {
      attachmentId,
      dataset: "CLIENT",
      checksumSha256: hash(content),
      importMetadata: {
        sourceTimezone: "Asia/Kolkata",
        importMode: "APPEND",
      },
      operation: "IMPORT_PREVIEW",
    };
    const data = { parseFile: vi.fn(), previewInTransaction: vi.fn() };
    const tx = {
      $queryRawUnsafe: vi.fn(async (sql: string) => {
        if (sql.includes("FROM app.conversation_attachments"))
          return [
            {
              filename: "clients.csv",
              mediaType: "text/csv",
              byteSize: content.length,
              checksum: hash(content),
              content,
              scanState: "PENDING",
              dataset: "CLIENT",
              metadata: request.importMetadata,
            },
          ];
        if (sql.includes("FROM app.conversation_file_handoffs"))
          return [
            {
              actorId: actor.userId,
              membershipId: actor.membershipId,
              keyHash: createHash("sha256")
                .update(
                  `${actor.activeTenantId}:${actor.userId}:${idempotencyKey}`,
                )
                .digest("hex"),
              requestHash: createHash("sha256")
                .update(JSON.stringify(request))
                .digest("hex"),
              result: {
                attachmentId,
                importJobId: "10000000-0000-4000-8000-000000000005",
                state: "VALIDATED",
                version: 1,
              },
            },
          ];
        return [];
      }),
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    };
    const service = new ConversationFileService(data as never);

    await expect(
      service.previewImportInTransaction(tx as never, actor, {
        attachmentId,
        idempotencyKey,
        correlationId: "corr-004",
      }),
    ).resolves.toMatchObject({ replayed: true, state: "VALIDATED" });
    expect(data.previewInTransaction).not.toHaveBeenCalled();
  });

  it("fails closed before committing a financial dataset through generic DAT", async () => {
    const data = { commitInTransaction: vi.fn() };
    const tx = {
      $queryRawUnsafe: vi.fn(async (sql: string) => {
        if (sql.includes("FROM app.conversation_attachments"))
          return [
            {
              id: attachmentId,
              filename: "collections.csv",
              mediaType: "text/csv",
              byteSize: 10,
              checksum: "a".repeat(64),
              content: Buffer.from("placeholder"),
              scanState: "PENDING",
              dataset: "INVOICE_COLLECTION",
              metadata: {},
            },
          ];
        return [];
      }),
      $executeRawUnsafe: vi.fn(),
    };
    const service = new ConversationFileService(data as never);

    await expect(
      service.commitImportInTransaction(tx as never, actor, {
        attachmentId,
        jobId: "10000000-0000-4000-8000-000000000005",
        expectedVersion: 1,
        idempotencyKey: "financial-commit-key",
        correlationId: "corr-finance",
      }),
    ).rejects.toMatchObject({
      code: "FINANCIAL_IMPORT_REQUIRES_CANONICAL_WORKFLOW",
    });
    expect(data.commitInTransaction).not.toHaveBeenCalled();
  });

  it("creates a pending governed version without claiming the file is clean", async () => {
    const content = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.from("governed evidence"),
    ]);
    const tx = {
      $queryRawUnsafe: vi.fn(async (sql: string) => {
        if (sql.includes("FROM app.conversation_attachments"))
          return [
            {
              id: attachmentId,
              filename: "pod.pdf",
              mediaType: "application/pdf",
              byteSize: content.length,
              checksum: hash(content),
              content,
              scanState: "QUARANTINED",
              dataset: null,
              metadata: {},
            },
          ];
        if (sql.includes("domain_resource_authorized"))
          return [{ allowed: true }];
        if (sql.includes("FROM app.conversation_file_handoffs")) return [];
        if (sql.includes("INSERT INTO app.governed_documents"))
          return [
            { id: "10000000-0000-4000-8000-000000000006", currentVersion: 1 },
          ];
        if (sql.includes("INSERT INTO app.governed_document_versions"))
          return [
            {
              id: "10000000-0000-4000-8000-000000000007",
              documentId: "10000000-0000-4000-8000-000000000006",
              version: 1,
              malwareState: "PENDING",
            },
          ];
        return [];
      }),
      $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    };
    const service = new ConversationFileService({} as never);
    const result = await service.createGovernedDocumentInTransaction(
      tx as never,
      actor,
      {
        attachmentId,
        targetType: "POD",
        targetId: "10000000-0000-4000-8000-000000000008",
        category: "POD",
        confidentiality: "CLIENT",
        idempotencyKey: "document-key-001",
        correlationId: "corr-003",
      },
    );

    expect(result).toMatchObject({
      malwareState: "PENDING",
      verificationState: "PENDING",
    });
    const versionInsert = tx.$queryRawUnsafe.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO app.governed_document_versions"),
    );
    expect(String(versionInsert?.[0])).toContain("'PENDING'");
    expect(String(versionInsert?.[0])).not.toContain("'CLEAN'");
  });
});
