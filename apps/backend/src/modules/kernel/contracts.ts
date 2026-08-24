export type KernelModuleKey =
  | "masters"
  | "governance"
  | "configuration"
  | "control"
  | "alerts"
  | "data"
  | "integrations"
  | "operations"
  | "pod"
  | "finance";
export type KernelRecordInput = {
  code: string;
  name: string;
  data?: Record<string, unknown>;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
};
export type KernelRecordUpdate = Partial<KernelRecordInput> & {
  expectedVersion: number;
};
export type KernelTransitionInput = {
  toStatus: string;
  expectedVersion: number;
  reason?: string;
};
export type KernelManifest = {
  feature: string;
  module: KernelModuleKey;
  resource: string;
  initialStatus: string;
  statuses: readonly string[];
};
export type KernelNavDescriptor = {
  feature: string;
  label: string;
  href: string;
  module: KernelModuleKey;
};
