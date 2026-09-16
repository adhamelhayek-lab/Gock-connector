import express from "express";
import cors from "cors";

const app = express();

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --------------------------------------------------
// Gemini configuration
// --------------------------------------------------

const GEMINI_MODEL = "gemini-3.6-flash";

// Faster thinking for normal chat.
// Gemini 3.6 Flash supports minimal, low, medium, high.
const THINKING_LEVEL = "minimal";

// Allow enough time for Render + Gemini,
// but don't let requests hang forever.
const GEMINI_TIMEOUT = 60000;

// Keep conversation small for faster requests.
const MAX_MESSAGES = 20;
const MAX_CONTEXT_MESSAGES = 6;

// --------------------------------------------------
// Middleware
// --------------------------------------------------

app.use(cors());

app.use(
  express.json({
    limit: "1mb"
  })
);

// --------------------------------------------------
// Gock default context
// --------------------------------------------------

const defaultContext = {
  identity: "I'm Gock, an AI assistant.",

  creator:
    "The user built the Gock application with ChatGPT.",

  separation:
    "Gock is a standalone project.",

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

// Server-side conversation memory.
// Render's filesystem is not persistent on the free instance,
// so this is intentionally lightweight.
let messages = [];

// --------------------------------------------------
// Home
// --------------------------------------------------

app.get("/", (_req, res) => {
  res.sendFile(
    new URL("./index.html", import.meta.url).pathname
  );
});

// --------------------------------------------------
// Health check
// --------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Gock Connector",
    aiConfigured: Boolean(GEMINI_API_KEY),
    model: GEMINI_MODEL,
    thinkingLevel: THINKING_LEVEL
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
    typeof req.body.context === "object" &&
    !Array.isArray(req.body.context)
  ) {
    context = {
      ...context,
      ...req.body.context,
      updatedAt: new Date().toISOString()
    };
  }

  if (Array.isArray(req.body?.messages)) {
    messages = req.body.messages
      .filter(
        item =>
          item &&
          (item.role === "user" ||
            item.role === "assistant") &&
          typeof item.content === "string"
      )
      .slice(-MAX_MESSAGES);
  }

  return res.json({
    ok: true,
    context,
    messages
  });
});

// --------------------------------------------------
// Build system prompt
// --------------------------------------------------

function buildSystemPrompt() {
  const personality = Array.isArray(context.personality)
    ? context.personality.join("\n")
    : "";

  const notes = Array.isArray(context.notes)
    ? context.notes.join("\n")
    : "";

  return `
You are Gock, an AI assistant.

Identity:
${context.identity}

Creator:
${context.creator}

Separation:
${context.separation}

Personality:
${personality}

Notes:
${notes}

Rules:
- You are Gock, not the real Grok.
- You are powered by Google Gemini.
- Never claim to literally be Grok.
- Keep Gock's identity consistent.
- Be sarcastic, playful, mischievous and blunt while remaining polite.
- Answer naturally and directly.
- Do not unnecessarily repeat the user's question.
- For simple questions, give concise answers.
`.trim();
}

// --------------------------------------------------
// Clean conversation
// --------------------------------------------------

function normalizeMessages(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  return list
    .filter(
      item =>
        item &&
        (item.role === "user" ||
          item.role === "assistant") &&
        typeof item.content === "string" &&
        item.content.trim()
    )
    .slice(-MAX_CONTEXT_MESSAGES)
    .map(item => ({
      role:
        item.role === "assistant"
          ? "model"
          : "user",

      parts: [
        {
          text: item.content.trim()
        }
      ]
    }));
}

// --------------------------------------------------
// Send message to Gock
// --------------------------------------------------

