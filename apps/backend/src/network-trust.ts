import type { INestApplication } from "@nestjs/common";
import type { Request } from "express";

export const configureLoopbackProxyTrust = (app: INestApplication) => {
  const express = app.getHttpAdapter().getInstance() as {
    set(name: string, value: string): void;
  };
  // The backend listens on loopback, so only the colocated Nginx hop may
  // supply forwarding information. Express then resolves the first untrusted
  // address from the right of X-Forwarded-For.
  express.set("trust proxy", "loopback");
};

export const trustedConnectionSource = (req: Request) =>
  req.ip ?? req.socket?.remoteAddress ?? "unknown";
