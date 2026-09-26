// Live checks against the real OpenAI API. Run with `OPENAI_API_KEY=... pnpm test:live`; skipped
// without a key. Each case spends a handful of tokens on the cheapest flex model.
import OpenAI from "openai";
import { describe, expect, it } from "vitest";

import { withFlex, type FlexOutcome } from "../src/index.js";
import { OPENAI_API_KEY } from "./env.js";

const FLEX_MODEL = "gpt-6-luna";
// gpt-4o has no flex tier: OpenAI answers a flex request for it with a 400.
const NO_FLEX_MODEL = "gpt-4o";

function inSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function client(): { flex: ReturnType<typeof withFlex>; outcomes: FlexOutcome[] } {
  const outcomes: FlexOutcome[] = [];
  const flex = withFlex(new OpenAI({ apiKey: OPENAI_API_KEY }), { onOutcome: (o) => outcomes.push(o) });
  return { flex, outcomes };
}

describe.skipIf(OPENAI_API_KEY === undefined)("flex-race against the live OpenAI API", () => {
  it("serves a non-streaming request on flex when flex admits it in time", async () => {
    const { flex, outcomes } = client();
    const response = await flex.responses.create({
      model: FLEX_MODEL,
      input: "Reply with the single word: ok",
      max_output_tokens: 32,
      start_by: inSeconds(120),
    });
    expect(response.status).toBe("completed");
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    // Flex capacity is OpenAI's to give; either outcome is correct behaviour, and the served tier
    // must match the reported one.
    expect(response.service_tier).toBe(outcome?.tier === "flex" ? "flex" : "default");
  });

  it("streams a request and ends on a completed event", async () => {
    const { flex, outcomes } = client();
    const stream = await flex.responses.create({
      model: FLEX_MODEL,
      input: "Reply with the single word: ok",
      max_output_tokens: 32,
      stream: true,
      start_by: inSeconds(120),
    });
    const types: string[] = [];
    let servedTier: string | null | undefined;
    for await (const event of stream) {
      types.push(event.type);
      if (event.type === "response.completed") servedTier = event.response.service_tier;
    }
    expect(types[0]).toBe("response.created");
    expect(types.at(-1)).toBe("response.completed");
    expect(servedTier).toBe(outcomes[0]?.tier === "flex" ? "flex" : "default");
  });

  it("falls back to the default tier on a model without flex", async () => {
    const { flex, outcomes } = client();
    const response = await flex.responses.create({
      model: NO_FLEX_MODEL,
      input: "Reply with the single word: ok",
      max_output_tokens: 32,
      start_by: inSeconds(120),
    });
    expect(response.status).toBe("completed");
    expect(response.service_tier).toBe("default");
    expect(outcomes[0]).toMatchObject({ tier: "default", reason: "flex_refused" });
  });

  it("skips flex when start_by is too near", async () => {
    const { flex, outcomes } = client();
    const response = await flex.responses.create({
      model: FLEX_MODEL,
      input: "Reply with the single word: ok",
      max_output_tokens: 32,
      start_by: inSeconds(2),
    });
    expect(response.service_tier).toBe("default");
    expect(outcomes[0]).toMatchObject({ tier: "default", reason: "deadline_too_near" });
  });
});
