import { Module } from "@nestjs/common";
import { AppService } from "../../app.service.js";
import { AccessService } from "../../access.service.js";
import { AlertsProvider } from "../alerts/alerts.provider.js";
import { IntegrationsProvider } from "../integrations/integrations.provider.js";
import { KernelController } from "./kernel.controller.js";
import { KernelService } from "./kernel.service.js";

@Module({
  controllers: [KernelController],
  providers: [
    AppService,
    AccessService,
    AlertsProvider,
    IntegrationsProvider,
    KernelService,
  ],
  exports: [KernelService],
})
export class KernelModule {}
