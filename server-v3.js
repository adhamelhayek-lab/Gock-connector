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
// GOCK SERVER V3.1
// ============================================================

const VERSION = "3.1.0";
const APP_NAME = "Gock";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// CONFIGURATION
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

const CONFIG = Object.freeze({
  port:
    positiveInteger(
      process.env.PORT,
      3000
    ),

  nodeEnv:
    process.env.NODE_ENV ||
    "production",

  geminiApiKey:
    process.env.GEMINI_API_KEY ||
    "",

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
    process.env.DATABASE_URL ||
    "",

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

  memoryMaxLength:
    positiveInteger(
      process.env.MEMORY_MAX_LENGTH,
      5000
    ),

  sessionMaxAgeMs:
    positiveInteger(
      process.env.SESSION_MAX_AGE_MS,
      1000 * 60 * 60 * 24 * 30
    ),

  rateLimitWindowMs:
    positiveInteger(
      process.env.RATE_LIMIT_WINDOW_MS,
      60_000
    ),

  rateLimitMaxRequests:
    positiveInteger(
      process.env.RATE_LIMIT_MAX_REQUESTS,
      20
    ),

  maxBodyBytes:
    positiveInteger(
      process.env.MAX_BODY_BYTES,
      1024 * 1024
    ),

  allowedOrigins:
    process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS
          .split(",")
          .map(value => value.trim())
          .filter(Boolean)
      : [],
});

// ============================================================
// HELPERS
// ============================================================

function createId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function safeString(
  value,
  maxLength = 1000
) {
  if (
    typeof value !==
    "string"
  ) {
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
    Math.max(
      value,
      minimum
    ),
    maximum
  );
}

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

// ============================================================
// EXPRESS
// ============================================================

const app = express();

app.disable(
  "x-powered-by"
);

app.set(
  "trust proxy",
  1
);

// ============================================================
// CORS
// ============================================================

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(
          null,
          true
        );
      }

      if (
        CONFIG.allowedOrigins
          .length === 0
      ) {
        return callback(
          null,
          true
        );
      }

      return callback(
        null,
        CONFIG.allowedOrigins.includes(
          origin
        )
      );
    },

    credentials: true,
  })
);

// ============================================================
// BODY PARSER
// ============================================================

app.use(
  express.json({
    limit: "1mb",
  })
);

// ============================================================
// SECURITY HEADERS
// ============================================================

app.use(
  (req, res, next) => {
    res.setHeader(
      "X-Content-Type-Options",
      "nosniff"
    );

    res.setHeader(
      "Referrer-Policy",
      "strict-origin-when-cross-origin"
    );

    res.setHeader(
      "X-Frame-Options",
      "SAMEORIGIN"
    );

    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()"
    );

    next();
  }
);

// ============================================================
// REQUEST ID
// ============================================================

app.use(
  (req, res, next) => {
    const supplied =
      safeString(
        req.headers[
          "x-request-id"
        ],
        100
      );

    const requestId =
      supplied ||
      createId();

    req.requestId =
      requestId;

    res.setHeader(
      "X-Request-ID",
      requestId
    );

    next();
  }
);

// ============================================================
// RATE LIMITER
// ============================================================

const rateBuckets =
  new Map();

function rateLimitKey(req) {
  return (
    req.ip ||
    req.headers[
      "x-forwarded-for"
    ] ||
    "unknown"
  );
}

