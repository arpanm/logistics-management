-- FIN-01/02/03 workbench query support. Canonical financial records remain authoritative.
CREATE INDEX IF NOT EXISTS client_invoices_workbench
  ON app.client_invoices(tenant_id,state,due_date,created_at);
CREATE INDEX IF NOT EXISTS receipts_allocation_workbench
  ON app.receipts(tenant_id,state,payment_date,created_at);
CREATE INDEX IF NOT EXISTS receipt_ledger_receipt
  ON app.receipt_ledger_entries(tenant_id,receipt_id,created_at);
CREATE INDEX IF NOT EXISTS collection_followups_queue
  ON app.collection_followups(tenant_id,invoice_id,next_followup_at,created_at DESC);
CREATE INDEX IF NOT EXISTS vendor_bills_workbench
  ON app.vendor_bills(tenant_id,state,invoice_date,created_at);
CREATE INDEX IF NOT EXISTS payment_batches_workbench
  ON app.payment_batches(tenant_id,state,created_at DESC);

COMMENT ON INDEX app.client_invoices_workbench IS
  'FIN-01 approval, posting, unsubmitted and FIN-02 collection queues';
COMMENT ON INDEX app.vendor_bills_workbench IS
  'FIN-03 validation, approval, payable and payment-run queues';
