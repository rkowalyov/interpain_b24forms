import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";

function parseDotEnv(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();

    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    out[key] = val;
  }
  return out;
}

function getWebhookBase() {
  if (process.env.B24_WEBHOOK_URL?.trim()) {
    return process.env.B24_WEBHOOK_URL.trim();
  }

  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    const parsed = parseDotEnv(fs.readFileSync(envPath, "utf8"));
    if (parsed.B24_WEBHOOK_URL?.trim()) {
      return parsed.B24_WEBHOOK_URL.trim();
    }
  }

  return "";
}

const webhookBase = getWebhookBase();

if (!webhookBase) {
  console.error("B24_WEBHOOK_URL is required (env or .env.local)");
  process.exit(1);
}

const base = webhookBase.replace(/\/+$/, "");

function methodUrl(method) {
  return `${base}/${method}.json`;
}

async function b24Call(method, params = {}) {
  const body = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (const item of v) body.append(k, String(item));
    } else if (v !== undefined && v !== null) {
      body.append(k, String(v));
    }
  }

  const res = await fetch(methodUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok || json.error) {
    const msg = json.error_description || json.error || `HTTP ${res.status}`;
    throw new Error(`${method}: ${msg}`);
  }

  return json.result;
}

const server = new Server(
  { name: "b24-portal-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "b24_user_current",
      description: "Get current Bitrix24 user for this webhook.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    {
      name: "b24_deal_list_open_mine",
      description: "Get open deals assigned to current user.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", minimum: 1, maximum: 50, default: 20 }
        },
        additionalProperties: false
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    if (name === "b24_user_current") {
      const user = await b24Call("user.current");
      return {
        content: [{ type: "text", text: JSON.stringify(user, null, 2) }]
      };
    }

    if (name === "b24_deal_list_open_mine") {
      const user = await b24Call("user.current");
      const userId = user?.ID;
      const limit = Number(args.limit ?? 20);

      const deals = await b24Call("crm.deal.list", {
        "filter[ASSIGNED_BY_ID]": userId,
        "filter[CLOSED]": "N",
        "select[]": ["ID", "TITLE", "STAGE_ID", "OPPORTUNITY", "ASSIGNED_BY_ID"],
        start: 0
      });

      const sliced = Array.isArray(deals) ? deals.slice(0, limit) : [];
      return {
        content: [{ type: "text", text: JSON.stringify(sliced, null, 2) }]
      };
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: String(err?.message || err) }]
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);