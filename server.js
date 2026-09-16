import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

import { buildGockSystemInstruction } from "./gock-core.js";

const { Pool } = pg;

const app = express();

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.6-flash";

const DATABASE_URL = process.env.DATABASE_URL;

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
// PostgreSQL
// --------------------------------------------------

let db = null;

if (DATABASE_URL) {
  db = new Pool({
    connectionString: DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  db.on("error", (error) => {
    console.error(
      "PostgreSQL pool error:",
      error?.message || error
    );
  });
} else {
  console.warn(
    "DATABASE_URL is not configured. PostgreSQL memory is disabled."
  );
}

// --------------------------------------------------
// Initialize database
// --------------------------------------------------

async function initializeDatabase() {
  if (!db) {
    return false;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS gock_memories (
      id BIGSERIAL PRIMARY KEY,
      category TEXT NOT NULL DEFAULT 'general',
      memory TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_gock_memories_category
    ON gock_memories(category);
  `);

  return true;
}

// --------------------------------------------------
// Database health
// --------------------------------------------------

async function checkDatabase() {
  if (!db) {
    return false;
  }

  try {
    await db.query("SELECT 1");
    return true;
  } catch (error) {
    console.error(
      "Database health check failed:",
      error?.message || error
    );

    return false;
  }
}

// --------------------------------------------------
// Memory helpers
// --------------------------------------------------

async function getMemories(limit = 20) {
  if (!db) {
    return [];
  }

  const safeLimit = Math.min(
    Math.max(Number(limit) || 20, 1),
    100
  );

  const result = await db.query(
    `
      SELECT
        id,
        category,
        memory,
        importance,
        created_at,
        updated_at
      FROM gock_memories
      ORDER BY importance DESC, updated_at DESC
      LIMIT $1
    `,
    [safeLimit]
  );

  return result.rows;
}

async function saveMemory(
  memory,
  category = "general",
  importance = 3
) {
  if (!db) {
    return null;
  }

  const cleanMemory =
    typeof memory === "string"
      ? memory.trim()
      : "";

  if (!cleanMemory) {
    return null;
  }

  const cleanCategory =
    typeof category === "string" &&
    category.trim()
      ? category.trim().slice(0, 100)
      : "general";

  const safeImportance = Math.min(
    Math.max(Number(importance) || 3, 1),
    5
  );

  // Avoid storing the exact same memory repeatedly.
  const existing = await db.query(
    `
      SELECT id
      FROM gock_memories
      WHERE LOWER(memory) = LOWER($1)
      LIMIT 1
    `,
    [cleanMemory]
  );

  if (existing.rows.length > 0) {
    const updated = await db.query(
      `
        UPDATE gock_memories
        SET
          category = $2,
          importance = $3,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        existing.rows[0].id,
        cleanCategory,
        safeImportance,
      ]
    );

    return updated.rows[0];
  }

  const result = await db.query(
    `
      INSERT INTO gock_memories
        (category, memory, importance)
      VALUES
        ($1, $2, $3)
      RETURNING *
    `,
    [
      cleanCategory,
      cleanMemory,
      safeImportance,
    ]
  );

  return result.rows[0];
}

async function getRelevantMemories(message) {
  if (!db) {
    return [];
  }

  const text =
    typeof message === "string"
      ? message.trim()
      : "";

  if (!text) {
    return [];
  }

  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4)
    .slice(0, 12);

  if (words.length === 0) {
    return getMemories(10);
  }

  const conditions = words.map(
    (_, index) => `memory ILIKE $${index + 1}`
  );

  const values = words.map(
    (word) => `%${word}%`
  );

  try {
    const result = await db.query(
      `
        SELECT
          id,
          category,
          memory,
          importance,
          created_at,
          updated_at
        FROM gock_memories
        WHERE ${conditions.join(" OR ")}
        ORDER BY importance DESC, updated_at DESC
        LIMIT 10
      `,
      values
    );

    if (result.rows.length > 0) {
      return result.rows;
    }

    return getMemories(10);
  } catch (error) {
    console.error(
      "Memory retrieval error:",
      error?.message || error
    );

    return [];
  }
}

// --------------------------------------------------
// Health check
// --------------------------------------------------

app.get("/health", async (req, res) => {
  const database = await checkDatabase();

  res.json({
    ok: true,
    name: "Gock",
    status: "online",
    model: GEMINI_MODEL,
    core: "connected",
    database: database
      ? "connected"
      : "disconnected",
  });
});

// Also keep API-style health endpoint.
app.get("/api/health", async (req, res) => {
  const database = await checkDatabase();

  res.json({
    ok: true,
    name: "Gock",
    status: "online",
    model: GEMINI_MODEL,
    core: "connected",
    database: database
      ? "connected"
      : "disconnected",
  });
});

// --------------------------------------------------
// Serve Gock UI
// --------------------------------------------------

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "index.html")
  );
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
// GET memories
// --------------------------------------------------

app.get("/api/memories", async (req, res) => {
  try {
    const memories = await getMemories(
      req.query?.limit || 20
    );

    return res.json({
      ok: true,
      memories,
      count: memories.length,
    });
  } catch (error) {
    console.error(
      "Memory list error:",
      error?.message || error
    );

    return res.status(500).json({
      ok: false,
      error: "Could not load Gock memories.",
    });
  }
});

