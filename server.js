import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

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
    service: "Gock Connector"
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

app.post("/api/message", (req, res) => {
  const message = req.body?.message;

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      ok: false,
      error: "message must be a non-empty string"
    });
  }

  const item = {
    role: "user",
    content: message.trim(),
    timestamp: new Date().toISOString()
  };

  messages.push(item);
  messages = messages.slice(-100);

  res.json({
    ok: true,
    message: item
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Gock Connector listening on port ${PORT}`);
});
