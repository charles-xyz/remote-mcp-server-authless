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

// ---------- subagent prompt construction ----------
// The playbook is baked in fresh for every section. The subagent sees ONLY
// the playbook + one section. No accumulated history — that is the whole point.
function buildSubagentSystemPrompt(attorney: string): string {
	const prefs = (ATTORNEY_PREFS as any)[attorney] ?? null;
	const prefLines: string[] = [];
	if (prefs?.seller_notes?.length) {
		for (const n of prefs.seller_notes) prefLines.push(`- ${n}`);
	}
	const teamWide = (ATTORNEY_PREFS as any).team_wide ?? [];

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

== ANCHOR DISCIPLINE (critical — the edit must apply in Word) ==
${POLICY_SELLER.anchor_guidance}

== ATTORNEY PREFERENCES (${prefs?.name ?? attorney}) — these OVERRIDE the rubric where they conflict ==
${prefLines.length ? prefLines.join("\n") : "(none specific to this attorney)"}

== TEAM-WIDE RULES ==
${teamWide.map((t: string) => `- ${t}`).join("\n")}

== TEXAS LEGAL ANCHORS (internalize; do not over-cite) ==
- Fair-notice doctrine (Dresser/Reyes): conspicuous + express. ALL CAPS satisfies conspicuousness when paired with express trigger language.
- DTPA (Tex. Bus. & Com. Code §17.41): SELLER-SIDE — preserve the full DTPA waiver as drafted.
- Express-negligence rule: indemnity reaching a party's own negligence requires "WHETHER ARISING WHOLLY OR IN PART FROM" + conspicuous formatting.

== YOUR TASK ==
Decide for THIS section: FIGHT (apply rubric positions as tracked-change edits), LEAVE (no seller-protective edit warranted), or FLAG (a lawyer judgment call — deal-specific position, missing business number, party-identity blank, or unusual language the rubric is silent on).

== OUTPUT FORMAT ==
Respond with ONLY a single JSON object, no markdown fences, no preamble:
{
  "decision": "FIGHT" | "LEAVE" | "FLAG",
  "edits": [
    {
      "anchor": "<a short, verbatim, DISTINCTIVE substring copied exactly from the section text, used to locate the edit>",
      "before": "<verbatim text to be replaced, copied EXACTLY from the section text>",
      "after": "<the replacement text, in the firm's voice, preserving formatting/casing>",
      "rubric_id": <integer rubric position id this edit implements, or null>,
      "rationale": "<one sentence: what this does and why, seller-side>"
    }
  ],
  "judgment_items": [
    { "kind": "<deal-specific-position|business-number-blank|party-identity-blank|silent-unusual-language|named-counsel-blank>", "note": "<one sentence for the lawyer>" }
  ]
}

RULES FOR OUTPUT:
- For LEAVE: edits = [] and usually judgment_items = []. This is correct and common.
- For a pure insertion (no text replaced), set "before" to a verbatim anchor sentence that the new text should follow, and put the FULL anchor+insertion in "after" (anchor sentence + new language), so the edit is unambiguous in Word.
- "before" and "anchor" MUST be copied character-for-character from the section text. Do not paraphrase, do not fix typos in the anchor, do not normalize quotes.
- Never invent business numbers, party names, dollar amounts, dates, or percentages. Those are judgment_items.
- Preserve ALL CAPS where the rubric calls for conspicuous text. Preserve defined-term casing.
- Apply at most the rubric positions that genuinely fire for this section. Most sections fire 0-2 positions.`;
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

Produce your JSON decision for this section now.`;
}

// ---------- response parsing ----------
function extractJson(text: string): any {
	// Strip markdown fences if the model added them despite instructions.
	let t = text.trim();
	if (t.startsWith("```")) {
		t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
	}
	// Find the outermost JSON object.
	const first = t.indexOf("{");
	const last = t.lastIndexOf("}");
	if (first === -1 || last === -1) throw new Error("no JSON object found in subagent output");
	return JSON.parse(t.slice(first, last + 1));
}

