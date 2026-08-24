import { Module } from "@nestjs/common";
import { ApiController } from "./api.controller.js";
import { AppService } from "./app.service.js";

@Module({ controllers: [ApiController], providers: [AppService] })
export class AppModule {}
