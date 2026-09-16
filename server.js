import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Gemini model used by Gock
const GEMINI_MODEL = "gemini-3.6-flash";

app.use(cors());
app.use(express.json({ limit: "1mb" }));

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

let messages = [];

app.get("/", (_req, res) => {
res.sendFile(new URL("./index.html", import.meta.url).pathname);
});

app.get("/health", (_req, res) => {
res.json({
ok: true,
service: "Gock Connector",
aiConfigured: Boolean(GEMINI_API_KEY),
model: GEMINI_MODEL
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

if (!GEMINI_API_KEY) {
return res.status(500).json({
ok: false,
error: "GEMINI_API_KEY is not configured."
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

You are Gock, not the real Grok.

You are powered by Google Gemini.

Never claim to literally be the real Grok.

Keep Gock's identity and personality consistent.

Be sarcastic, playful, mischievous and blunt while remaining polite.
`;

const conversation = [
...messages
.filter(
item =>
item &&
(item.role === "user" || item.role === "assistant") &&
typeof item.content === "string"
)
.map(item => ({
role: item.role === "assistant" ? "model" : "user",
parts: [{ text: item.content }]
})),
{
role: "user",
parts: [{ text: message.trim() }]
}
];

try {
const response = await fetch(
https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent,
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
text: systemPrompt.trim()
}
]
},
contents: conversation
})
}
);

const data = await response.json();

if (!response.ok) {
return res.status(response.status).json({
ok: false,
error:
data?.error?.message ||
"Gemini request failed."
});
}

const reply =
data?.candidates?.[0]?.content?.parts
?.map(part => part.text || "")
.join("")
.trim() ||
"Gock received no response.";

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
error: "Could not reach Gemini.",
detail:
error instanceof Error
? error.message
: String(error)
});
}
});


app.listen(PORT, "0.0.0.0", () => {
console.log(Gock Connector listening on port ${PORT});
});
