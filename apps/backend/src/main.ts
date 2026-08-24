import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module.js";
import { loadConfig } from "@logistics/config";

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
  origin: config.FRONTEND_URL,
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
    req: { headers: Record<string, string | undefined> },
    res: { setHeader: (k: string, v: string) => void },
    next: () => void,
  ) => {
    const incoming = req.headers["x-correlation-id"];
    res.setHeader(
      "X-Correlation-Id",
      typeof incoming === "string" && incoming.length <= 100
        ? incoming
        : crypto.randomUUID(),
    );
    next();
  },
);
app.enableShutdownHooks();
await app.listen(config.BACKEND_PORT, "127.0.0.1");
