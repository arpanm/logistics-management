import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module.js";
import { isRequestOriginAllowed, loadConfig } from "@logistics/config";

const config = loadConfig();
const app = await NestFactory.create(AppModule, { rawBody: false });
app.setGlobalPrefix("api/v1");
app.use(cookieParser());
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  }),
);
app.enableCors({
  origin: (
    origin: string | undefined,
    callback: (error: Error | null, allowed?: boolean) => void,
  ) => callback(null, !origin || isRequestOriginAllowed(origin, config)),
  credentials: true,
  allowedHeaders: [
    "Content-Type",
    "X-CSRF-Token",
    "Idempotency-Key",
    "X-Correlation-Id",
    "X-Test-Failure",
  ],
});
app.use(
  (
    req: {
      headers: Record<string, string | undefined>;
      correlationId?: string;
    },
    res: { setHeader: (k: string, v: string) => void },
    next: () => void,
  ) => {
    const incoming = req.headers["x-correlation-id"];
    const correlationId =
      typeof incoming === "string" && incoming.length <= 100
        ? incoming
        : crypto.randomUUID();
    req.correlationId = correlationId;
    res.setHeader("X-Correlation-Id", correlationId);
    next();
  },
);
app.enableShutdownHooks();
await app.listen(config.BACKEND_PORT, "127.0.0.1");
