import express from "express";
import cors from "cors";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

import {
  buildGockSystemInstruction,
  detectGockMode,
} from "./gock-core-v2.js";

const { Pool } = pg;

// ============================================================
// GOCK SERVER V2
// Production-oriented backend for Gock Core V2
// ============================================================

const VERSION = "2.0.0";
const APP_NAME = "Gock";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = Object.freeze({
  port: Number(process.env.PORT) || 3000,

  nodeEnv:
    process.env.NODE_ENV || "production",

  geminiApiKey:
    process.env.GEMINI_API_KEY || "",

  geminiModel:
    process.env.GEMINI_MODEL ||
    "gemini-3.6-flash",

  geminiBaseUrl:
    process.env.GEMINI_BASE_URL ||
    "https://generativelanguage.googleapis.com",

  geminiApiVersion:
    process.env.GEMINI_API_VERSION ||
    "v1",

  geminiTimeoutMs:
    positiveInteger(
      process.env.GEMINI_TIMEOUT_MS,
      45000
    ),

  geminiMaxOutputTokens:
    positiveInteger(
      process.env.GEMINI_MAX_OUTPUT_TOKENS,
      4096
    ),

  geminiThinkingLevel:
    process.env.GEMINI_THINKING_LEVEL ||
    "low",

  databaseUrl:
    process.env.DATABASE_URL || "",

  maxMessageLength:
    positiveInteger(
      process.env.MAX_MESSAGE_LENGTH,
      12000
    ),

  maxContextLength:
    positiveInteger(
      process.env.MAX_CONTEXT_LENGTH,
      20000
    ),

  maxMemories:
    positiveInteger(
      process.env.MAX_MEMORIES,
      12
    ),

  sessionMaxAgeMs:
    positiveInteger(
      process.env.SESSION_MAX_AGE_MS,
      1000 * 60 * 60 * 24 * 30
    ),

  memoryMaxLength:
    positiveInteger(
      process.env.MEMORY_MAX_LENGTH,
      5000
    ),

  rateLimitWindowMs:
    positiveInteger(
      process.env.RATE_LIMIT_WINDOW_MS,
      60_000
    ),

  rateLimitMaxRequests:
    positiveInteger(
      process.env.RATE_LIMIT_MAX_REQUESTS,
      30
    ),
});

// ============================================================
// HELPERS
// ============================================================

function positiveInteger(value, fallback) {
  const number = Number(value);

  if (
    Number.isInteger(number) &&
    number > 0
  ) {
    return number;
  }

  return fallback;
}

function createRequestId() {
  return crypto.randomUUID();
}

function createSessionId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function safeString(
  value,
  maxLength = 1000
) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .trim()
    .slice(0, maxLength);
}

function clamp(
  value,
  minimum,
  maximum
) {
  return Math.min(
    Math.max(value, minimum),
    maximum
  );
}

// ============================================================
// EXPRESS
// ============================================================

const app = express();

app.disable("x-powered-by");

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(
  express.json({
    limit: "1mb",
  })
);

// ============================================================
// REQUEST ID
// ============================================================

app.use((req, res, next) => {
  const requestId =
    safeString(
      req.headers["x-request-id"],
      100
    ) || createRequestId();

  req.requestId = requestId;

  res.setHeader(
    "X-Request-ID",
    requestId
  );

  next();
});

// ============================================================
// SIMPLE PROCESS-LOCAL RATE LIMITER
// ============================================================
//
// This is intentionally lightweight.
// Render may run more than one instance, so this is not
// intended to replace a distributed rate limiter.
//

const rateBuckets = new Map();

function rateLimitKey(req) {
  return (
    req.ip ||
    req.headers["x-forwarded-for"] ||
    "unknown"
  );
}

function rateLimitMiddleware(
  req,
  res,
  next
) {
  const key = rateLimitKey(req);

  const now = Date.now();

  let bucket =
    rateBuckets.get(key);

  if (
    !bucket ||
    now - bucket.startedAt >
      CONFIG.rateLimitWindowMs
  ) {
    bucket = {
      startedAt: now,
      count: 0,
    };

    rateBuckets.set(
      key,
      bucket
    );
  }

  bucket.count += 1;

  if (
    bucket.count >
    CONFIG.rateLimitMaxRequests
  ) {
    res.setHeader(
      "Retry-After",
      Math.ceil(
        (
          CONFIG.rateLimitWindowMs -
          (now - bucket.startedAt)
        ) / 1000
      )
    );

    return res.status(429).json({
      ok: false,
      error:
        "Too many requests. Please wait a moment.",
      requestId:
        req.requestId,
    });
  }

  next();
}

app.use(
  "/api/message",
  rateLimitMiddleware
);

app.use(
  "/api/memory",
  rateLimitMiddleware
);

// Periodic cleanup.

setInterval(() => {
  const cutoff =
    Date.now() -
    CONFIG.rateLimitWindowMs * 2;

  for (const [
    key,
    bucket,
  ] of rateBuckets.entries()) {
    if (
      bucket.startedAt <
      cutoff
    ) {
      rateBuckets.delete(key);
    }
  }
}, CONFIG.rateLimitWindowMs).unref();

// ============================================================
// POSTGRESQL
// ============================================================

let db = null;

