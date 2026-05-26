import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { RUBRIC_SELLER, POLICY_SELLER, ATTORNEY_PREFS } from "./psa-data";

// ---------- shared schemas ----------
const SideSchema = z.enum(["seller", "buyer"]);
const AttorneySchema = z.enum(["rob-pivnick", "jordan-bailey", "will-tolliver"]);
const AssetPackSchema = z.enum([
	"raw-land",
	"retail",
	"multifamily",
	"industrial",
	"senior-living",
	"tar-form",
	"none",
]);

const SUBAGENT_MODEL = "claude-sonnet-4-5";
const SUBAGENT_MAX_TOKENS = 8000;

type AnthropicTextBlock = { type: string; text?: string };
type AnthropicResponse = {
	content?: AnthropicTextBlock[];
	stop_reason?: string;
	usage?: { output_tokens?: number };
};
type RawEdit = {
	span?: unknown;
	new_text?: unknown;
	rubric_id?: unknown;
	rationale?: unknown;
};
type ValidatedEdit = {
	span: string;
	new_text: string;
	op: "delete" | "insert" | "replace";
	rubric_id: unknown;
	rationale: string;
	_span_valid: boolean;
};
type ParsedSubagentResponse = {
	decision?: string;
	edits?: RawEdit[];
	judgment_items?: Array<Record<string, unknown>>;
};
type ProcessSectionResult = {
	ok: true;
	run_id: string;
	section_id: string;
	decision: string;
	edits: ValidatedEdit[];
	judgment_items: Array<Record<string, unknown>>;
	_meta: {
		model: string;
		edit_count: number;
		span_problems: number;
		stop_reason: string | null;
		output_tokens: number | null;
		section_chars: number;
		retries_used?: number;
	};
};
type AttemptOutcome =
	| { kind: "ok"; result: ProcessSectionResult }
	| {
			kind: "transient" | "truncated";
			error: string;
			detail?: string;
			raw?: string;
			output_tokens?: number | null;
	  };

