import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectFromFile, runGraph } from "@ironclad/rivet-node";

const app = express();
const port = Number(process.env.PORT) || 3000;
const apiBearerToken = process.env.API_BEARER_TOKEN;
const requireHttps = process.env.REQUIRE_HTTPS === "true";

if (!apiBearerToken) {
  throw new Error("Missing API_BEARER_TOKEN environment variable.");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workflowsDir = path.join(__dirname, "workflows");

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  if (!requireHttps) {
    return next();
  }

  const xForwardedProto = req.get("x-forwarded-proto") ?? "";
  const isForwardedHttps = xForwardedProto.split(",")[0]?.trim() === "https";

  if (req.secure || isForwardedHttps) {
    return next();
  }

  return res.status(400).json({ error: "HTTPS required" });
});

app.use((req, res, next) => {
  if (req.path === "/health") {
    return next();
  }

  const authHeader = req.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!match || match[1] !== apiBearerToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
});

function resolveWorkflowPath(name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return null;
  }

  return path.join(workflowsDir, `${name}.rivet-project`);
}

app.post(["/workflow/:name", "/workflows/:name"], async (req, res) => {
  const workflowPath = resolveWorkflowPath(req.params.name);

  if (!workflowPath) {
    return res.status(400).json({ error: "Invalid workflow name." });
  }

  try {
    const project = await loadProjectFromFile(workflowPath);
    const result = await runGraph(project, {
      inputs: {
        input: {
          type: "any",
          value: {
            payload: req.body ?? {}
          }
        }
      }
    });

    return res.status(200).json({ ...result.output.value });
  } catch (error) {
    const errorPayload = error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack
        }
      : {
          message: String(error)
        };

    return res.status(500).json({ error: errorPayload });
  }
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`Rivet runner listening on port ${port}`);
});