function rateLimitMiddleware(
  req,
  res,
  next
) {
  const key =
    rateLimitKey(req);

  const now =
    Date.now();

  let bucket =
    rateBuckets.get(key);

  if (
    !bucket ||
    now -
      bucket.startedAt >
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
    const remaining =
      Math.max(
        0,
        CONFIG.rateLimitWindowMs -
          (now -
            bucket.startedAt)
      );

    res.setHeader(
      "Retry-After",
      Math.ceil(
        remaining / 1000
      )
    );

    return res
      .status(429)
      .json({
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

// Cleanup rate buckets.

setInterval(
  () => {
    const cutoff =
      Date.now() -
      CONFIG.rateLimitWindowMs *
        2;

    for (
      const [
        key,
        bucket,
      ] of rateBuckets
    ) {
      if (
        bucket.startedAt <
        cutoff
      ) {
        rateBuckets.delete(
          key
        );
      }
    }
  },
  CONFIG.rateLimitWindowMs
).unref();

// ============================================================
// POSTGRESQL
// ============================================================

let db = null;

if (
  CONFIG.databaseUrl
) {
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
            rejectUnauthorized:
              false,
          }
        : undefined,
  });

  db.on(
    "error",
    error => {
      console.error(
        "[Gock V3] PostgreSQL pool error:",
        error?.message ||
          error
      );
    }
  );
} else {
  console.warn(
    "[Gock V3] DATABASE_URL is not configured."
  );
}

// ============================================================
// DATABASE
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

async function databaseHealthy() {
  if (!db) {
    return false;
  }

  try {
    await db.query(
      "SELECT 1"
    );

    return true;
  } catch {
    return false;
  }
}

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
      "[Gock V3] Session cleanup failed:",
      error?.message ||
        error
    );
  }
}

// ============================================================
// SESSION COOKIES
// ============================================================

function parseCookies(req) {
  const header =
    req.headers.cookie;

  if (!header) {
    return {};
  }

  const cookies = {};

  for (
    const piece of
      header.split(";")
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
      try {
        cookies[name] =
          decodeURIComponent(
            value
          );
      } catch {
        cookies[name] =
          value;
      }
    }
  }

  return cookies;
}

