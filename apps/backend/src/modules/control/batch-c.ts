import { AlertsProvider } from "../alerts/alerts.provider.js";
import { alertsManifest } from "../alerts/manifest.js";
import { DataProvider } from "../data/data.provider.js";
import { dataManifest } from "../data/manifest.js";
import { IntegrationsProvider } from "../integrations/integrations.provider.js";
import { integrationsManifest } from "../integrations/manifest.js";
import { ControlProvider } from "./control.provider.js";
import { IntelligenceController } from "./intelligence.controller.js";
import { controlManifest } from "./manifest.js";

export const intelligenceManifests = [
  controlManifest,
  alertsManifest,
  dataManifest,
  integrationsManifest,
] as const;

export const intelligenceNavigation = intelligenceManifests.map((manifest) => ({
  feature: manifest.code,
  ...manifest.navigation,
}));

export const intelligenceControllers = [IntelligenceController] as const;
export const intelligenceProviders = [
  ControlProvider,
  AlertsProvider,
  DataProvider,
  IntegrationsProvider,
] as const;
