import { Module } from "@nestjs/common";
import { ApiController } from "./api.controller.js";
import { AppService } from "./app.service.js";
import { AccessController } from "./access.controller.js";
import { AccessService } from "./access.service.js";
import { KernelController } from "./modules/kernel/kernel.controller.js";
import { KernelService } from "./modules/kernel/index.js";
import {
  intelligenceControllers,
  intelligenceProviders,
  ControlWorkbenchController,
  ControlWorkbenchService,
} from "./modules/control/index.js";
import {
  CanonicalController,
  CanonicalService,
  OperationalWorkerService,
  AdvancedDomainController,
  AdvancedDomainService,
  Mst01Controller,
  Mst01Service,
} from "./modules/canonical/index.js";
import {
  AccessMastersController,
  AccessMastersService,
} from "./modules/remediation/index.js";
import {
  OperationsWorkbenchController,
  OperationsWorkbenchService,
} from "./modules/operations/index.js";
import {
  FinanceWorkbenchController,
  FinanceWorkbenchService,
} from "./modules/finance/index.js";
import {
  GovernanceWorkbenchController,
  GovernanceWorkbenchService,
} from "./modules/governance/index.js";

@Module({
  controllers: [
    AccessController,
    AccessMastersController,
    OperationsWorkbenchController,
    FinanceWorkbenchController,
    ControlWorkbenchController,
    GovernanceWorkbenchController,
    ...intelligenceControllers,
    Mst01Controller,
    AdvancedDomainController,
    CanonicalController,
    KernelController,
    ApiController,
  ],
  providers: [
    AppService,
    AccessService,
    AccessMastersService,
    OperationsWorkbenchService,
    FinanceWorkbenchService,
    ControlWorkbenchService,
    GovernanceWorkbenchService,
    KernelService,
    ...intelligenceProviders,
    CanonicalService,
    OperationalWorkerService,
    AdvancedDomainService,
    Mst01Service,
  ],
})
export class AppModule {}
