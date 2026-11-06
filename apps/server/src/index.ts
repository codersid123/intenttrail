import express from "express";
import cors from "cors";
import { FAULT_CODES } from "@intenttrail/shared";
import { env } from "./config";
import { openDb } from "./db/db";
import { makeProvider } from "./paypal/make-provider";
import { mountReturnPages } from "./paypal/return-page";
import { runsRouter } from "./routes/runs";

const db = openDb(env.DATABASE_PATH);
const provider = makeProvider();

const app = express();
app.use(cors({ origin: env.WEB_ORIGIN }));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    paymentMode: env.PAYMENT_MODE,
    payments: provider.label,
    llmModel: env.LLM_MODEL,
    faultCodes: FAULT_CODES,
  });
});

app.use("/api", runsRouter(db, provider));
mountReturnPages(app);

app.listen(env.PORT, () => {
  console.log(`IntentTrail server → http://localhost:${env.PORT}  (payments: ${provider.label})`);
});
