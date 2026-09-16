import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import { buildGockSystemInstruction } from "./gock-core.js";

const app = express();

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Keep the current working model for Gock.
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.6-flash";

// --------------------------------------------------
// File paths
// --------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------------------------
// Middleware
// --------------------------------------------------

app.use(cors());

app.use(
  express.json({
    limit: "1mb",
  })
);

// --------------------------------------------------
// Gock default context
// --------------------------------------------------

const defaultContext = {
  identity: "I'm Gock, an AI assistant.",
  personality:
    "Friendly, direct, intelligent, conversational, and helpful.",
  purpose:
    "Help the user with questions, coding, writing, reasoning, learning, and everyday tasks.",
};

// --------------------------------------------------
// Health check
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    name: "Gock",
    status: "online",
    model: GEMINI_MODEL,
    core: "connected",
  });
});

// Also keep the API-style health endpoint available.
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    name: "Gock",
    status: "online",
    model: GEMINI_MODEL,
    core: "connected",
  });
});

// --------------------------------------------------
// Serve Gock UI at ROOT
// --------------------------------------------------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// --------------------------------------------------
// Context endpoint
// --------------------------------------------------

app.post("/api/context", (req, res) => {
  let context = {
    ...defaultContext,
  };

  let messages = [];

  if (
    req.body?.context &&
    typeof req.body.context === "object" &&
    !Array.isArray(req.body.context)
  ) {
    context = {
      ...context,
      ...req.body.context,
      updatedAt: new Date().toISOString(),
    };
  }

  if (Array.isArray(req.body?.messages)) {
    messages = req.body.messages.slice(-20);
  }

  res.json({
    ok: true,
    context,
    messages,
  });
});

// --------------------------------------------------
// Gemini request helper
// --------------------------------------------------

async function askGemini(
  message,
  history = [],
  context = {}
) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is not configured on the server."
    );
  }

  const safeHistory = Array.isArray(history)
    ? history.slice(-12)
    : [];

  const mergedContext = {
    ...defaultContext,
    ...(context &&
    typeof context === "object" &&
    !Array.isArray(context)
      ? context
      : {}),
  };

  // ------------------------------------------------
  // Build Gock's Core system instruction
  // ------------------------------------------------

  const systemInstruction =
    buildGockSystemInstruction(mergedContext);

  // ------------------------------------------------
  // Build Gemini conversation
  // ------------------------------------------------

  const contents = [];

  for (const item of safeHistory) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const role =
      item.role === "assistant" ||
      item.role === "model"
        ? "model"
        : "user";

    const text =
      typeof item.content === "string"
        ? item.content
        : typeof item.text === "string"
          ? item.text
          : "";

    if (!text.trim()) {
      continue;
    }

    contents.push({
      role,
      parts: [
        {
          text: text.trim(),
        },
      ],
    });
  }

  // Always put current user message last.
  contents.push({
    role: "user",
    parts: [
      {
        text: message.trim(),
      },
    ],
  });

  // ------------------------------------------------
  // Gemini endpoint
  // ------------------------------------------------

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(GEMINI_MODEL)}:generateContent`;

  // ------------------------------------------------
  // Timeout
  // ------------------------------------------------

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 45000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",

        // Keep the API key server-side.
        // Do not expose this key in index.html.
        "x-goog-api-key": GEMINI_API_KEY,
      },

      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: systemInstruction,
            },
          ],
        },

        contents,

        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1024,
        },
      }),

      signal: controller.signal,
    });

    const data = await response.json();

    if (!response.ok) {
      const apiMessage =
        data?.error?.message ||
        `Gemini returned HTTP ${response.status}.`;

      throw new Error(apiMessage);
    }

    const reply =
      data?.candidates?.[0]?.content?.parts
        ?.map((part) => part?.text || "")
        .join("")
        .trim();

    if (!reply) {
      throw new Error(
        "Gemini returned an empty response."
      );
    }

    return reply;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        "Gock timed out while waiting for Gemini."
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// --------------------------------------------------
// Main Gock message endpoint
// --------------------------------------------------

app.post("/api/message", async (req, res) => {
  const message = req.body?.message;

  // Validate message.
  if (
    typeof message !== "string" ||
    !message.trim()
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "message must be a non-empty string",
    });
  }

  const history = Array.isArray(req.body?.messages)
    ? req.body.messages
    : [];

  const context =
    req.body?.context &&
    typeof req.body.context === "object" &&
    !Array.isArray(req.body.context)
      ? req.body.context
      : {};

  console.log(
    `Incoming Gock message: "${message.trim()}"`
  );

  const startedAt = Date.now();

  try {
    const reply = await askGemini(
      message,
      history,
      context
    );

    console.log(
      `Gock response completed in ${
        Date.now() - startedAt
      }ms`
    );

    return res.json({
      ok: true,
      reply,
      model: GEMINI_MODEL,
      core: "connected",
    });
  } catch (error) {
    console.error(
      "Gemini error:",
      error?.message || error
    );

    return res.status(502).json({
      ok: false,
      error:
        error?.message ||
        "Gock could not get a response from Gemini.",
    });
  }
});

// --------------------------------------------------
// 404 handler for API routes
// --------------------------------------------------

app.use("/api", (req, res) => {
  res.status(404).json({
    ok: false,
    error: "API endpoint not found.",
  });
});

// --------------------------------------------------
// Error handler
// --------------------------------------------------

app.use((err, req, res, next) => {
  console.error("Server error:", err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    ok: false,
    error: "Internal server error.",
  });
});

// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log("----------------------------------------");
  console.log("Gock server is running");
  console.log(`Port: ${PORT}`);
  console.log(`Gemini model: ${GEMINI_MODEL}`);
  console.log("Gock Core: connected");
  console.log("UI: /");
  console.log("Health: /health");
  console.log("Message API: /api/message");
  console.log("----------------------------------------");
});