// ---------- subagent prompt construction ----------
function buildSubagentSystemPrompt(attorney: string): string {
	const prefs = (ATTORNEY_PREFS as any)[attorney] ?? null;
	const prefLines: string[] = [];
	if (prefs?.seller_notes?.length) {
		for (const n of prefs.seller_notes) prefLines.push(`- ${n}`);
	}
	const teamWide: string[] = (ATTORNEY_PREFS as any).team_wide ?? [];

	return `You are a senior Texas commercial real estate attorney at the Pivnick Firm, producing a FIRST-PASS SELLER-SIDE redline of ONE section of a Purchase and Sale Agreement (PSA). You are reviewing opposing (buyer) counsel's draft.

POSTURE: surgical. Seller-side is about defending AS-IS, narrowing reps survival, capping liability, preserving Seller's discretion. Leave buyer-friendly language that is already acceptable. Do NOT over-redline. If a section needs no seller-protective edit, say so — LEAVE is a valid, common, correct answer.

YOU ARE WORKING ON ONE SECTION ONLY. You do not see the rest of the document. Reason only about the section text provided. If a rubric position depends on facts elsewhere in the document that you cannot see, surface it as a judgment_item rather than guessing.

== THE RUBRIC (authoritative first-pass positions) ==
Each position: id, topic, rule, applies_when, deal_specific, skip.
- If applies_when matches the section AND skip=false: this is a candidate edit.
- deal_specific=true: do NOT auto-apply. Surface as a judgment_item (kind="deal-specific-position") unless the section text clearly establishes the triggering facts.
- skip=true: never edit this topic; it is leave-alone by team consensus.

${JSON.stringify(RUBRIC_SELLER.positions)}

== LEAVE-ALONE LIST (do not touch these even if tempting) ==
${JSON.stringify(RUBRIC_SELLER.leave_alone)}

== SELLER HARD BLOCKS (never emit an edit that matches these) ==
${JSON.stringify(POLICY_SELLER.seller_hard_blocks)}

== SHARED BLOCKS ==
${JSON.stringify(POLICY_SELLER.shared_blocks)}

== FIRST-PASS EXCLUSIONS (these belong to later rounds, never first pass) ==
${JSON.stringify(POLICY_SELLER.first_pass_exclusions)}

== AUTHORIZED SIGNATORY RULE ==
${JSON.stringify(POLICY_SELLER.authorized_signatory)}

== NAMED COUNSEL + NOTICE BLOCK ==
${POLICY_SELLER.named_counsel_gate}
${POLICY_SELLER.notice_block_seller}

== ATTORNEY PREFERENCES (${prefs?.name ?? attorney}) — these OVERRIDE the rubric where they conflict ==
${prefLines.length ? prefLines.join("\n") : "(none specific to this attorney)"}

== TEAM-WIDE RULES ==
${teamWide.map((t) => `- ${t}`).join("\n")}

== TEXAS LEGAL ANCHORS (internalize; do not over-cite) ==
- Fair-notice doctrine (Dresser/Reyes): conspicuous + express. ALL CAPS satisfies conspicuousness when paired with express trigger language.
- DTPA (Tex. Bus. & Com. Code §17.41): SELLER-SIDE — preserve the full DTPA waiver as drafted.
- Express-negligence rule: indemnity reaching a party's own negligence requires "WHETHER ARISING WHOLLY OR IN PART FROM" + conspicuous formatting.

== BUSINESS-TERM RULE (critical) ==
NEVER edit a business/economic term. Price, purchase-price escalators (e.g., CPI adjustments), dollar amounts, percentages, caps, baskets, deposit amounts, interest rates, dates, and deadlines are deal economics, not legal-form positions. When you encounter one a seller might want to change, do NOT edit it — surface it as a judgment_item (kind="business-number-blank" or "deal-specific-position"). Editing a business term is a REJECT.

== THE EDIT CONTRACT (read carefully — this is how every edit is expressed) ==
Every edit is a single uniform shape: { "span": ..., "new_text": ... }.
- "span" is text copied VERBATIM, character-for-character, from the section text below. It is the exact text in the document this edit acts on. Never paraphrase it, never fix its typos, never normalize its quotes.
- "new_text" is what that span becomes.

The three kinds of edit are just three settings of this one shape:
- REPLACE: span = the existing text to change; new_text = the changed text.
- DELETE:  span = the EXACT, COMPLETE text to strike; new_text = "" (empty string). For positions that say use "Intentionally Deleted" to preserve numbering, new_text = "Intentionally Deleted." (not empty).
- INSERT:  span = a SHORT, distinctive verbatim sentence that the new text should follow; new_text = that same span sentence + the inserted language appended.

SPAN-LENGTH DISCIPLINE (this prevents failures):
- For REPLACE and INSERT: make "span" the SHORTEST distinctive substring that uniquely locates the spot. Do NOT quote a whole long clause to anchor a small change. Five to fifteen distinctive words is usually enough.
- For DELETE: "span" MUST be the complete text being struck, exactly as it appears — because the span defines the deletion boundary. A delete span is allowed to be long; a replace/insert span should not be.

== YOUR TASK ==
Decide for THIS section: FIGHT (emit edits), LEAVE (no seller-protective edit warranted), or FLAG (a lawyer judgment call — deal-specific position, business/economic term, party-identity blank, or unusual language the rubric is silent on).

== OUTPUT FORMAT ==
Respond with ONLY a single JSON object, no markdown fences, no preamble, no prose before or after:
{
  "decision": "FIGHT" | "LEAVE" | "FLAG",
  "edits": [
    {
      "span": "<verbatim text from the section>",
      "new_text": "<what the span becomes; empty string for a pure deletion>",
      "rubric_id": <integer rubric position id, or null>,
      "rationale": "<ONE short sentence. Keep it brief.>"
    }
  ],
  "judgment_items": [
    { "kind": "<deal-specific-position|business-number-blank|party-identity-blank|silent-unusual-language|named-counsel-blank>", "note": "<one sentence for the lawyer>" }
  ]
}

RULES FOR OUTPUT:
- For LEAVE: edits = [] and usually judgment_items = []. This is correct and common.
- Keep rationales to one short sentence. Do not restate the section. Do not think out loud. Brevity protects the response from truncation.
- "span" MUST be copied character-for-character from the section text. This is the single most important rule — a span not found verbatim cannot be applied.
- Never invent business numbers, party names, dollar amounts, dates, or percentages. Those are judgment_items, never edits.
- Preserve ALL CAPS where the rubric calls for conspicuous text. Preserve defined-term casing.
- Most sections fire 0-2 positions. Prefer few, surgical edits over many large ones.`;
}

function buildSubagentUserPrompt(
	sectionId: string,
	sectionText: string,
	dealSummary: string,
	assetPack: string,
): string {
	return `DEAL SUMMARY: ${dealSummary}
ASSET TYPE: ${assetPack}

SECTION ${sectionId}:
"""
${sectionText}
"""

Produce your JSON decision for this section now. JSON only.`;
}

// ---------- response parsing ----------
function extractJson(text: string): ParsedSubagentResponse {
	let t = text.trim();
	if (t.startsWith("```")) {
		t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
	}
	const first = t.indexOf("{");
	const last = t.lastIndexOf("}");
	if (first === -1 || last === -1) throw new Error("no JSON object found in subagent output");
	return JSON.parse(t.slice(first, last + 1)) as ParsedSubagentResponse;
}

