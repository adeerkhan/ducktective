import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Input = z.object({
  symptom: z.string().trim().min(8).max(4000),
});

const Draft = z.object({
  symptom: z.string().optional(),
  reproduction: z
    .object({
      command: z.string().optional(),
      outcome: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
  candidates: z
    .array(
      z.object({
        location: z.string().optional(),
        why: z.string().optional(),
        hypothesis: z.string().optional(),
        check: z.string().optional(),
      }),
    )
    .optional(),
  confidence: z.string().optional(),
  status: z.string().optional(),
  warning: z.string().optional(),
});

export type BriefDraft = z.infer<typeof Draft>;

export const briefSymptom = createServerFn({ method: "POST" })
  .validator((input: unknown) => Input.parse(input))
  .handler(async ({ data }): Promise<{ ok: true; draft: BriefDraft } | { ok: false; error: string }> => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      return { ok: false, error: "AI briefing is unavailable in this environment." };
    }

    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-4.5",
        max_tokens: 900,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: `You are Ducktective, a verification skill. You do not own localization. You never invent passing or failing execution results. If you did not run the code, reproduction.outcome must be "unverified".

Return ONLY compact JSON with this shape:
{
  "symptom": string,
  "reproduction": { "command": string, "outcome": "unverified", "note": string },
  "candidates": [{ "location": string, "why": string, "hypothesis": string, "check": string }],
  "confidence": "none",
  "status": "unverified",
  "warning": string
}

Cap candidates at 3. Each check must be the smallest runnable assertion that would disprove the hypothesis. Do not suggest a patch. Do not claim a root cause.`,
          },
          { role: "user", content: data.symptom },
        ],
      }),
    });

    if (!res.ok) {
      return { ok: false, error: `Briefing failed (${res.status}).` };
    }

    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return { ok: false, error: "The model did not return a case file." };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(match[0]);
    } catch {
      return { ok: false, error: "The case file JSON was malformed." };
    }
    const parsed = Draft.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "The case file JSON was malformed." };
    }
    return { ok: true, draft: parsed.data };
  });