app.post("/api/message", async (req, res) => {
  const message =
    typeof req.body?.message === "string"
      ? req.body.message.trim()
      : "";

  // ------------------------------------------------
  // Validate message
  // ------------------------------------------------

  if (!message) {
    return res.status(400).json({
      ok: false,
      error: "message must be a non-empty string"
    });
  }

  // ------------------------------------------------
  // Check Gemini API key
  // ------------------------------------------------

  if (!GEMINI_API_KEY) {
    console.error(
      "GEMINI_API_KEY is not configured."
    );

    return res.status(500).json({
      ok: false,
      error: "GEMINI_API_KEY is not configured."
    });
  }

  // ------------------------------------------------
  // Use frontend conversation when supplied.
  //
  // This prevents the browser and server from
  // accidentally maintaining two different histories.
  // ------------------------------------------------

  if (Array.isArray(req.body?.messages)) {
    const incomingMessages =
      req.body.messages
        .filter(
          item =>
            item &&
            (item.role === "user" ||
              item.role === "assistant") &&
            typeof item.content === "string" &&
            item.content.trim()
        )
        .slice(-MAX_MESSAGES);

    if (incomingMessages.length > 0) {
      messages = incomingMessages;
    }
  }

  // ------------------------------------------------
  // Build compact conversation
  // ------------------------------------------------

  const conversation =
    normalizeMessages(messages);

  // Avoid duplicating the current user message.

  const lastMessage =
    conversation[conversation.length - 1];

  const alreadyContainsMessage =
    lastMessage?.role === "user" &&
    lastMessage?.parts?.[0]?.text === message;

  if (!alreadyContainsMessage) {
    conversation.push({
      role: "user",

      parts: [
        {
          text: message
        }
      ]
    });
  }

  // ------------------------------------------------
  // Gemini request
  // ------------------------------------------------

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, GEMINI_TIMEOUT);

  const startedAt = Date.now();

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",

        headers: {
          "x-goog-api-key": GEMINI_API_KEY,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },

        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: buildSystemPrompt()
              }
            ]
          },

          contents: conversation,

          generationConfig: {
            /*
              This is the main speed optimization.

              Gemini 3.6 Flash normally uses medium thinking.
              Minimal greatly reduces reasoning latency for
              ordinary chat.
            */
            thinkingConfig: {
              thinkingLevel: THINKING_LEVEL
            },

            /*
              Keep responses reasonably short.
              Increase this later if you want longer answers.
            */
            maxOutputTokens: 512
          }
        }),

        signal: controller.signal
      }
    );

    clearTimeout(timeout);

    const elapsed =
      Date.now() - startedAt;

    console.log(
      `Gemini response: ${response.status} in ${elapsed}ms`
    );

    // ------------------------------------------------
    // Read JSON safely
    // ------------------------------------------------

    let data;

    try {
      data = await response.json();
    } catch {
      return res.status(502).json({
        ok: false,
        error: "Gemini returned an invalid response."
      });
    }

    // ------------------------------------------------
    // Gemini API error
    // ------------------------------------------------

    if (!response.ok) {
      console.error(
        "Gemini API error:",
        data?.error || data
      );

      return res.status(response.status).json({
        ok: false,

        error:
          data?.error?.message ||
          "Gemini request failed."
      });
    }

    // ------------------------------------------------
    // Extract Gemini response
    // ------------------------------------------------

    const parts =
      data?.candidates?.[0]?.content?.parts;

    const reply = Array.isArray(parts)
      ? parts
          .map(part =>
            typeof part?.text === "string"
              ? part.text
              : ""
          )
          .join("")
          .trim()
      : "";

    if (!reply) {
      console.error(
        "Gemini returned no text:",
        JSON.stringify(data)
      );

      return res.status(502).json({
        ok: false,
        error: "Gock received an empty response from Gemini."
      });
    }

    // ------------------------------------------------
    // Save conversation
    // ------------------------------------------------

    const timestamp =
      new Date().toISOString();

    const userItem = {
      role: "user",
      content: message,
      timestamp
    };

    const assistantItem = {
      role: "assistant",
      content: reply,
      timestamp
    };

    /*
      Only append if this exact user message wasn't
      already supplied by the frontend.
    */

    const lastStored =
      messages[messages.length - 1];

    const duplicateUser =
      lastStored?.role === "user" &&
      lastStored?.content === message;

    if (!duplicateUser) {
      messages.push(userItem);
    }

    messages.push(assistantItem);

    messages = messages.slice(-MAX_MESSAGES);

    // ------------------------------------------------
    // Return response
    // ------------------------------------------------

    return res.json({
      ok: true,

      message: assistantItem,

      /*
        Also provide reply directly so the frontend
        can use either data.message.content or data.reply.
      */
      reply,

      model: GEMINI_MODEL,

      latencyMs: elapsed
    });

  } catch (error) {
    clearTimeout(timeout);

    console.error(
      "Gock Gemini error:",
      error
    );

    // ------------------------------------------------
    // Timeout
    // ------------------------------------------------

    if (error?.name === "AbortError") {
      return res.status(504).json({
        ok: false,
        error:
          "Gock timed out while waiting for Gemini."
      });
    }

    // ------------------------------------------------
    // Connection error
    // ------------------------------------------------

    return res.status(502).json({
      ok: false,

      error:
        "Could not reach Gemini.",

      detail:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }
});

// --------------------------------------------------
// 404 handler
// --------------------------------------------------

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "Route not found."
  });
});

// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Gock Connector listening on port ${PORT}`
  );

  console.log(
    `Gemini model: ${GEMINI_MODEL}`
  );

  console.log(
    `Gemini thinking level: ${THINKING_LEVEL}`
  );
});
