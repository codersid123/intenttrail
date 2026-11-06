import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";

// Load the .env file at the repo root (3 folders up from this file)
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../../../.env"), quiet: true });

const EnvSchema = z.object({
  PAYPAL_CLIENT_ID: z.string().min(1, "PAYPAL_CLIENT_ID is missing in .env"),
  PAYPAL_CLIENT_SECRET: z
    .string()
    .min(1, "PAYPAL_CLIENT_SECRET is missing in .env"),
  PAYPAL_BASE_URL: z.string().default("https://api-m.sandbox.paypal.com"),
  PAYPAL_VAULT_ID: z.string().optional(),
  PAYMENT_MODE: z.enum(["paypal", "mock"]).default("paypal"),
  GOOGLE_GENERATIVE_AI_API_KEY: z
    .string()
    .min(1, "GOOGLE_GENERATIVE_AI_API_KEY is missing in .env"),
  LLM_MODEL: z.string().default("gemini-3.8-flash"),
  DATABASE_PATH: z.string().default("./intenttrail.db"),
  PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Bad .env:");
  for (const issue of parsed.error.issues)
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
