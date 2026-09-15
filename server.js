import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;
const XAI_API_KEY = process.env.XAI_API_KEY;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const defaultContext = {
  identity: "I’m Gock, an AI assistant.",
  creator: "The user built the Gock application with ChatGPT.",
  separation: "Gock is a standalone project.",
  personality: [
    "Be sarcastic, playful, mischievous and blunt, while remaining polite.",
    "Never pretend to be the real Grok.",
    "Gock and Grok can argue for comedic effect."
  ],
  notes: []
};

let context = {
  ...defaultContext,
  updatedAt: new Date().toISOString()
};

let messages = [];

app.get("/", (_req, res) => {
  res.sendFile(new URL("./index.html", import.meta.url).pathname);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Gock Connector",
    aiConfigured: Boolean(XAI_API_KEY)
  });
});

app.get("/api/context", (_req, res) => {
  res.json({
    ok: true,
    context,
    messages
  });
});

app.post("/api/context", (req, res) => {
  if (req.body?.context && typeof req.body.context === "object") {
    context = {
      ...context,
      ...req.body.context,
      updatedAt: new Date().toISOString()
    };
  }

  if (Array.isArray(req.body?.messages)) {
    messages = req.body.messages.slice(-100);
  }

  res.json({
    ok: true,
    context,
    messages
  });
});

app.post("/api/message", async (req, res) => {
  const message = req.body?.message;

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      ok: false,
      error: "message must be a non-empty string"
    });
  }

  if (!XAI_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "XAI_API_KEY is not configured."
    });
  }

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

Important:
- You are Gock, not the real Grok.
- Your underlying AI model is 1/Grok.
- Never claim to literally be the real Grok.
- Keep Gock's identity and personality.
- Be sarcastic, playful, mischievous and blunt while remaining polite.
`;

  const conversation = [
    {
      role: "system",
      content: systemPrompt.trim()
    },
    ...messages
      .filter(item => item.role === "user" || item.role === "assistant")
      .map(item => ({
        role: item.role,
        content: item.content
      })),
    {
      role: "user",
      content: message.trim()
    }
  ];

  try {
    const response = await fetch(" https://openrouter.ai/api/v1/chat/completions, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openrouter/free",
        messages: conversation
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: data?.error?.message || "1/Grok request failed."
      });
    }

    const reply = data.output_text || "";

    const userItem = {
      role: "user",
      content: message.trim(),
      timestamp: new Date().toISOString()
    };

    const assistantItem = {
      role: "assistant",
      content: reply,
      timestamp: new Date().toISOString()
    };

    messages.push(userItem, assistantItem);
    messages = messages.slice(-100);

    res.json({
      ok: true,
      message: assistantItem
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: "Could not reach 1/Grok.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Gock Connector listening on port ${PORT}`);
});
