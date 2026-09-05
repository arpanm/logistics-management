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
import {
  InvitationEmailDeliveryService,
  InvitationEmailScheduler,
} from "./invitation-email.service.js";
import {
  ConversationController,
  ConversationService,
  WhatsappWebhookController,
} from "./modules/conversation/index.js";
import { MetaWhatsappAdapter } from "./modules/conversation/conversation-whatsapp.adapter.js";
import { ConversationFileService } from "./modules/conversation/conversation-file.service.js";
import {
  ConversationWhatsappScheduler,
  ConversationWhatsappService,
} from "./modules/conversation/conversation-whatsapp.service.js";

@Module({
  controllers: [
    AccessController,
    AccessMastersController,
    OperationsWorkbenchController,
    FinanceWorkbenchController,
    ControlWorkbenchController,
    GovernanceWorkbenchController,
    ConversationController,
    WhatsappWebhookController,
    ...intelligenceControllers,
    Mst01Controller,
    AdvancedDomainController,
    CanonicalController,
    KernelController,
    ApiController,
  ],
  providers: [
    AppService,
    InvitationEmailDeliveryService,
    InvitationEmailScheduler,
    AccessService,
    AccessMastersService,
    OperationsWorkbenchService,
    FinanceWorkbenchService,
    ControlWorkbenchService,
    GovernanceWorkbenchService,
    ConversationService,
    ConversationFileService,
    MetaWhatsappAdapter,
    ConversationWhatsappService,
    ConversationWhatsappScheduler,
    KernelService,
    ...intelligenceProviders,
    CanonicalService,
    OperationalWorkerService,
    AdvancedDomainService,
    Mst01Service,
  ],
})
export class AppModule {}
