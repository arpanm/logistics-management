import { z } from "zod";

const normalizeMobile = (value: unknown) =>
  typeof value === "string" ? value.trim().replace(/[\s().-]/g, "") : value;

export const e164MobileSchema = z.preprocess(
  normalizeMobile,
  z
    .string()
    .regex(
      /^\+[1-9]\d{7,14}$/,
      "Enter a valid mobile number with country code",
    ),
);
