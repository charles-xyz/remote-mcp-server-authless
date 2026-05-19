import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

// Shared zod schemas reused across tools
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

// Define our MCP agent with tools
export class MyMCP extends McpAgent<Env> {
	server = new McpServer({
		name: "PSA Redliner v2 (dev)",
		version: "0.1.0",
	});

	async init() {
		// =====================================================================
		// DIAGNOSTIC: ping_anthropic
		// Confirms ANTHROPIC_API_KEY is set and the worker can reach the API.
		// =====================================================================
		this.server.registerTool(
			"ping_anthropic",
			{
				description:
					"Diagnostic: confirms ANTHROPIC_API_KEY is set and the worker can call api.anthropic.com.",
				inputSchema: {},
			},
			async () => {
				const apiKey = this.env.ANTHROPIC_API_KEY;
				if (!apiKey) {
					return {
						content: [{ type: "text", text: "ERROR: ANTHROPIC_API_KEY is not set." }],
					};
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
							model: "claude-sonnet-4-5",
							max_tokens: 20,
							messages: [
								{
									role: "user",
									content: "Reply with exactly the word 'pong' and nothing else.",
								},
							],
						}),
					});
					if (!res.ok) {
						const errBody = await res.text();
						return {
							content: [
								{
									type: "text",
									text: `Anthropic API returned ${res.status}: ${errBody.slice(0, 500)}`,
								},
							],
						};
					}
					const data = (await res.json()) as {
						content?: Array<{ type: string; text?: string }>;
					};
					const text =
						data.content?.find((b) => b.type === "text")?.text ?? "(no text block)";
					return {
						content: [
							{ type: "text", text: `Anthropic responded: "${text}". API key works.` },
						],
					};
				} catch (e) {
					return {
						content: [
							{
								type: "text",
								text: `Fetch threw: ${e instanceof Error ? e.message : String(e)}`,
							},
						],
					};
				}
			},
		);

		// =====================================================================
		// start_run
		// Called once at the start of a redline run. Returns a run_id used
		// purely for logging/correlation. No server state stored.
		// =====================================================================
		this.server.registerTool(
			"start_run",
			{
				description:
					"Begin a PSA redline run. Returns a run_id for logging. The skill should pass this run_id, side, attorney, asset_pack, and deal_summary to every process_section call.",
				inputSchema: {
					side: SideSchema,
					attorney: AttorneySchema,
					asset_pack: AssetPackSchema,
					deal_summary: z
						.string()
						.describe(
							"One-paragraph deal summary: property type, parties, business numbers detected, deal-specific signals.",
						),
				},
			},
			async ({ side, attorney, asset_pack, deal_summary }) => {
				const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				const result = {
					ok: true,
					run_id: runId,
					echo: { side, attorney, asset_pack, deal_summary },
					note: "Phase 1 stub. Server is stateless; pass run context to process_section.",
				};
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				};
			},
		);

		// =====================================================================
		// process_section
		// Called once per section during the walk. Phase 1: returns hardcoded
		// fake decision + edit so the skill flow can be validated end-to-end.
		// =====================================================================
		this.server.registerTool(
			"process_section",
			{
				description:
					"Process one section of the PSA. Returns a decision (FIGHT/LEAVE/FLAG), a list of tracked-change edits to apply, and any judgment_items for end-of-run review. Phase 1: returns hardcoded stub data.",
				inputSchema: {
					run_id: z.string(),
					section_id: z.string().describe("Section identifier, e.g. '§4.2'."),
					section_text: z.string().describe("Full text of the section being processed."),
					side: SideSchema,
					attorney: AttorneySchema,
					asset_pack: AssetPackSchema,
					deal_summary: z.string(),
				},
			},
			async ({ run_id, section_id, section_text, side, attorney, asset_pack }) => {
				// Phase 1 stub: pretend we called a subagent. Hardcoded response.
				const stub = {
					ok: true,
					run_id,
					section_id,
					decision: "FIGHT" as const,
					edits: [
						{
							anchor: section_text.slice(0, 40),
							before: "Buyer",
							after: "Purchaser",
							source: "rubric#stub-001",
							rationale: "Phase 1 stub edit — replace Buyer with Purchaser.",
						},
					],
					judgment_items: [] as Array<{ kind: string; note: string }>,
					_meta: {
						phase: "1-stub",
						side,
						attorney,
						asset_pack,
						section_chars: section_text.length,
					},
				};
				return {
					content: [{ type: "text", text: JSON.stringify(stub, null, 2) }],
				};
			},
		);

		// =====================================================================
		// finalize_run
		// Called at the end of the walk. Returns accumulated judgment items
		// for the end-of-run popup. Phase 1: returns empty list.
		// =====================================================================
		this.server.registerTool(
			"finalize_run",
			{
				description:
					"End the redline run. Returns accumulated judgment_items for the end-of-run lawyer popup. Phase 1: returns empty list since server is stateless.",
				inputSchema: {
					run_id: z.string(),
					judgment_items: z
						.array(
							z.object({
								section_id: z.string(),
								kind: z.string(),
								note: z.string(),
							}),
						)
						.optional()
						.describe(
							"Judgment items the skill collected across process_section calls. Server echoes them back grouped for the popup.",
						),
				},
			},
			async ({ run_id, judgment_items }) => {
				const items = judgment_items ?? [];
				const result = {
					ok: true,
					run_id,
					total_items: items.length,
					items_by_kind: items.reduce<Record<string, number>>((acc, item) => {
						acc[item.kind] = (acc[item.kind] ?? 0) + 1;
						return acc;
					}, {}),
					items,
					note: "Phase 1 stub. Server echoes items grouped by kind for the popup.",
				};
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