if (CONFIG.databaseUrl) {
  db = new Pool({
    connectionString:
      CONFIG.databaseUrl,

    max: 5,

    idleTimeoutMillis:
      30_000,

    connectionTimeoutMillis:
      5_000,

    ssl:
      CONFIG.nodeEnv ===
      "production"
        ? {
            rejectUnauthorized: false,
          }
        : undefined,
  });

  db.on("error", (error) => {
    console.error(
      `[Gock V2] PostgreSQL pool error:`,
      error?.message || error
    );
  });
} else {
  console.warn(
    "[Gock V2] DATABASE_URL is not configured."
  );
}

// ============================================================
// DATABASE INITIALIZATION
// ============================================================

async function initializeDatabase() {
  if (!db) {
    return false;
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS gock_memories (
      id BIGSERIAL PRIMARY KEY,

      category TEXT NOT NULL
        DEFAULT 'general',

      memory TEXT NOT NULL,

      importance INTEGER NOT NULL
        DEFAULT 3
        CHECK (
          importance >= 1
          AND importance <= 5
        ),

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
    idx_gock_memories_importance_updated
    ON gock_memories
    (importance DESC, updated_at DESC);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS gock_sessions (
      id TEXT PRIMARY KEY,

      previous_interaction_id TEXT,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
    idx_gock_sessions_updated
    ON gock_sessions(updated_at);
  `);

  return true;
}

// ============================================================
// DATABASE HEALTH
// ============================================================

async function databaseHealthy() {
  if (!db) {
    return false;
  }

  try {
    await db.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// SESSION DATABASE
// ============================================================

async function getSession(
  sessionId
) {
  if (!db) {
    return {
      id: sessionId,
      previousInteractionId: null,
    };
  }

  const result =
    await db.query(
      `
        SELECT
          id,
          previous_interaction_id,
          created_at,
          updated_at
        FROM gock_sessions
        WHERE id = $1
        LIMIT 1
      `,
      [sessionId]
    );

  if (
    result.rows.length === 0
  ) {
    await db.query(
      `
        INSERT INTO gock_sessions
          (id)
        VALUES
          ($1)
        ON CONFLICT (id)
        DO NOTHING
      `,
      [sessionId]
    );

    return {
      id: sessionId,
      previousInteractionId: null,
    };
  }

  return {
    id: result.rows[0].id,

    previousInteractionId:
      result.rows[0]
        .previous_interaction_id,
  };
}

async function setPreviousInteraction(
  sessionId,
  interactionId
) {
  if (!db) {
    return;
  }

  await db.query(
    `
      INSERT INTO gock_sessions
        (
          id,
          previous_interaction_id,
          updated_at
        )
      VALUES
        ($1, $2, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        previous_interaction_id =
          EXCLUDED.previous_interaction_id,
        updated_at = NOW()
    `,
    [
      sessionId,
      interactionId,
    ]
  );
}

async function clearSession(
  sessionId
) {
  if (!db) {
    return;
  }

  await db.query(
    `
      INSERT INTO gock_sessions
        (
          id,
          previous_interaction_id,
          updated_at
        )
      VALUES
        ($1, NULL, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        previous_interaction_id = NULL,
        updated_at = NOW()
    `,
    [sessionId]
  );
}

// ============================================================
// SESSION CLEANUP
// ============================================================

async function cleanupOldSessions() {
  if (!db) {
    return;
  }

  try {
    await db.query(
      `
        DELETE FROM gock_sessions
        WHERE updated_at <
          NOW() - INTERVAL '30 days'
      `
    );
  } catch (error) {
    console.error(
      "[Gock V2] Session cleanup failed:",
      error?.message || error
    );
  }
}

// ============================================================
// SESSION COOKIE
// ============================================================

function parseCookies(req) {
  const header =
    req.headers.cookie;

  if (!header) {
    return {};
  }

  const cookies = {};

  for (
    const piece of header.split(";")
  ) {
    const index =
      piece.indexOf("=");

    if (index === -1) {
      continue;
    }

    const name =
      piece
        .slice(0, index)
        .trim();

    const value =
      piece
        .slice(index + 1)
        .trim();

    if (name) {
      cookies[name] =
        decodeURIComponent(value);
    }
  }

  return cookies;
}

function getSessionId(req, res) {
  const cookies =
    parseCookies(req);

  let sessionId =
    cookies.gock_session;

  if (
    !sessionId ||
    !/^[0-9a-f-]{36}$/i.test(
      sessionId
    )
  ) {
    sessionId =
      createSessionId();

    const secure =
      CONFIG.nodeEnv ===
      "production"
        ? "; Secure"
        : "";

    res.setHeader(
      "Set-Cookie",
      `gock_session=${encodeURIComponent(
        sessionId
      )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`
    );
  }

  return sessionId;
}

// ============================================================
// SESSION REQUEST LOCK
// ============================================================
//
// Prevents two simultaneous messages from the same session
// from both using the same previous_interaction_id.
//

const sessionLocks =
  new Map();

async function withSessionLock(
  sessionId,
  operation
) {
  const previous =
    sessionLocks.get(
      sessionId
    ) || Promise.resolve();

  let release;

  const current =
    new Promise((resolve) => {
      release = resolve;
    });

  sessionLocks.set(
    sessionId,
    current
  );

  await previous;

  try {
    return await operation();
  } finally {
    release();

    if (
      sessionLocks.get(
        sessionId
      ) === current
    ) {
      sessionLocks.delete(
        sessionId
      );
    }
  }
}

// ============================================================
// MEMORY
// ============================================================

async function getMemories(
  limit = CONFIG.maxMemories
) {
  if (!db) {
    return [];
  }

  const safeLimit =
    clamp(
      Number(limit) || CONFIG.maxMemories,
      1,
      50
    );

  const result =
    await db.query(
      `
        SELECT
          id,
          category,
          memory,
          importance,
          created_at,
          updated_at
        FROM gock_memories
        ORDER BY
          importance DESC,
          updated_at DESC
        LIMIT $1
      `,
      [safeLimit]
    );

  return result.rows;
}

async function saveMemory({
  memory,
  category = "general",
  importance = 3,
}) {
  if (!db) {
    return null;
  }

  const cleanMemory =
    safeString(
      memory,
      CONFIG.memoryMaxLength
    );

  if (!cleanMemory) {
    return null;
  }

  const cleanCategory =
    safeString(
      category,
      100
    ) || "general";

  const safeImportance =
    clamp(
      Number(importance) || 3,
      1,
      5
    );

  const existing =
    await db.query(
      `
        SELECT id
        FROM gock_memories
        WHERE LOWER(memory) =
              LOWER($1)
        LIMIT 1
      `,
      [cleanMemory]
    );

  if (
    existing.rows.length
  ) {
    const result =
      await db.query(
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

    return result.rows[0];
  }

  const result =
    await db.query(
      `
        INSERT INTO gock_memories
          (
            category,
            memory,
            importance
          )
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

// ============================================================
// RELEVANT MEMORY SEARCH
// ============================================================

async function getRelevantMemories(
  message
) {
  if (!db) {
    return [];
  }

  const words =
    safeString(
      message,
      CONFIG.maxMessageLength
    )
      .toLowerCase()
      .replace(
        /[^\p{L}\p{N}\s]/gu,
        " "
      )
      .split(/\s+/)
      .filter(
        (word) =>
          word.length >= 4
      )
      .slice(0, 10);

  if (!words.length) {
    return getMemories();
  }

  const conditions =
    words.map(
      (_, index) =>
        `memory ILIKE $${index + 1}`
    );

  const values =
    words.map(
      (word) => `%${word}%`
    );

  try {
    const result =
      await db.query(
        `
          SELECT
            id,
            category,
            memory,
            importance,
            created_at,
            updated_at
          FROM gock_memories
          WHERE
            ${conditions.join(
              " OR "
            )}
          ORDER BY
            importance DESC,
            updated_at DESC
          LIMIT $${values.length + 1}
        `,
        [
          ...values,
          CONFIG.maxMemories,
        ]
      );

    return result.rows;
  } catch {
    return [];
  }
}

// ============================================================
// MEMORY CONTEXT
// ============================================================

async function buildMemoryContext(
  message
) {
  const memories =
    await getRelevantMemories(
      message
    );

  if (!memories.length) {
    return {};
  }

  return {
    persistentMemories:
      memories.map(
        (item) => ({
          category:
            item.category,

          memory:
            item.memory,

          importance:
            item.importance,
        })
      ),
  };
}

// ============================================================
// EXPLICIT MEMORY REQUEST
// ============================================================

function extractMemoryRequest(
  message
) {
  const text =
    safeString(
      message,
      CONFIG.maxMessageLength
    );

  const patterns = [
    /^remember that\s+(.+)$/i,
    /^remember this\s*:\s*(.+)$/i,
    /^remember\s+(.+)$/i,
    /^save this\s*:\s*(.+)$/i,
    /^keep this in memory\s*:\s*(.+)$/i,
  ];

  for (
    const pattern of patterns
  ) {
    const match =
      text.match(pattern);

    if (
      match &&
      match[1]
    ) {
      return safeString(
        match[1],
        CONFIG.memoryMaxLength
      );
    }
  }

  return null;
}

// ============================================================
// INPUT NORMALIZATION
// ============================================================

function normalizeMessage(
  message
) {
  const clean =
    safeString(
      message,
      CONFIG.maxMessageLength
    );

  return clean || null;
}

function normalizeContext(
  context
) {
  if (
    !context ||
    typeof context !==
      "object" ||
    Array.isArray(context)
  ) {
    return {};
  }

  try {
    const serialized =
      JSON.stringify(
        context
      );

    if (
      serialized.length >
      CONFIG.maxContextLength
    ) {
      return {};
    }

    return context;
  } catch {
    return {};
  }
}

// ============================================================
// GOCK CORE
// ============================================================

async function createSystemInstruction({
  message,
  context,
}) {
  const memoryContext =
    await buildMemoryContext(
      message
    );

  const mode =
    detectGockMode(
      message
    );

  return buildGockSystemInstruction({
    context: {
      ...context,

      ...memoryContext,

      activeMode:
        mode || "general",
    },
  });
}

// ============================================================
// GEMINI API
// ============================================================

function geminiUrl() {
  return (
    `${CONFIG.geminiBaseUrl}/` +
    `${CONFIG.geminiApiVersion}/` +
    `interactions`
  );
}

function geminiHeaders(
  accept = "application/json"
) {
  return {
    "Content-Type":
      "application/json",

    Accept: accept,

    "x-goog-api-key":
      CONFIG.geminiApiKey,
  };
}

function createAbortController() {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      CONFIG.geminiTimeoutMs
    );

  return {
    controller,
    clear() {
      clearTimeout(timeout);
    },
  };
}

// ============================================================
// GEMINI REQUEST BODY
// ============================================================

function createGeminiBody({
  message,
  previousInteractionId,
  systemInstruction,
  stream,
}) {
  const body = {
    model:
      CONFIG.geminiModel,

    input:
      message,

    system_instruction:
      systemInstruction,

    generation_config: {
      max_output_tokens:
        CONFIG.geminiMaxOutputTokens,

      thinking_level:
        CONFIG.geminiThinkingLevel,
    },

    stream,

    store: true,
  };

  if (
    previousInteractionId
  ) {
    body.previous_interaction_id =
      previousInteractionId;
  }

  return body;
}

// ============================================================
// GEMINI ERROR
// ============================================================

class GeminiError extends Error {
  constructor(
    message,
    status = 502,
    details = null
  ) {
    super(message);

    this.name =
      "GeminiError";

    this.status =
      status;

    this.details =
      details;
  }
}

// ============================================================
// GEMINI CALL
// ============================================================

async function requestGemini({
  message,
  previousInteractionId,
  systemInstruction,
  stream = false,
}) {
  if (
    !CONFIG.geminiApiKey
  ) {
    throw new GeminiError(
      "GEMINI_API_KEY is not configured.",
      500
    );
  }

  const body =
    createGeminiBody({
      message,
      previousInteractionId,
      systemInstruction,
      stream,
    });

  const {
    controller,
    clear,
  } =
    createAbortController();

  try {
    const response =
      await fetch(
        geminiUrl(),
        {
          method: "POST",

          headers:
            geminiHeaders(
              stream
                ? "text/event-stream"
                : "application/json"
            ),

          body:
            JSON.stringify(body),

          signal:
            controller.signal,
        }
      );

    if (!response.ok) {
      let details = null;

      try {
        details =
          await response.json();
      } catch {
        // No JSON body.
      }

      const providerMessage =
        details?.error?.message ||
        `Gemini returned HTTP ${response.status}.`;

      throw new GeminiError(
        providerMessage,
        response.status,
        details
      );
    }

    return response;
  } catch (error) {
    if (
      error instanceof
      GeminiError
    ) {
      throw error;
    }

    if (
      error?.name ===
      "AbortError"
    ) {
      throw new GeminiError(
        "Gemini request timed out.",
        504
      );
    }

    throw new GeminiError(
      error?.message ||
        "Could not reach Gemini.",
      502
    );
  } finally {
    clear();
  }
}

// ============================================================
// RETRY POLICY
// ============================================================
//
// Important:
// We do NOT automatically retry arbitrary interaction requests,
// because retrying a stateful chat turn can create duplicate
// interactions.
//
// Only connection/server failures are retried, and only when
// there is no response body being streamed.
//

function retryableStatus(
  status
) {
  return (
    status === 408 ||
    status === 425 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

async function requestGeminiWithSafeRetry(
  options
) {
  try {
    return await requestGemini(
      options
    );
  } catch (error) {
    if (
      !retryableStatus(
        error?.status
      )
    ) {
      throw error;
    }

    await sleep(700);

    return requestGemini(
      options
    );
  }
}

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}

// ============================================================
// INTERACTION RESPONSE PARSING
// ============================================================

function extractOutputText(
  interaction
) {
  if (
    typeof interaction?.output_text ===
      "string" &&
    interaction.output_text.trim()
  ) {
    return interaction.output_text.trim();
  }

  const steps =
    Array.isArray(
      interaction?.steps
    )
      ? interaction.steps
      : [];

  const pieces = [];

  for (
    const step of steps
  ) {
    if (
      step?.type !==
      "model_output"
    ) {
      continue;
    }

    const content =
      Array.isArray(
        step.content
      )
        ? step.content
        : [];

    for (
      const item of content
    ) {
      if (
        item?.type === "text" &&
        typeof item.text ===
          "string"
      ) {
        pieces.push(
          item.text
        );
      }
    }
  }

  return pieces
    .join("")
    .trim();
}

// ============================================================
// NON-STREAMING INTERACTION
// ============================================================

async function createInteraction({
  message,
  previousInteractionId,
  systemInstruction,
}) {
  const response =
    await requestGeminiWithSafeRetry({
      message,
      previousInteractionId,
      systemInstruction,
      stream: false,
    });

  const interaction =
    await response.json();

  const reply =
    extractOutputText(
      interaction
    );

  if (!reply) {
    throw new GeminiError(
      "Gemini returned an empty response.",
      502,
      interaction
    );
  }

  return {
    reply,

    interactionId:
      interaction?.id ||
      null,

    status:
      interaction?.status ||
      null,

    usage:
      interaction?.usage ||
      null,
  };
}

// ============================================================
// SSE PARSER
// ============================================================

async function* parseSSE(
  readable
) {
  const reader =
    readable.getReader();

  const decoder =
    new TextDecoder();

  let buffer = "";

  try {
    while (true) {
      const {
        value,
        done,
      } = await reader.read();

      if (done) {
        break;
      }

      buffer +=
        decoder.decode(
          value,
          {
            stream: true,
          }
        );

      const blocks =
        buffer.split(
          /\r?\n\r?\n/
        );

      buffer =
        blocks.pop() || "";

      for (
        const block of blocks
      ) {
        const event =
          parseSSEBlock(
            block
          );

        if (event) {
          yield event;
        }
      }
    }

    if (buffer.trim()) {
      const event =
        parseSSEBlock(
          buffer
        );

      if (event) {
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSSEBlock(
  block
) {
  let eventType =
    "message";

  const dataLines = [];

  for (
    const line of block.split(
      /\r?\n/
    )
  ) {
    if (
      line.startsWith(
        "event:"
      )
    ) {
      eventType =
        line
          .slice(6)
          .trim();
    } else if (
      line.startsWith(
        "data:"
      )
    ) {
      dataLines.push(
        line
          .slice(5)
          .trim()
      );
    }
  }

  if (
    !dataLines.length
  ) {
    return null;
  }

  const raw =
    dataLines.join("\n");

  if (
    raw === "[DONE]"
  ) {
    return {
      eventType,
      data: null,
    };
  }

  try {
    return {
      eventType,
      data:
        JSON.parse(raw),
    };
  } catch {
    return null;
  }
}

// ============================================================
// STREAMING INTERACTION
// ============================================================

async function streamInteraction({
  message,
  previousInteractionId,
  systemInstruction,
  onEvent,
}) {
  const response =
    await requestGemini({
      message,
      previousInteractionId,
      systemInstruction,
      stream: true,
    });

  if (!response.body) {
    throw new GeminiError(
      "Gemini did not return a streaming body.",
      502
    );
  }

  let interactionId =
    null;

  let reply = "";

  let completed = false;

  for await (
    const event of parseSSE(
      response.body
    )
  ) {
    const data =
      event.data;

    if (!data) {
      continue;
    }

    // --------------------------------------------------------
    // Interaction created
    // --------------------------------------------------------

    if (
      event.eventType ===
      "interaction.created"
    ) {
      interactionId =
        data?.interaction?.id ||
        interactionId;

      await onEvent({
        type: "interaction",
        interactionId,
        model:
          CONFIG.geminiModel,
      });

      continue;
    }

    // --------------------------------------------------------
    // Status
    // --------------------------------------------------------

    if (
      event.eventType ===
      "interaction.status_update"
    ) {
      await onEvent({
        type: "status",
        status:
          data?.status ||
          null,
      });

      continue;
    }

    // --------------------------------------------------------
    // Text delta
    // --------------------------------------------------------

    if (
      event.eventType ===
      "step.delta"
    ) {
      const delta =
        data?.delta;

      if (
        delta?.type === "text" &&
        typeof delta.text ===
          "string"
      ) {
        reply +=
          delta.text;

        await onEvent({
          type: "text",
          text:
            delta.text,
        });
      }

      continue;
    }

    // --------------------------------------------------------
    // Completed
    // --------------------------------------------------------

    if (
      event.eventType ===
      "interaction.completed"
    ) {
      interactionId =
        data?.interaction?.id ||
        interactionId;

      completed = true;

      await onEvent({
        type: "completed",
        interactionId,
        usage:
          data?.interaction
            ?.usage || null,
      });

      continue;
    }
  }

  if (!completed) {
    throw new GeminiError(
      "Gemini stream ended before completion.",
      502
    );
  }

  if (!reply.trim()) {
    throw new GeminiError(
      "Gemini returned an empty streamed response.",
      502
    );
  }

  return {
    reply:
      reply.trim(),

    interactionId,
  };
}

// ============================================================
// RESPONSE HELPERS
// ============================================================

function sendJson(
  res,
  status,
  payload
) {
  return res
    .status(status)
    .json({
      ...payload,
      requestId:
        payload.requestId ||
        res.getHeader(
          "X-Request-ID"
        ),
    });
}

function classifyError(
  error
) {
  if (
    error instanceof
    GeminiError
  ) {
    if (
      error.status === 429
    ) {
      return {
        status: 429,
        code:
          "GEMINI_RATE_LIMITED",
      };
    }

    if (
      error.status === 401 ||
      error.status === 403
    ) {
      return {
        status: 502,
        code:
          "GEMINI_AUTH_ERROR",
      };
    }

    if (
      error.status === 504
    ) {
      return {
        status: 504,
        code:
          "GEMINI_TIMEOUT",
      };
    }

    return {
      status:
        error.status >= 400 &&
        error.status < 600
          ? error.status
          : 502,
      code:
        "GEMINI_ERROR",
    };
  }

  return {
    status: 500,
    code:
      "INTERNAL_ERROR",
  };
}

// ============================================================
// HEALTH
// ============================================================

async function healthData() {
  const database =
    await databaseHealthy();

  return {
    ok: true,

    name:
      APP_NAME,

    status:
      "online",

    version:
      VERSION,

    model:
      CONFIG.geminiModel,

    core:
      "gock-core-v2",

    database:
      database
        ? "connected"
        : "disconnected",

    gemini:
      CONFIG.geminiApiKey
        ? "configured"
        : "missing",

    engine:
      "Gemini Interactions API",

    streaming:
      "available",

    state:
      "PostgreSQL + Gemini Interaction",

    environment:
      CONFIG.nodeEnv,

    timestamp:
      nowIso(),
  };
}

app.get(
  "/health",
  async (req, res) => {
    try {
      res.json(
        await healthData()
      );
    } catch {
      res.status(500).json({
        ok: false,
        status: "error",
        version: VERSION,
      });
    }
  }
);

app.get(
  "/api/health",
  async (req, res) => {
    try {
      res.json(
        await healthData()
      );
    } catch {
      res.status(500).json({
        ok: false,
        status: "error",
        version: VERSION,
      });
    }
  }
);

// ============================================================
// ROOT
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
    );
  }
);

// ============================================================
// CONTEXT
// ============================================================

app.post(
  "/api/context",
  (req, res) => {
    const context =
      normalizeContext(
        req.body?.context
      );

    sendJson(
      res,
      200,
      {
        ok: true,
        version: VERSION,
        context,
      }
    );
  }
);

// ============================================================
// MEMORY LIST
// ============================================================

app.get(
  "/api/memories",
  async (req, res) => {
    try {
      const memories =
        await getMemories(
          req.query?.limit
        );

      return sendJson(
        res,
        200,
        {
          ok: true,
          memories,
          count:
            memories.length,
        }
      );
    } catch (error) {
      console.error(
        `[Gock V2] [${req.requestId}] Memory list error:`,
        error?.message ||
          error
      );

      return sendJson(
        res,
        500,
        {
          ok: false,
          error:
            "Could not load memories.",
        }
      );
    }
  }
);

// ============================================================
// MANUAL MEMORY
// ============================================================

app.post(
  "/api/memory",
  async (req, res) => {
    const memory =
      safeString(
        req.body?.memory,
        CONFIG.memoryMaxLength
      );

    if (!memory) {
      return sendJson(
        res,
        400,
        {
          ok: false,
          error:
            "memory must be a non-empty string.",
        }
      );
    }

    try {
      const saved =
        await saveMemory({
          memory,

          category:
            safeString(
              req.body?.category,
              100
            ) || "general",

          importance:
            req.body?.importance ||
            3,
        });

      if (!saved) {
        return sendJson(
          res,
          503,
          {
            ok: false,
            error:
              "PostgreSQL memory is unavailable.",
          }
        );
      }

      return sendJson(
        res,
        200,
        {
          ok: true,
          memory: saved,
        }
      );
    } catch (error) {
      console.error(
        `[Gock V2] [${req.requestId}] Memory save error:`,
        error?.message ||
          error
      );

      return sendJson(
        res,
        500,
        {
          ok: false,
          error:
            "Could not save memory.",
        }
      );
    }
  }
);

// ============================================================
// RESET CONVERSATION
// ============================================================

app.post(
  "/api/conversation/reset",
  async (req, res) => {
    const sessionId =
      getSessionId(
        req,
        res
      );

    await withSessionLock(
      sessionId,
      async () => {
        await clearSession(
          sessionId
        );
      }
    );

    return sendJson(
      res,
      200,
      {
        ok: true,
        reset: true,
        version: VERSION,
      }
    );
  }
);

// ============================================================
// COMMON MESSAGE PREPARATION
// ============================================================

async function prepareMessage(
  req,
  res
) {
  const message =
    normalizeMessage(
      req.body?.message
    );

  if (!message) {
    sendJson(
      res,
      400,
      {
        ok: false,
        error:
          "message must be a non-empty string.",
      }
    );

    return null;
  }

  const context =
    normalizeContext(
      req.body?.context
    );

  const sessionId =
    getSessionId(
      req,
      res
    );

  const requestedMemory =
    extractMemoryRequest(
      message
    );

  if (requestedMemory) {
    try {
      await saveMemory({
        memory:
          requestedMemory,

        category:
          "user",

        importance:
          4,
      });
    } catch (error) {
      console.error(
        `[Gock V2] [${req.requestId}] Automatic memory save failed:`,
        error?.message ||
          error
      );
    }
  }

  return {
    message,
    context,
    sessionId,
    requestedMemory,
  };
}

// ============================================================
// NON-STREAM MESSAGE
// ============================================================

app.post(
  "/api/message",
  async (req, res) => {
    const prepared =
      await prepareMessage(
        req,
        res
      );

    if (!prepared) {
      return;
    }

    const {
      message,
      context,
      sessionId,
      requestedMemory,
    } = prepared;

    try {
      const result =
        await withSessionLock(
          sessionId,
          async () => {
            let session =
              await getSession(
                sessionId
              );

            let systemInstruction =
              await createSystemInstruction({
                message,
                context,
              });

            try {
              return await createInteraction({
                message,

                previousInteractionId:
                  session.previousInteractionId,

                systemInstruction,
              });
            } catch (error) {
              // ------------------------------------------------
              // If Gemini says the previous interaction is no
              // longer usable, start a fresh conversation once.
              // This handles free-tier interaction retention.
              // ------------------------------------------------

              const messageText =
                String(
                  error?.message ||
                    ""
                ).toLowerCase();

              const looksLikeStateError =
                !!session.previousInteractionId &&
                (
                  messageText.includes(
                    "previous_interaction"
                  ) ||
                  messageText.includes(
                    "interaction not found"
                  ) ||
                  messageText.includes(
                    "not found"
                  ) ||
                  error?.status === 404
                );

              if (
                !looksLikeStateError
              ) {
                throw error;
              }

              await clearSession(
                sessionId
              );

              session =
                await getSession(
                  sessionId
                );

              systemInstruction =
                await createSystemInstruction({
                  message,
                  context,
                });

              return createInteraction({
                message,

                previousInteractionId:
                  null,

                systemInstruction,
              });
            }
          }
        );

      if (
        result.interactionId
      ) {
        await setPreviousInteraction(
          sessionId,
          result.interactionId
        );
      }

      console.log(
        `[Gock V2] [${req.requestId}] completed`
      );

      return sendJson(
        res,
        200,
        {
          ok: true,

          reply:
            result.reply,

          model:
            CONFIG.geminiModel,

          engine:
            "Gemini Interactions API",

          version:
            VERSION,

          interactionId:
            result.interactionId,

          mode:
            detectGockMode(
              message
            ) || "general",

          memory:
            requestedMemory
              ? "saved"
              : "unchanged",
        }
      );
    } catch (error) {
      const classification =
        classifyError(
          error
        );

      console.error(
        `[Gock V2] [${req.requestId}] Gemini error:`,
        error?.message ||
          error
      );

      return sendJson(
        res,
        classification.status,
        {
          ok: false,

          code:
            classification.code,

          error:
            error?.message ||
            "Gock could not complete the request.",
        }
      );
    }
  }
);

// ============================================================
// STREAMING MESSAGE
// ============================================================

app.post(
  "/api/message/stream",
  async (req, res) => {
    const prepared =
      await prepareMessage(
        req,
        res
      );

    if (!prepared) {
      return;
    }

    const {
      message,
      context,
      sessionId,
      requestedMemory,
    } = prepared;

    // ----------------------------------------------------------
    // We acquire the session lock BEFORE starting SSE.
    //
    // This guarantees that another request from the same
    // conversation cannot use the same previous interaction ID
    // at the same time.
    // ----------------------------------------------------------

    const previousLock =
      sessionLocks.get(
        sessionId
      ) || Promise.resolve();

    let releaseLock;

    const currentLock =
      new Promise(
        (resolve) => {
          releaseLock =
            resolve;
        }
      );

    sessionLocks.set(
      sessionId,
      currentLock
    );

    await previousLock;

    try {
      let session =
        await getSession(
          sessionId
        );

      let systemInstruction =
        await createSystemInstruction({
          message,
          context,
        });

      // --------------------------------------------------------
      // Prepare SSE response.
      // --------------------------------------------------------

      res.status(200);

      res.setHeader(
        "Content-Type",
        "text/event-stream; charset=utf-8"
      );

      res.setHeader(
        "Cache-Control",
        "no-cache, no-transform"
      );

      res.setHeader(
        "Connection",
        "keep-alive"
      );

      res.setHeader(
        "X-Accel-Buffering",
        "no"
      );

      res.flushHeaders?.();

      let streamFinished =
        false;

      let lastInteractionId =
        null;

      const writeEvent =
        (type, payload) => {
          if (
            res.writableEnded
          ) {
            return;
          }

          res.write(
            `event: ${type}\n`
          );

          res.write(
            `data: ${JSON.stringify(
              payload
            )}\n\n`
          );
        };

      writeEvent(
        "start",
        {
          requestId:
            req.requestId,

          version:
            VERSION,

          model:
            CONFIG.geminiModel,
        }
      );

      try {
        const result =
          await streamInteraction({
            message,

            previousInteractionId:
              session.previousInteractionId,

            systemInstruction,

            onEvent:
              async (event) => {
                if (
                  event.type ===
                  "interaction"
                ) {
                  lastInteractionId =
                    event.interactionId;
                }

                if (
                  event.type ===
                  "completed"
                ) {
                  lastInteractionId =
                    event.interactionId;
                }

                writeEvent(
                  event.type,
                  event
                );
              },
          });

        lastInteractionId =
          result.interactionId ||
          lastInteractionId;

        if (
          lastInteractionId
        ) {
          await setPreviousInteraction(
            sessionId,
            lastInteractionId
          );
        }

        streamFinished =
          true;

        writeEvent(
          "done",
          {
            ok: true,

            version:
              VERSION,

            model:
              CONFIG.geminiModel,

            interactionId:
              lastInteractionId,

            mode:
              detectGockMode(
                message
              ) || "general",

            memory:
              requestedMemory
                ? "saved"
                : "unchanged",
          }
        );

        res.end();
      } catch (error) {
        // ------------------------------------------------------
        // If the previous interaction expired, retry exactly
        // once from a clean conversation.
        // ------------------------------------------------------

        const messageText =
          String(
            error?.message ||
              ""
          ).toLowerCase();

        const stateExpired =
          !!session.previousInteractionId &&
          (
            messageText.includes(
              "previous_interaction"
            ) ||
            messageText.includes(
              "interaction not found"
            ) ||
            messageText.includes(
              "not found"
            ) ||
            error?.status === 404
          );

        if (
          stateExpired &&
          !res.writableEnded
        ) {
          await clearSession(
            sessionId
          );

          session =
            await getSession(
              sessionId
            );

          systemInstruction =
            await createSystemInstruction({
              message,
              context,
            });

          writeEvent(
            "conversation_reset",
            {
              reason:
                "previous interaction expired",
            }
          );

          const retryResult =
            await streamInteraction({
              message,

              previousInteractionId:
                null,

              systemInstruction,

              onEvent:
                async (event) => {
                  if (
                    event.type ===
                    "interaction"
                  ) {
                    lastInteractionId =
                      event.interactionId;
                  }

                  if (
                    event.type ===
                    "completed"
                  ) {
                    lastInteractionId =
                      event.interactionId;
                  }

                  writeEvent(
                    event.type,
                    event
                  );
                },
            });

          lastInteractionId =
            retryResult.interactionId ||
            lastInteractionId;

          if (
            lastInteractionId
          ) {
            await setPreviousInteraction(
              sessionId,
              lastInteractionId
            );
          }

          streamFinished =
            true;

          writeEvent(
            "done",
            {
              ok: true,

              version:
                VERSION,

              model:
                CONFIG.geminiModel,

              interactionId:
                lastInteractionId,

              mode:
                detectGockMode(
                  message
                ) || "general",

              memory:
                requestedMemory
                  ? "saved"
                  : "unchanged",
            }
          );

          return res.end();
        }

        throw error;
      }
    } catch (error) {
      const classification =
        classifyError(
          error
        );

      console.error(
        `[Gock V2] [${req.requestId}] Stream error:`,
        error?.message ||
          error
      );

      if (
        res.headersSent
      ) {
        if (
          !res.writableEnded
        ) {
          res.write(
            `event: error\n`
          );

          res.write(
            `data: ${JSON.stringify({
              ok: false,

              code:
                classification.code,

              error:
                error?.message ||
                "Gock streaming failed.",

              requestId:
                req.requestId,
            })}\n\n`
          );

          res.end();
        }

        return;
      }

      return sendJson(
        res,
        classification.status,
        {
          ok: false,

          code:
            classification.code,

          error:
            error?.message ||
            "Gock streaming failed.",
        }
      );
    } finally {
      releaseLock();

      if (
        sessionLocks.get(
          sessionId
        ) === currentLock
      ) {
        sessionLocks.delete(
          sessionId
        );
      }
    }
  }
);

// ============================================================
// API 404
// ============================================================

app.use(
  "/api",
  (req, res) => {
    sendJson(
      res,
      404,
      {
        ok: false,
        error:
          "API endpoint not found.",
      }
    );
  }
);

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      `[Gock V2] [${req.requestId}] Unhandled error:`,
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    return sendJson(
      res,
      500,
      {
        ok: false,
        error:
          "Internal server error.",
      }
    );
  }
);

// ============================================================
// SERVER STARTUP
// ============================================================

let server = null;

async function startServer() {
  console.log(
    "=============================================="
  );

  console.log(
    "GOCK SERVER V2"
  );

  console.log(
    "=============================================="
  );

  console.log(
    `Version: ${VERSION}`
  );

  console.log(
    `Environment: ${CONFIG.nodeEnv}`
  );

  console.log(
    `Model: ${CONFIG.geminiModel}`
  );

  console.log(
    `Gemini API: ${CONFIG.geminiApiVersion}/interactions`
  );

  console.log(
    `Core: gock-core-v2.js`
  );

  console.log(
    `Streaming: enabled`
  );

  console.log(
    `PostgreSQL: ${
      db
        ? "configured"
        : "not configured"
    }`
  );

  if (
    !CONFIG.geminiApiKey
  ) {
    console.warn(
      "[Gock V2] WARNING: GEMINI_API_KEY is missing."
    );
  }

  try {
    if (db) {
      await initializeDatabase();

      console.log(
        "[Gock V2] PostgreSQL initialized."
      );

      await cleanupOldSessions();
    }
  } catch (error) {
    console.error(
      "[Gock V2] PostgreSQL initialization failed:",
      error?.message ||
        error
    );
  }

  server =
    app.listen(
      CONFIG.port,
      "0.0.0.0",
      () => {
        console.log(
          "=============================================="
        );

        console.log(
          `Gock V2 listening on port ${CONFIG.port}`
        );

        console.log(
          "=============================================="
        );
      }
    );
}

// ============================================================
// PERIODIC DATABASE CLEANUP
// ============================================================

setInterval(
  () => {
    cleanupOldSessions().catch(
      (error) => {
        console.error(
          "[Gock V2] Scheduled cleanup failed:",
          error?.message ||
            error
        );
      }
    );
  },
  24 * 60 * 60 * 1000
).unref();

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(
  signal
) {
  console.log(
    `[Gock V2] ${signal} received. Shutting down...`
  );

  if (server) {
    await new Promise(
      (resolve) => {
        server.close(
          () => resolve()
        );
      }
    );
  }

  if (db) {
    await db.end();
  }

  console.log(
    "[Gock V2] Shutdown complete."
  );

  process.exit(0);
}

process.once(
  "SIGTERM",
  () =>
    shutdown("SIGTERM")
);

process.once(
  "SIGINT",
  () =>
    shutdown("SIGINT")
);

// ============================================================
// START
// ============================================================

startServer().catch(
  (error) => {
    console.error(
      "[Gock V2] Fatal startup error:",
      error
    );

    process.exit(1);
  }
);