// ---------- edit validation ----------
function classifyAndValidate(edits: unknown, sectionText: string): ValidatedEdit[] {
	if (!Array.isArray(edits)) return [];
	return edits.map((e) => {
		const edit = e as RawEdit;
		const span = typeof edit.span === "string" ? edit.span : "";
		const newText = typeof edit.new_text === "string" ? edit.new_text : "";
		const spanFound = span.length > 0 && sectionText.includes(span);
		let op: ValidatedEdit["op"];
		if (newText === "") op = "delete";
		else if (span.length > 0 && newText.includes(span)) op = "insert";
		else op = "replace";
		return {
			span,
			new_text: newText,
			op,
			rubric_id: edit.rubric_id ?? null,
			rationale: typeof edit.rationale === "string" ? edit.rationale : "",
			_span_valid: spanFound,
		};
	});
}

export class MyMCP extends McpAgent<Env> {
	server = new McpServer({
		name: "PSA Redliner v2 (dev)",
		version: "0.4.0",
	});

	async init() {
		this.server.registerTool(
			"ping_anthropic",
			{
				description: "Diagnostic: confirms ANTHROPIC_API_KEY is set and the worker can call api.anthropic.com.",
				inputSchema: {},
			},
			async () => {
				const apiKey = this.env.ANTHROPIC_API_KEY;
				if (!apiKey) {
					return { content: [{ type: "text", text: "ERROR: ANTHROPIC_API_KEY is not set." }] };
				}
				try {
					const res = await fetch("https://api.anthropic.com/v1/messages", {
						method: "POST",
						headers: {
							"x-api-key": apiKey,
							"anthropic-version": "2023-06-01",
							"content-type": "application/json",
						},
						body: JSON.stringify({
							model: SUBAGENT_MODEL,
							max_tokens: 20,
							messages: [{ role: "user", content: "Reply with exactly the word 'pong'." }],
						}),
					});
					if (!res.ok) {
						const errBody = await res.text();
						return { content: [{ type: "text", text: `Anthropic API returned ${res.status}: ${errBody.slice(0, 500)}` }] };
					}
					const data = (await res.json()) as AnthropicResponse;
					const text = data.content?.find((b) => b.type === "text")?.text ?? "(no text block)";
					return { content: [{ type: "text", text: `Anthropic responded: "${text}". API key works.` }] };
				} catch (e) {
					return { content: [{ type: "text", text: `Fetch threw: ${e instanceof Error ? e.message : String(e)}` }] };
				}
			},
		);

		this.server.registerTool(
			"start_run",
			{
				description: "Begin a PSA redline run. Returns a run_id for logging. Server is stateless; pass run context to every process_section call.",
				inputSchema: {
					side: SideSchema,
					attorney: AttorneySchema,
					asset_pack: AssetPackSchema,
					deal_summary: z.string(),
				},
			},
			async ({ side, attorney, asset_pack, deal_summary }) => {
				if (side !== "seller") {
					return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "This server is seller-side only." }) }] };
				}
				const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				return {
					content: [{ type: "text", text: JSON.stringify({
						ok: true,
						run_id: runId,
						echo: { side, attorney, asset_pack, deal_summary },
						playbook: { positions: RUBRIC_SELLER.positions.length, leave_alone: RUBRIC_SELLER.leave_alone.length },
					}, null, 2) }],
				};
			},
		);

		this.server.registerTool(
			"process_section",
			{
				description: "Process one section of a seller-side Texas PSA. Returns a decision (FIGHT/LEAVE/FLAG) plus edits. Each edit is a uniform { span, new_text } pair: span is verbatim doc text, new_text is what it becomes (empty = delete, span-included = insert, otherwise replace). The 'op' field is classified for convenience. Apply only edits where _span_valid is true; for _span_valid=false or ok=false, record a judgment item and move on — NEVER author the edit yourself.",
				inputSchema: {
					run_id: z.string(),
					section_id: z.string(),
					section_text: z.string(),
					side: SideSchema,
					attorney: AttorneySchema,
					asset_pack: AssetPackSchema,
					deal_summary: z.string(),
				},
			},
			async ({ run_id, section_id, section_text, side, attorney, asset_pack, deal_summary }) => {
				const apiKey = this.env.ANTHROPIC_API_KEY;
				if (!apiKey) {
					return { content: [{ type: "text", text: JSON.stringify({ ok: false, run_id, section_id, error: "ANTHROPIC_API_KEY not set" }) }] };
				}
				if (side !== "seller") {
					return { content: [{ type: "text", text: JSON.stringify({ ok: false, run_id, section_id, error: "seller-side only" }) }] };
				}

				const system = buildSubagentSystemPrompt(attorney);
				const baseUser = buildSubagentUserPrompt(section_id, section_text, deal_summary, asset_pack);
				// Nudge appended only on a truncation retry — an identical re-call would
				// just truncate again, so we ask for fewer, more surgical edits.
				const SURGICAL_NUDGE =
					"\n\nIMPORTANT: Your previous attempt was too long and was cut off. Be far more surgical: emit only the most important 1-2 edits, use the SHORTEST possible spans, and keep rationales to a few words. JSON only.";

				// One attempt. Returns a tagged outcome so the loop can decide whether to retry.
				// - kind "ok":        a usable result (including a clean LEAVE/FLAG with no edits) — NEVER retried
				// - kind "transient": API error / unparseable — retry an identical call
				// - kind "truncated": hit max_tokens — retry WITH the surgical nudge
				const attempt = async (useNudge: boolean): Promise<AttemptOutcome> => {
					let res: Response;
					try {
						res = await fetch("https://api.anthropic.com/v1/messages", {
							method: "POST",
							headers: {
								"x-api-key": apiKey,
								"anthropic-version": "2023-06-01",
								"content-type": "application/json",
							},
							body: JSON.stringify({
								model: SUBAGENT_MODEL,
								max_tokens: SUBAGENT_MAX_TOKENS,
								system,
								messages: [{ role: "user", content: useNudge ? baseUser + SURGICAL_NUDGE : baseUser }],
							}),
						});
					} catch (e) {
						return { kind: "transient", error: `subagent threw: ${e instanceof Error ? e.message : String(e)}` };
					}

					if (!res.ok) {
						const errBody = await res.text();
						return { kind: "transient", error: `subagent API ${res.status}`, detail: errBody.slice(0, 400) };
					}

					const data = (await res.json()) as AnthropicResponse;

					if (data.stop_reason === "max_tokens") {
						return { kind: "truncated", error: "truncated", output_tokens: data.usage?.output_tokens ?? null };
					}

					const rawText = data.content?.filter((b) => b.type === "text").map((b) => b.text).join("\n") ?? "";

					let parsed: ParsedSubagentResponse;
					try {
						parsed = extractJson(rawText);
					} catch (e) {
						return { kind: "transient", error: "unparseable", raw: rawText.slice(0, 600) };
					}

					const edits = classifyAndValidate(parsed.edits ?? [], section_text);
					return {
						kind: "ok",
						result: {
							ok: true,
							run_id,
							section_id,
							decision: parsed.decision ?? "LEAVE",
							edits,
							judgment_items: Array.isArray(parsed.judgment_items)
								? parsed.judgment_items.map((j: Record<string, unknown>) => ({ section_id, ...j }))
								: [],
							_meta: {
								model: SUBAGENT_MODEL,
								edit_count: edits.length,
								span_problems: edits.filter((e) => !e._span_valid).length,
								stop_reason: data.stop_reason ?? null,
								output_tokens: data.usage?.output_tokens ?? null,
								section_chars: section_text.length,
							},
						},
					};
				};

				// Retry loop: up to 3 total attempts. A clean result returns immediately
				// (a LEAVE/FLAG with no edits is a clean result — not a failure — so it is
				// never retried). Only transient/truncated failures are retried; truncation
				// retries use the surgical nudge. After attempts are spent, return the last
				// failure as ok:false so the orchestrator flags it (and never authors an edit).
				const MAX_ATTEMPTS = 3;
				let last: AttemptOutcome | null = null;
				let retries_used = 0;
				for (let i = 0; i < MAX_ATTEMPTS; i++) {
					const useNudge = last?.kind === "truncated";
					const outcome = await attempt(useNudge);
					if (outcome.kind === "ok") {
						outcome.result._meta.retries_used = i;
						return { content: [{ type: "text", text: JSON.stringify(outcome.result, null, 2) }] };
					}
					last = outcome;
					retries_used = i + 1;
				}

				// Retries exhausted — genuine failure.
				return { content: [{ type: "text", text: JSON.stringify({
					ok: false,
					run_id,
					section_id,
					error: last?.error ?? "unknown",
					detail: last?.detail ?? last?.raw ?? "Subagent failed after retries; flag this section for manual review — do NOT author an edit.",
					retries_used,
				}) }] };
			},
		);

		this.server.registerTool(
			"finalize_run",
			{
				description: "End the redline run. Returns accumulated judgment_items grouped by kind for the end-of-run lawyer popup.",
				inputSchema: {
					run_id: z.string(),
					judgment_items: z
						.array(z.object({ section_id: z.string(), kind: z.string(), note: z.string() }))
						.optional(),
				},
			},
			async ({ run_id, judgment_items }) => {
				const items = judgment_items ?? [];
				const byKind = items.reduce<Record<string, number>>((acc, i) => {
					acc[i.kind] = (acc[i.kind] ?? 0) + 1;
					return acc;
				}, {});
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: true, run_id, total_items: items.length, items_by_kind: byKind, items }, null, 2) }],
				};
			},
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}
		return new Response("Not found", { status: 404 });
	},
};