// --------------------------------------------------
// Save memory manually
// --------------------------------------------------

app.post("/api/memory", async (req, res) => {
  const memory = req.body?.memory;

  if (
    typeof memory !== "string" ||
    !memory.trim()
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "memory must be a non-empty string",
    });
  }

  try {
    const saved = await saveMemory(
      memory,
      req.body?.category || "general",
      req.body?.importance || 3
    );

    if (!saved) {
      return res.status(503).json({
        ok: false,
        error:
          "PostgreSQL memory is not configured.",
      });
    }

    return res.json({
      ok: true,
      memory: saved,
    });
  } catch (error) {
    console.error(
      "Memory save error:",
      error?.message || error
    );

    return res.status(500).json({
      ok: false,
      error: "Could not save memory.",
    });
  }
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
  // Load relevant persistent memories
  // ------------------------------------------------

  const memories =
    await getRelevantMemories(message);

  if (memories.length > 0) {
    mergedContext.persistentMemories =
      memories.map((item) => ({
        category: item.category,
        memory: item.memory,
        importance: item.importance,
      }));
  }

  // ------------------------------------------------
  // Build Gock Core system instruction
  // ------------------------------------------------

  const systemInstruction =
    buildGockSystemInstruction(
      mergedContext
    );

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

  // Current user message last.
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

  const controller =
    new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 45000);

  try {
    const response = await fetch(
      endpoint,
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key":
            GEMINI_API_KEY,
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
      }
    );

    const data = await response.json();

    if (!response.ok) {
      const apiMessage =
        data?.error?.message ||
        `Gemini returned HTTP ${response.status}.`;

      throw new Error(apiMessage);
    }

    const reply =
      data?.candidates?.[0]?.content?.parts
        ?.map(
          (part) => part?.text || ""
        )
        .join("")
        .trim();

    if (!reply) {
      throw new Error(
        "Gemini returned an empty response."
      );
    }

    return reply;
  } catch (error) {
    if (
      error?.name === "AbortError"
    ) {
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
// Detect explicit memory requests
// --------------------------------------------------

function extractMemoryRequest(message) {
  const text = message.trim();

  const patterns = [
    /^remember that\s+(.+)$/i,
    /^remember\s+(.+)$/i,
    /^save this\s*:\s*(.+)$/i,
    /^save this\s+(.+)$/i,
    /^keep this in memory\s*:\s*(.+)$/i,
    /^keep this in memory\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

// --------------------------------------------------
// Main Gock message endpoint
// --------------------------------------------------

app.post(
  "/api/message",
  async (req, res) => {
    const message = req.body?.message;

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

    const history =
      Array.isArray(req.body?.messages)
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

    // ------------------------------------------------
    // Explicit memory request
    // ------------------------------------------------

    const requestedMemory =
      extractMemoryRequest(
        message
      );

    if (requestedMemory) {
      try {
        const saved =
          await saveMemory(
            requestedMemory,
            "user",
            4
          );

        console.log(
          saved
            ? "Gock memory saved."
            : "Gock memory could not be saved."
        );
      } catch (error) {
        console.error(
          "Automatic memory save error:",
          error?.message || error
        );
      }
    }

    // ------------------------------------------------
    // Ask Gemini
    // ------------------------------------------------

    try {
      const reply =
        await askGemini(
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
        memory:
          requestedMemory
            ? "saved"
            : "unchanged",
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
  }
);

// --------------------------------------------------
// 404 handler
// --------------------------------------------------

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      ok: false,
      error:
        "API endpoint not found.",
    });
  }
);

// --------------------------------------------------
// Error handler
// --------------------------------------------------

app.use(
  (err, req, res, next) => {
    console.error(
      "Server error:",
      err
    );

    if (res.headersSent) {
      return next(err);
    }

    res.status(500).json({
      ok: false,
      error:
        "Internal server error.",
    });
  }
);

// --------------------------------------------------
// Start server
// --------------------------------------------------

async function startServer() {
  try {
    if (db) {
      await initializeDatabase();

      console.log(
        "PostgreSQL: connected"
      );

      console.log(
        "Gock memory table: ready"
      );
    } else {
      console.log(
        "PostgreSQL: not configured"
      );
    }
  } catch (error) {
    console.error(
      "PostgreSQL initialization failed:",
      error?.message || error
    );

    // Keep Gock online even if the database
    // temporarily cannot be reached.
  }

  app.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        "----------------------------------------"
      );

      console.log(
        "Gock server is running"
      );

      console.log(
        `Port: ${PORT}`
      );

      console.log(
        `Gemini model: ${GEMINI_MODEL}`
      );

      console.log(
        "Gock Core: connected"
      );

      console.log(
        `PostgreSQL: ${
          db
            ? "configured"
            : "not configured"
        }`
      );

      console.log(
        "UI: /"
      );

      console.log(
        "Health: /health"
      );

      console.log(
        "Message API: /api/message"
      );

      console.log(
        "Memory API: /api/memories"
      );

      console.log(
        "----------------------------------------"
      );
    }
  );
}

startServer();
