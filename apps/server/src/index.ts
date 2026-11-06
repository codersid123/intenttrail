import express from "express";
import cors from "cors";
import { FAULT_CODES } from "@intenttrail/shared";
import { env } from "./config";

const app = express();
app.use(cors({ origin: env.WEB_ORIGIN }));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    paymentMode: env.PAYMENT_MODE,
    llmModel: env.LLM_MODEL,
    faultCodes: FAULT_CODES,
  });
});

app.listen(env.PORT, () => {
  console.log(
    `IntentTrail server → http://localhost:${env.PORT}  (mode: ${env.PAYMENT_MODE})`,
  );
});
