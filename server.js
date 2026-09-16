import express from "express";
import cors from "cors";

const app = express();

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Gemini model used by Gock
const GEMINI_MODEL = "gemini-3.6-flash";

// --------------------------------------------------
// Middleware
// --------------------------------------------------

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// --------------------------------------------------
// Gock default context
// --------------------------------------------------

const defaultContext = {
  identity: "I'm Gock, an AI assistant.",
  creator: "The user built the Gock application with ChatGPT.",
  separation: "Gock is a standalone project.",
  personality: [
    "Be sarcastic, playful, mischievous and blunt while remaining polite.",
    "Never pretend to be the real Grok.",
    "Gock and Grok can argue for comedic effect."
  ],
  notes: []
};

let context = {
  ...defaultContext,
  updatedAt: new Date().toISOString()
};

// Keep history deliberately short for faster requests.
let messages = [];

// --------------------------------------------------
// Home
// --------------------------------------------------

app.get("/", (_req, res) => {
  res.sendFile(new URL("./index.html", import.meta.url).pathname);
});

// --------------------------------------------------
// Health check
// --------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Gock Connector",
    aiConfigured: Boolean(GEMINI_API_KEY),
    model: GEMINI_MODEL
  });
});

// --------------------------------------------------
// Get context + conversation
// --------------------------------------------------

app.get("/api/context", (_req, res) => {
  res.json({
    ok: true,
    context,
    messages
  });
});

// --------------------------------------------------
// Update context + conversation
// --------------------------------------------------

app.post("/api/context", (req, res) => {
  if (
    req.body?.context &&
    typeof req.body.context === "object"
  ) {
    context = {
      ...context,
      ...req.body.context,
      updatedAt: new Date().toISOString()
    };
  }

  if (Array.isArray(req.body?.messages)) {
    // Keep only the latest 20 messages.
    messages = req.body.messages.slice(-20);
  }

  res.json({
    ok: true,
    context,
    messages
  });
});

// --------------------------------------------------
// Send message to Gock
// --------------------------------------------------

app.post("/api/message", async (req, res) => {
  const message = req.body?.message;

  // Validate message
  if (
    typeof message !== "string" ||
    !message.trim()
  ) {
    return res.status(400).json({
      ok: false,
      error: "message must be a non-empty string"
    });
  }

  // Check API key
  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "GEMINI_API_KEY is not configured."
    });
  }

  // ------------------------------------------------
  // Compact system prompt
  // ------------------------------------------------

  const systemPrompt = `
You are Gock, an AI assistant.

Identity:
${context.identity}

Creator:
${context.creator}

Separation:
${context.separation}

Personality:
${context.personality.join("\n")}

Notes:
${context.notes.join("\n")}

Rules:
- You are Gock, not the real Grok.
- You are powered by Google Gemini.
- Never claim to literally be Grok.
- Keep Gock's identity consistent.
- Be sarcastic, playful, mischievous and blunt while remaining polite.
`.trim();

  // ------------------------------------------------
  // Build short conversation history
  // ------------------------------------------------

  const conversation = [
    ...messages
      .filter(
        item =>
          item &&
          (item.role === "user" ||
            item.role === "assistant") &&
          typeof item.content === "string"
      )
      .slice(-10)
      .map(item => ({
        role:
          item.role === "assistant"
            ? "model"
            : "user",
        parts: [
          {
            text: item.content
          }
        ]
      })),

    {
      role: "user",
      parts: [
        {
          text: message.trim()
        }
      ]
    }
  ];

  // ------------------------------------------------
  // Gemini request
  // ------------------------------------------------

  try {
    const controller = new AbortController();

    // Prevent requests from hanging forever.
    const timeout = setTimeout(
      () => controller.abort(),
      30000
    );

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",

        headers: {
          "x-goog-api-key": GEMINI_API_KEY,
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: systemPrompt
              }
            ]
          },

          contents: conversation,

          // Speed-oriented generation settings.
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 512
          }
        }),

        signal: controller.signal
      }
    );

    clearTimeout(timeout);

    const data = await response.json();

    // ------------------------------------------------
    // Gemini error
    // ------------------------------------------------

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error:
          data?.error?.message ||
          "Gemini request failed."
      });
    }

    // ------------------------------------------------
    // Extract response
    // ------------------------------------------------

    const reply =
      data?.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("")
        .trim() ||
      "Gock received no response.";

    // ------------------------------------------------
    // Save conversation
    // ------------------------------------------------

    const timestamp =
      new Date().toISOString();

    const userItem = {
      role: "user",
      content: message.trim(),
      timestamp
    };

    const assistantItem = {
      role: "assistant",
      content: reply,
      timestamp
    };

    messages.push(
      userItem,
      assistantItem
    );

    // Keep memory small.
    messages = messages.slice(-20);

    // ------------------------------------------------
    // Return response
    // ------------------------------------------------

    return res.json({
      ok: true,
      message: assistantItem
    });

  } catch (error) {
    // ------------------------------------------------
    // Timeout
    // ------------------------------------------------

    if (error?.name === "AbortError") {
      return res.status(504).json({
        ok: false,
        error: "Gock timed out while waiting for Gemini."
      });
    }

    // ------------------------------------------------
    // Connection error
    // ------------------------------------------------

    return res.status(502).json({
      ok: false,
      error: "Could not reach Gemini.",
      detail:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }
});

// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Gock Connector listening on port ${PORT}`
  );
});