function getSessionId(
  req,
  res
) {
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
      createId();

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
// SESSION DATABASE
// ============================================================

async function getSession(
  sessionId
) {
  if (!db) {
    return {
      id: sessionId,
      previousInteractionId:
        null,
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
    result.rows.length ===
    0
  ) {
    await db.query(
      `
        INSERT INTO
          gock_sessions (id)
        VALUES ($1)
        ON CONFLICT (id)
        DO NOTHING
      `,
      [sessionId]
    );

    return {
      id: sessionId,
      previousInteractionId:
        null,
    };
  }

  const row =
    result.rows[0];

  return {
    id: row.id,

    previousInteractionId:
      row.previous_interaction_id,

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at,
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
      INSERT INTO
        gock_sessions
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
      INSERT INTO
        gock_sessions
        (
          id,
          previous_interaction_id,
          updated_at
        )
      VALUES
        ($1, NULL, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        previous_interaction_id =
          NULL,
        updated_at = NOW()
    `,
    [sessionId]
  );
}

// ============================================================
// SESSION LOCKS
// ============================================================

const sessionLocks =
  new Map();

async function withSessionLock(
  sessionId,
  operation
) {
  const previous =
    sessionLocks.get(
      sessionId
    ) ||
    Promise.resolve();

  let release;

  const current =
    new Promise(
      resolve => {
        release = resolve;
      }
    );

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
      Number(limit) ||
        CONFIG.maxMemories,
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
    ) ||
    "general";

  const safeImportance =
    clamp(
      Number(importance) ||
        3,
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
        INSERT INTO
          gock_memories
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
        word =>
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
      word => `%${word}%`
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
// MEMORY REQUEST DETECTION
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
    const pattern of
      patterns
  ) {
    const match =
      text.match(pattern);

    if (
      match?.[1]
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
// CLIENT CONTEXT
// ============================================================

function sanitizeContext(
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
  const memories =
    await getRelevantMemories(
      message
    );

  const mode =
    detectGockMode(
      message
    ) ||
    "casual";

  return buildGockSystemInstruction({
    mode,

    memories,

    projectContext:
      "Current Gock project: Gock is being developed as a personal AI assistant with persistent memory, project continuity, engineering capabilities, research capabilities, and a future tool architecture.",

    extraContext:
      JSON.stringify(
        {
          activeMode: mode,

          currentContext:
            context,

          retrievedMemories:
            memories.map(
              item => ({
                category:
                  item.category,

                memory:
                  item.memory,

                importance:
                  item.importance,
              })
            ),

          serverVersion:
            VERSION,
        },
        null,
        2
      ),
  });
}

// ============================================================
// GEMINI
// ============================================================

function geminiUrl() {
  return (
    `${CONFIG.geminiBaseUrl}/` +
    `${CONFIG.geminiApiVersion}/` +
    `interactions`
  );
}

function geminiHeaders(
  accept =
    "application/json"
) {
  return {
    "Content-Type":
      "application/json",

    Accept: accept,

    "x-goog-api-key":
      CONFIG.geminiApiKey,
  };
}

// ============================================================
// FUTURE TOOL REGISTRY
// ============================================================
//
// Keep this empty for now.
//
// When we add Gock tools later, they can be
// declared here without rebuilding the server.
//
// Example:
//
// const GOCK_TOOLS = [
//   {
//     type: "function",
//     name: "example",
//     description: "...",
//     parameters: {...}
//   }
// ];
//

const GOCK_TOOLS = [];

// ============================================================
// GEMINI ERROR
// ============================================================

class GeminiError
  extends Error {
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
// GEMINI REQUEST
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

  if (
    GOCK_TOOLS.length
  ) {
    body.tools =
      GOCK_TOOLS;
  }

  return body;
}

async function requestGemini({
  message,
  previousInteractionId,
  systemInstruction,
  stream = false,
  signal = null,
}) {
  if (
    !CONFIG.geminiApiKey
  ) {
    throw new GeminiError(
      "GEMINI_API_KEY is not configured.",
      500
    );
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      CONFIG.geminiTimeoutMs
    );

  let externalAbort;

  if (signal) {
    externalAbort =
      () => {
        if (
          !controller.signal
            .aborted
        ) {
          controller.abort();
        }
      };

    if (
      signal.aborted
    ) {
      controller.abort();
    } else {
      signal.addEventListener(
        "abort",
        externalAbort,
        {
          once: true,
        }
      );
    }
  }

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

          body: JSON.stringify(
            createGeminiBody({
              message,
              previousInteractionId,
              systemInstruction,
              stream,
            })
          ),

          signal:
            controller.signal,
        }
      );

    if (!response.ok) {
      let details = null;

      try {
        details =
          await response.json();
      } catch {}

      throw new GeminiError(
        details?.error?.message ||
          `Gemini returned HTTP ${response.status}.`,
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
        "Gemini request was cancelled or timed out.",
        504
      );
    }

    throw new GeminiError(
      error?.message ||
        "Could not reach Gemini.",
      502
    );
  } finally {
    clearTimeout(timeout);

    if (
      signal &&
      externalAbort
    ) {
      signal.removeEventListener(
        "abort",
        externalAbort
      );
    }
  }
}

// ============================================================
// SAFE RETRY
// ============================================================
//
// Important:
// Do not blindly retry every stateful interaction.
// A duplicated stateful turn can create duplicate
// interactions.
//
// Retry only connection/server failures before
// a response is successfully received.
//

function retryableStatus(
  status
) {
  return [
    408,
    425,
    500,
    502,
    503,
    504,
  ].includes(status);
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

// ============================================================
// RESPONSE TEXT
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
        item?.type ===
          "text" &&
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
    await requestGeminiWithSafeRetry(
      {
        message,

        previousInteractionId,

        systemInstruction,

        stream: false,
      }
    );

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
// SSE
// ============================================================

function parseSSEBlock(
  block
) {
  let eventType =
    "message";

  const dataLines = [];

  for (
    const line of
      block.split(/\r?\n/)
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
    }

    if (
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
      } =
        await reader.read();

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
        blocks.pop() ||
        "";

      for (
        const block of
          blocks
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

    buffer +=
      decoder.decode();

    if (
      buffer.trim()
    ) {
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

// ============================================================
// STREAMING INTERACTION
// ============================================================

async function streamInteraction({
  message,
  previousInteractionId,
  systemInstruction,
  signal,
  onEvent,
}) {
  const response =
    await requestGemini({
      message,

      previousInteractionId,

      systemInstruction,

      stream: true,

      signal,
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

  let completed =
    false;

  for await (
    const event of
      parseSSE(
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
        data?.id ||
        interactionId;

      await onEvent({
        type:
          "interaction",
        interactionId,
      });

      continue;
    }

    // --------------------------------------------------------
    // Status update
    // --------------------------------------------------------

    if (
      event.eventType ===
      "interaction.status_update"
    ) {
      await onEvent({
        type:
          "status",
        status:
          data?.status ||
          data?.interaction
            ?.status ||
          null,
      });

      continue;
    }

    // --------------------------------------------------------
    // Step delta
    // --------------------------------------------------------

    if (
      event.eventType ===
      "step.delta"
    ) {
      const delta =
        data?.delta;

      if (
        delta?.type ===
          "text" &&
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
    // Interaction completed
    // --------------------------------------------------------

    if (
      event.eventType ===
      "interaction.completed"
    ) {
      interactionId =
        data?.interaction?.id ||
        data?.id ||
        interactionId;

      completed = true;

      await onEvent({
        type:
          "completed",

        interactionId,

        status:
          data?.interaction
            ?.status ||
          "completed",

        usage:
          data?.interaction
            ?.usage ||
          null,
      });
    }
  }

  if (
    !completed
  ) {
    throw new GeminiError(
      "Gemini stream ended before completion.",
      502
    );
  }

  if (
    !reply.trim()
  ) {
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
// STATE ERROR DETECTION
// ============================================================

function isExpiredInteractionError(
  error
) {
  if (
    !error
  ) {
    return false;
  }

  if (
    error.status === 404
  ) {
    return true;
  }

  const message =
    String(
      error.message ||
        ""
    ).toLowerCase();

  return (
    message.includes(
      "previous_interaction"
    ) ||
    message.includes(
      "interaction not found"
    ) ||
    (
      message.includes(
        "interaction"
      ) &&
      message.includes(
        "not found"
      )
    )
  );
}

// ============================================================
// ERROR CLASSIFICATION
// ============================================================

function classifyError(
  error
) {
  if (
    error instanceof
    GeminiError
  ) {
    if (
      error.status ===
      429
    ) {
      return {
        status: 429,
        code:
          "GEMINI_RATE_LIMITED",
      };
    }

    if (
      error.status ===
        401 ||
      error.status ===
        403
    ) {
      return {
        status: 502,
        code:
          "GEMINI_AUTH_ERROR",
      };
    }

    if (
      error.status ===
      504
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
// JSON RESPONSE
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

    server:
      VERSION,

    core:
      "2.0.0",

    frontend:
      "2.0.0",

    model:
      CONFIG.geminiModel,

    gemini:
      CONFIG.geminiApiKey
        ? "configured"
        : "missing",

    database:
      database
        ? "connected"
        : "disconnected",

    engine:
      "Gemini Interactions API",

    apiVersion:
      CONFIG.geminiApiVersion,

    streaming:
      "available",

    memory:
      db
        ? "postgresql-backed"
        : "unavailable",

    state:
      "previous_interaction_id",

    tools:
      GOCK_TOOLS.length
        ? "enabled"
        : "ready",

    environment:
      CONFIG.nodeEnv,

    timestamp:
      nowIso(),
  };
}

app.get(
  "/health",
  async (
    req,
    res
  ) => {
    try {
      return res.json(
        await healthData()
      );
    } catch {
      return res
        .status(500)
        .json({
          ok: false,

          status:
            "error",

          server:
            VERSION,
        });
    }
  }
);

app.get(
  "/api/health",
  async (
    req,
    res
  ) => {
    try {
      return res.json(
        await healthData()
      );
    } catch {
      return res
        .status(500)
        .json({
          ok: false,

          status:
            "error",

          server:
            VERSION,
        });
    }
  }
);

// ============================================================
// FRONTEND
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "index-v2.html"
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
      sanitizeContext(
        req.body?.context
      );

    return sendJson(
      res,
      200,
      {
        ok: true,

        server:
          VERSION,

        context,
      }
    );
  }
);

// ============================================================
// MEMORIES
// ============================================================

app.get(
  "/api/memories",
  async (
    req,
    res
  ) => {
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
        `[Gock V3] [${req.requestId}] Memory list error:`,
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
// SAVE MEMORY
// ============================================================

app.post(
  "/api/memory",
  async (
    req,
    res
  ) => {
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
            ) ||
            "general",

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

          memory:
            saved,
        }
      );
    } catch (error) {
      console.error(
        `[Gock V3] [${req.requestId}] Memory save error:`,
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
  async (
    req,
    res
  ) => {
    const sessionId =
      getSessionId(
        req,
        res
      );

    try {
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

          reset:
            true,

          server:
            VERSION,
        }
      );
    } catch (error) {
      console.error(
        `[Gock V3] [${req.requestId}] Reset error:`,
        error?.message ||
          error
      );

      return sendJson(
        res,
        500,
        {
          ok: false,

          error:
            "Could not reset conversation.",
        }
      );
    }
  }
);

// ============================================================
// PREPARE MESSAGE
// ============================================================

async function prepareMessage(
  req,
  res
) {
  const message =
    safeString(
      req.body?.message,
      CONFIG.maxMessageLength
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
    sanitizeContext(
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

  if (
    requestedMemory
  ) {
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
        `[Gock V3] [${req.requestId}] Automatic memory save failed:`,
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
// NON-STREAMING CHAT
// ============================================================

app.post(
  "/api/message",
  async (
    req,
    res
  ) => {
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

            const systemInstruction =
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
              if (
                !session.previousInteractionId ||
                !isExpiredInteractionError(
                  error
                )
              ) {
                throw error;
              }

              console.log(
                `[Gock V3] [${req.requestId}] Previous interaction expired. Starting fresh.`
              );

              await clearSession(
                sessionId
              );

              session =
                await getSession(
                  sessionId
                );

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

      return sendJson(
        res,
        200,
        {
          ok: true,

          reply:
            result.reply,

          interactionId:
            result.interactionId,

          model:
            CONFIG.geminiModel,

          mode:
            detectGockMode(
              message
            ) ||
            "casual",

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
        `[Gock V3] [${req.requestId}] Message error:`,
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
            "Gock request failed.",
        }
      );
    }
  }
);

// ============================================================
// STREAMING CHAT
// ============================================================

app.post(
  "/api/message/stream",
  async (
    req,
    res
  ) => {
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

    const abortController =
      new AbortController();

    let clientDisconnected =
      false;

    res.on(
      "close",
      () => {
        if (
          !res.writableEnded
        ) {
          clientDisconnected =
            true;

          abortController.abort();
        }
      }
    );

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

    if (
      typeof res.flushHeaders ===
      "function"
    ) {
      res.flushHeaders();
    }

    function writeEvent(
      event,
      data
    ) {
      if (
        clientDisconnected ||
        res.writableEnded
      ) {
        return false;
      }

      res.write(
        `event: ${event}\n`
      );

      res.write(
        `data: ${JSON.stringify(
          data
        )}\n\n`
      );

      return true;
    }

    try {
      await withSessionLock(
        sessionId,
        async () => {
          let session =
            await getSession(
              sessionId
            );

          const systemInstruction =
            await createSystemInstruction({
              message,

              context,
            });

          let interactionId =
            null;

          async function runStream(
            previousInteractionId
          ) {
            return streamInteraction({
              message,

              previousInteractionId,

              systemInstruction,

              signal:
                abortController
                  .signal,

              onEvent:
                async event => {
                  if (
                    event.type ===
                    "interaction"
                  ) {
                    interactionId =
                      event.interactionId;

                    writeEvent(
                      "interaction",
                      {
                        interactionId,
                      }
                    );

                    return;
                  }

                  if (
                    event.type ===
                    "text"
                  ) {
                    writeEvent(
                      "text",
                      {
                        text:
                          event.text,
                      }
                    );

                    return;
                  }

                  if (
                    event.type ===
                    "status"
                  ) {
                    writeEvent(
                      "status",
                      {
                        status:
                          event.status,
                      }
                    );

                    return;
                  }

                  if (
                    event.type ===
                    "completed"
                  ) {
                    interactionId =
                      event.interactionId ||
                      interactionId;

                    writeEvent(
                      "completed",
                      {
                        interactionId,

                        status:
                          event.status,

                        usage:
                          event.usage ||
                          null,
                      }
                    );
                  }
                },
            });
          }

          try {
            await runStream(
              session.previousInteractionId
            );
          } catch (error) {
            if (
              clientDisconnected
            ) {
              return;
            }

            if (
              !session.previousInteractionId ||
              !isExpiredInteractionError(
                error
              )
            ) {
              throw error;
            }

            console.log(
              `[Gock V3] [${req.requestId}] Previous interaction expired during stream.`
            );

            await clearSession(
              sessionId
            );

            interactionId =
              null;

            writeEvent(
              "conversation_reset",
              {
                reason:
                  "previous interaction expired",
              }
            );

            await runStream(
              null
            );
          }

          if (
            interactionId
          ) {
            await setPreviousInteraction(
              sessionId,
              interactionId
            );
          }

          if (
            !clientDisconnected
          ) {
            writeEvent(
              "done",
              {
                ok: true,

                server:
                  VERSION,

                model:
                  CONFIG.geminiModel,

                interactionId,

                mode:
                  detectGockMode(
                    message
                  ) ||
                  "casual",

                memory:
                  requestedMemory
                    ? "saved"
                    : "unchanged",
              }
            );
          }
        }
      );

      if (
        !res.writableEnded
      ) {
        res.end();
      }
    } catch (error) {
      if (
        clientDisconnected
      ) {
        return;
      }

      const classification =
        classifyError(
          error
        );

      console.error(
        `[Gock V3] [${req.requestId}] Stream error:`,
        error?.message ||
          error
      );

      if (
        res.headersSent &&
        !res.writableEnded
      ) {
        writeEvent(
          "error",
          {
            ok: false,

            code:
              classification.code,

            error:
              error?.message ||
              "Gock streaming failed.",

            requestId:
              req.requestId,
          }
        );

        res.end();

        return;
      }

      if (
        !res.headersSent
      ) {
        sendJson(
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
    return sendJson(
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
      `[Gock V3] [${req.requestId}] Unhandled error:`,
      error?.message ||
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
// STARTUP
// ============================================================

let server = null;

async function startServer() {
  console.log(
    "================================================"
  );

  console.log(
    "GOCK SERVER V3.1"
  );

  console.log(
    "================================================"
  );

  console.log(
    `Server: ${VERSION}`
  );

  console.log(
    `Core: gock-core-v2.js`
  );

  console.log(
    `Core version: 2.0.0`
  );

  console.log(
    `Frontend: index-v2.html`
  );

  console.log(
    `Model: ${CONFIG.geminiModel}`
  );

  console.log(
    `Gemini API: ${CONFIG.geminiApiVersion}/interactions`
  );

  console.log(
    `Streaming: enabled`
  );

  console.log(
    `Tools: ${
      GOCK_TOOLS.length
        ? "enabled"
        : "ready"
    }`
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
      "[Gock V3] WARNING: GEMINI_API_KEY is missing."
    );
  }

  if (db) {
    try {
      await initializeDatabase();

      await cleanupOldSessions();

      console.log(
        "[Gock V3] PostgreSQL initialized."
      );
    } catch (error) {
      console.error(
        "[Gock V3] PostgreSQL initialization failed:",
        error?.message ||
          error
      );
    }
  }

  server =
    app.listen(
      CONFIG.port,
      "0.0.0.0",
      () => {
        console.log(
          "================================================"
        );

        console.log(
          `Gock V3.1 listening on port ${CONFIG.port}`
        );

        console.log(
          "================================================"
        );
      }
    );
}

// ============================================================
// DATABASE CLEANUP
// ============================================================

setInterval(
  () => {
    cleanupOldSessions()
      .catch(error => {
        console.error(
          "[Gock V3] Scheduled cleanup failed:",
          error?.message ||
            error
        );
      });
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
    `[Gock V3] ${signal} received. Shutting down...`
  );

  if (server) {
    await new Promise(
      resolve => {
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
    "[Gock V3] Shutdown complete."
  );

  process.exit(0);
}

process.once(
  "SIGTERM",
  () =>
    shutdown(
      "SIGTERM"
    )
);

process.once(
  "SIGINT",
  () =>
    shutdown(
      "SIGINT"
    )
);

// ============================================================
// START
// ============================================================

startServer().catch(
  error => {
    console.error(
      "[Gock V3] Fatal startup error:",
      error
    );

    process.exit(1);
  }
);
