import { Module } from "@nestjs/common";
import { AppService } from "../../app.service.js";
import { KernelController } from "./kernel.controller.js";
import { KernelService } from "./kernel.service.js";

@Module({
  controllers: [KernelController],
  providers: [AppService, KernelService],
  exports: [KernelService],
})
export class KernelModule {}