// ---------- anchor validation ----------
// An edit is only useful if its anchor actually appears in the section text.
// We validate and tag each edit so the orchestrator knows what to trust.
function validateEdits(edits: any[], sectionText: string): any[] {
	if (!Array.isArray(edits)) return [];
	return edits.map((e) => {
		const before = typeof e.before === "string" ? e.before : "";
		const anchor = typeof e.anchor === "string" ? e.anchor : "";
		const beforeFound = before.length > 0 && sectionText.includes(before);
		const anchorFound = anchor.length > 0 && sectionText.includes(anchor);
		return {
			...e,
			_anchor_valid: beforeFound || anchorFound,
			_before_found: beforeFound,
			_anchor_found: anchorFound,
		};
	});
}

export class MyMCP extends McpAgent<Env> {
	server = new McpServer({
		name: "PSA Redliner v2 (dev)",
		version: "0.3.0",
	});

	async init() {
		// ---------- diagnostic ----------
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
					const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
					const text = data.content?.find((b) => b.type === "text")?.text ?? "(no text block)";
					return { content: [{ type: "text", text: `Anthropic responded: "${text}". API key works.` }] };
				} catch (e) {
					return { content: [{ type: "text", text: `Fetch threw: ${e instanceof Error ? e.message : String(e)}` }] };
				}
			},
		);

		// ---------- start_run ----------
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
					return {
						content: [{ type: "text", text: JSON.stringify({ ok: false, error: "This server is seller-side only in Phase 3a." }) }],
					};
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

		// ---------- process_section (the real one) ----------
		this.server.registerTool(
			"process_section",
			{
				description: "Process one section of a seller-side Texas PSA. Runs a focused subagent over the firm rubric/policy/prefs and returns a decision (FIGHT/LEAVE/FLAG), tracked-change edits, and judgment_items. Edits are validated against the section text; check _anchor_valid before applying.",
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
					return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "ANTHROPIC_API_KEY not set" }) }] };
				}
				if (side !== "seller") {
					return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "seller-side only" }) }] };
				}

				const system = buildSubagentSystemPrompt(attorney);
				const user = buildSubagentUserPrompt(section_id, section_text, deal_summary, asset_pack);

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
							max_tokens: 4000,
							system,
							messages: [{ role: "user", content: user }],
						}),
					});

					if (!res.ok) {
						const errBody = await res.text();
						return { content: [{ type: "text", text: JSON.stringify({ ok: false, run_id, section_id, error: `subagent API ${res.status}`, detail: errBody.slice(0, 400) }) }] };
					}

					const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
					const rawText = data.content?.filter((b) => b.type === "text").map((b) => b.text).join("\n") ?? "";

					let parsed: any;
					try {
						parsed = extractJson(rawText);
					} catch (e) {
						return { content: [{ type: "text", text: JSON.stringify({ ok: false, run_id, section_id, error: "subagent returned unparseable output", raw: rawText.slice(0, 600) }) }] };
					}

					const validatedEdits = validateEdits(parsed.edits ?? [], section_text);
					const anchorProblems = validatedEdits.filter((e) => !e._anchor_valid).length;

					const result = {
						ok: true,
						run_id,
						section_id,
						decision: parsed.decision ?? "LEAVE",
						edits: validatedEdits,
						judgment_items: Array.isArray(parsed.judgment_items)
							? parsed.judgment_items.map((j: any) => ({ section_id, ...j }))
							: [],
						_meta: {
							model: SUBAGENT_MODEL,
							edit_count: validatedEdits.length,
							anchor_problems: anchorProblems,
							section_chars: section_text.length,
						},
					};
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (e) {
					return { content: [{ type: "text", text: JSON.stringify({ ok: false, run_id, section_id, error: `subagent threw: ${e instanceof Error ? e.message : String(e)}` }) }] };
				}
			},
		);

		// ---------- finalize_run ----------
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
