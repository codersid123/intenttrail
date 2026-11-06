import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import { env } from "../config";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

// ---- Step 1: can we reach Google at all, and is the key valid? (15s limit) ----
console.log("Step 1: checking network + API key ...");
let flashModels: string[] = [];
try {
  const res = await fetch(
    `${BASE}/models?key=${env.GOOGLE_GENERATIVE_AI_API_KEY}`,
    {
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    console.error(`❌ Google rejected the request (${res.status}):`);
    console.error((await res.text()).slice(0, 400));
    console.error(
      "\n→ Your API key is wrong or not enabled. Make a new one at aistudio.google.com.",
    );
    process.exit(1);
  }
  const { models } = (await res.json()) as { models: { name: string }[] };
  flashModels = models
    .map((m) => m.name.replace("models/", ""))
    .filter((n) => n.includes("flash"));
  console.log(`✅ Network OK, key OK (${models.length} models visible)`);
} catch (err) {
  const e = err as Error & { cause?: { code?: string } };
  console.error(
    `❌ Could not reach Google: ${e.name === "TimeoutError" ? "timed out after 15s" : e.message}`,
  );
  if (e.cause?.code) console.error("   cause:", e.cause.code);
  console.error("\n→ Your network is blocking or stalling the Gemini API.");
  console.error(
    "  Try: switch to mobile hotspot, turn off VPN/proxy, then run again.",
  );
  process.exit(1);
}

// ---- Step 2: is the model name valid for this key? ----
if (!flashModels.includes(env.LLM_MODEL)) {
  console.error(`❌ Model "${env.LLM_MODEL}" is not available to your key.`);
  console.error("   Put one of these in LLM_MODEL in .env:");
  flashModels.forEach((n) => console.error("   -", n));
  process.exit(1);
}

// ---- Step 3: raw REST call, bypassing the AI SDK (60s limit) ----
console.log(`Step 2: raw REST call to ${env.LLM_MODEL} ...`);
const t0 = Date.now();
try {
  const raw = await fetch(
    `${BASE}/models/${env.LLM_MODEL}:generateContent?key=${env.GOOGLE_GENERATIVE_AI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          { parts: [{ text: "Reply with exactly: IntentTrail online" }] },
        ],
        generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  const body = await raw.text();
  if (!raw.ok) {
    console.error(
      `❌ Raw call failed (${raw.status}) after ${Date.now() - t0}ms:`,
    );
    console.error(body.slice(0, 400));
    process.exit(1);
  }
  console.log(`✅ Raw call OK in ${Date.now() - t0}ms`);
} catch (err) {
  const e = err as Error;
  console.error(
    `❌ Raw call: ${e.name === "TimeoutError" ? "timed out after 60s" : e.message}`,
  );
  console.error(
    "\n→ This model is not answering on your network/key. Set LLM_MODEL in .env to one of:",
  );
  flashModels.forEach((n) => console.error("   -", n));
  process.exit(1);
}

// ---- Step 4: same call through the AI SDK (what the app will use) ----
console.log(`Step 3: AI SDK call to ${env.LLM_MODEL} ...`);
try {
  const { text, usage } = await generateText({
    model: google(env.LLM_MODEL),
    prompt:
      "Reply with exactly these words and nothing else: IntentTrail online",
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(60_000),
    // Gemini 3.x Flash "thinks" a lot by default, which makes even tiny prompts slow
    providerOptions: { google: { thinkingConfig: { thinkingLevel: "low" } } },
  });
  console.log("✅ Gemini replied:", text.trim());
  console.log("   tokens used:", usage.totalTokens);
} catch (err) {
  const e = err as Error;
  console.error(
    "❌ Generation failed:",
    e.name === "TimeoutError" ? "timed out after 60s" : e.message,
  );
  if (/quota|429|RESOURCE_EXHAUSTED/i.test(e.message)) {
    console.error(
      "\n→ Free-tier limit hit for this model. Try a Flash-Lite model from this list:",
    );
    flashModels
      .filter((n) => n.includes("lite"))
      .forEach((n) => console.error("   -", n));
  }
  process.exit(1);
}
