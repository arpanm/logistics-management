import { Module } from "@nestjs/common";
import { ApiController } from "./api.controller.js";
import { AppService } from "./app.service.js";
import { AccessController } from "./access.controller.js";
import { AccessService } from "./access.service.js";

@Module({
  controllers: [AccessController, ApiController],
  providers: [AppService, AccessService],
})
export class AppModule {}
