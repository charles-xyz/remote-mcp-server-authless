import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

// Define our MCP agent with tools
export class MyMCP extends McpAgent<Env> {
	server = new McpServer({
		name: "PSA Redliner v2 (dev)",
		version: "0.0.1",
	});

	async init() {
		// Sanity-check tool: makes a real call to the Anthropic API
		// to confirm the worker, MCP protocol, and ANTHROPIC_API_KEY are all wired.
		this.server.registerTool(
			"ping_anthropic",
			{
				description:
					"Test tool: confirms ANTHROPIC_API_KEY is set and the worker can call api.anthropic.com. Returns 'pong' or an error message.",
				inputSchema: {},
			},
			async () => {
				const apiKey = this.env.ANTHROPIC_API_KEY;

				if (!apiKey) {
					return {
						content: [
							{
								type: "text",
								text: "ERROR: ANTHROPIC_API_KEY is not set in worker env.",
							},
						],
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
							{
								type: "text",
								text: `Anthropic responded: "${text}". API key works.`,
							},
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
