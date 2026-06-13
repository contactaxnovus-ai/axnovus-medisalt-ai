const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");

const {
  getStats,
  loadMedicines,
  searchMedicine,
  extractCandidatesWithRules,
  buildAuditEvent,
} = require("./src/medicine-agent");

const PORT = Number(process.env.PORT || 8000);
const PUBLIC_DIR = __dirname;
const MAX_BODY_BYTES = 512 * 1024;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

async function start() {
  await loadMedicines(path.join(__dirname, "medicines.json"));

  const server = http.createServer(async (req, res) => {
    const requestId = req.headers["x-request-id"] || randomUUID();
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("X-Content-Type-Options", "nosniff");

    try {
      if (req.url === "/api/health" && req.method === "GET") {
        return sendJson(res, 200, {
          ok: true,
          requestId,
          llmEnabled: Boolean(process.env.OPENAI_API_KEY),
          stats: getStats(),
        });
      }

      if (req.url === "/api/medicines/stats" && req.method === "GET") {
        return sendJson(res, 200, getStats());
      }

      if (req.url === "/api/search" && req.method === "POST") {
        const body = await readJson(req);
        const query = String(body.query || "").trim();
        const limit = Math.min(Number(body.limit || 10), 25);
        if (!query) return sendJson(res, 400, { error: "query is required", requestId });
        const result = searchMedicine(query, { limit });
        console.info(JSON.stringify(buildAuditEvent("search", requestId, { query, resultCount: result.results.length })));
        return sendJson(res, 200, { requestId, ...result });
      }

      if (req.url === "/api/extract" && req.method === "POST") {
        const body = await readJson(req);
        const text = String(body.text || "").trim();
        if (!text) return sendJson(res, 400, { error: "text is required", requestId });
        const extraction = await extractMedicineCandidates(text);
        console.info(JSON.stringify(buildAuditEvent("extract", requestId, { count: extraction.candidates.length, mode: extraction.mode })));
        return sendJson(res, 200, { requestId, ...extraction });
      }

      if (req.method === "GET") {
        return serveStatic(req, res);
      }

      sendJson(res, 405, { error: "method not allowed", requestId });
    } catch (error) {
      console.error(JSON.stringify(buildAuditEvent("error", requestId, { message: error.message })));
      sendJson(res, error.statusCode || 500, { error: error.publicMessage || "internal server error", requestId });
    }
  });

  server.listen(PORT, () => {
    console.log(`Axnovus MediSalt AI running at http://localhost:${PORT}`);
  });
}

async function extractMedicineCandidates(text) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      mode: "rules",
      candidates: extractCandidatesWithRules(text),
      notes: ["LLM extraction disabled because OPENAI_API_KEY is not set."],
    };
  }

  try {
    return await extractCandidatesWithLlm(text);
  } catch (error) {
    return {
      mode: "rules_fallback",
      candidates: extractCandidatesWithRules(text),
      notes: [`LLM extraction failed; used deterministic fallback. ${error.message}`],
    };
  }
}

async function extractCandidatesWithLlm(text) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      instructions:
        "Extract likely medicine names from prescription OCR text. Return only JSON that follows the schema. Do not infer diagnosis. Keep uncertain names but mark confidence lower.",
      input: text.slice(0, 12000),
      text: {
        format: {
          type: "json_schema",
          name: "medicine_extraction",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              medicines: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string" },
                    confidence: { type: "number" },
                    rawText: { type: "string" },
                  },
                  required: ["name", "confidence", "rawText"],
                },
              },
            },
            required: ["medicines"],
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API returned ${response.status}`);
  }

  const payload = await response.json();
  const raw = payload.output_text || payload.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  const parsed = JSON.parse(raw || "{\"medicines\":[]}");
  return {
    mode: "llm",
    candidates: parsed.medicines.map((item) => ({
      name: item.name,
      confidence: clamp(Number(item.confidence), 0, 1),
      rawText: item.rawText,
      source: "llm",
    })),
    notes: ["LLM used only for extraction. Salt matching remains deterministic and auditable."],
  };
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("request body too large");
      error.statusCode = 413;
      error.publicMessage = "request body too large";
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("invalid json");
    error.statusCode = 400;
    error.publicMessage = "invalid json";
    throw error;
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: "forbidden" });
  }
  const ext = path.extname(resolved);
  const data = await fs.readFile(resolved);
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=60",
  });
  res.end(data);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
