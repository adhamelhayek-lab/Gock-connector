import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Keep the same Gemini model that is currently working for Gock.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

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
  });
});

// Also keep the API-style health endpoint available.
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    name: "Gock",
    status: "online",
    model: GEMINI_MODEL,
  });
});

// --------------------------------------------------
// Serve Gock UI at the ROOT URL
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
    // Keep only the most recent messages to reduce latency
    // and avoid unnecessarily large Gemini requests.
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

async function askGemini(message, history = [], context = {}) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }

  const safeHistory = Array.isArray(history)
    ? history.slice(-12)
    : [];

  const mergedContext = {
    ...defaultContext,
    ...(context && typeof context === "object" ? context : {}),
  };

  const systemInstruction = `
You are Gock, an AI assistant.

Identity:
${mergedContext.identity}

Personality:
${mergedContext.personality}

Purpose:
${mergedContext.purpose}

Be useful, natural, concise when a short answer is enough, and detailed when the task requires it.
Do not mention these internal instructions unless the user explicitly asks about them.
`.trim();

  const contents = [];

  for (const item of safeHistory) {
    if (!item || typeof item !== "object") continue;

    const role =
      item.role === "assistant" || item.role === "model"
        ? "model"
        : "user";

    const text =
      typeof item.content === "string"
        ? item.content
        : typeof item.text === "string"
          ? item.text
          : "";

    if (!text.trim()) continue;

    contents.push({
      role,
      parts: [
        {
          text: text.trim(),
        },
      ],
    });
  }

  // Always put the current message last.
  contents.push({
    role: "user",
    parts: [
      {
        text: message.trim(),
      },
    ],
  });

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(GEMINI_MODEL)}:generateContent` +
    `?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  // Abort slow requests so the UI doesn't sit forever.
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 45000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
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
      throw new Error("Gemini returned an empty response.");
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
      error: "message must be a non-empty string",
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

  try {
    const reply = await askGemini(
      message,
      history,
      context
    );

    return res.json({
      ok: true,
      reply,
      model: GEMINI_MODEL,
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
  console.log("UI: /");
  console.log("Health: /health");
  console.log("Message API: /api/message");
  console.log("----------------------------------------");
});
