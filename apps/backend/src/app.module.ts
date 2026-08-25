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
} from "./modules/control/index.js";
import {
  CanonicalController,
  CanonicalService,
  OperationalWorkerService,
  AdvancedDomainController,
  AdvancedDomainService,
} from "./modules/canonical/index.js";

@Module({
  controllers: [
    AccessController,
    ...intelligenceControllers,
    AdvancedDomainController,
    CanonicalController,
    KernelController,
    ApiController,
  ],
  providers: [
    AppService,
    AccessService,
    KernelService,
    ...intelligenceProviders,
    CanonicalService,
    OperationalWorkerService,
    AdvancedDomainService,
  ],
})
export class AppModule {}
