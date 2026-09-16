import express from "express";
import cors from "cors";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

import { buildGockSystemInstruction } from "./gock-core.js";

const { Pool } = pg;

// ============================================================
// GOCK
// Production Engine / Gemini / Memory / Sessions / Streaming
// ============================================================

// ------------------------------------------------------------
// Application
// ------------------------------------------------------------

const app = express();

app.disable("x-powered-by");

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

const PORT = Number(
  process.env.PORT || 3000
);

const NODE_ENV =
  process.env.NODE_ENV || "development";

const IS_PRODUCTION =
  NODE_ENV === "production";

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "";

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.6-flash";

const GEMINI_THINKING_LEVEL =
  process.env.GEMINI_THINKING_LEVEL ||
  "medium";

const GEMINI_MAX_OUTPUT_TOKENS =
  Number(
    process.env.GEMINI_MAX_OUTPUT_TOKENS ||
      0
  );

const GEMINI_API_BASE =
  process.env.GEMINI_API_BASE ||
  "https://generativelanguage.googleapis.com/v1beta";

const GEMINI_INTERACTIONS_URL =
  `${GEMINI_API_BASE}/interactions`;

const DATABASE_URL =
  process.env.DATABASE_URL || "";

const MAX_MESSAGE_LENGTH =
  20000;

const MAX_MEMORY_LENGTH =
  2000;

const MAX_HISTORY_MESSAGES =
  40;

const MAX_MEMORIES =
  12;

const GEMINI_TIMEOUT_MS =
  60000;

const MAX_RETRIES =
  2;

const SESSION_COOKIE =
  "gock_session";

const SESSION_MAX_AGE_SECONDS =
  7 * 24 * 60 * 60;

// ------------------------------------------------------------
// Paths
// ------------------------------------------------------------

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

// ============================================================
// EXPRESS
// ============================================================

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

app.use(
  express.urlencoded({
    extended: false,
    limit: "1mb",
  })
);

// ============================================================
// REQUEST IDs
// ============================================================

app.use(
  (req, res, next) => {
    const incoming =
      req.headers[
        "x-request-id"
      ];

    const requestId =
      typeof incoming === "string" &&
      incoming.length <= 100
        ? incoming
        : crypto.randomUUID();

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
// POSTGRESQL
// ============================================================

let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString:
      DATABASE_URL,

    max: 5,

    idleTimeoutMillis:
      30000,

    connectionTimeoutMillis:
      5000,

    ssl:
      IS_PRODUCTION
        ? {
            rejectUnauthorized:
              false,
          }
        : undefined,
  });

  pool.on(
    "error",
    (error) => {
      console.error(
        "[DB] Pool error:",
        error?.message ||
          error
      );
    }
  );
} else {
  console.warn(
    "[DB] DATABASE_URL is not configured."
  );
}

// ============================================================
// DATABASE INITIALIZATION
// ============================================================

async function initializeDatabase() {
  if (!pool) {
    return false;
  }

  // ----------------------------------------------------------
  // Persistent Gock memories
  // ----------------------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gock_memories (
      id BIGSERIAL PRIMARY KEY,
      category TEXT NOT NULL DEFAULT 'general',
      memory TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ----------------------------------------------------------
  // Browser/session -> Gemini interaction mapping
  // ----------------------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gock_sessions (
      session_id TEXT PRIMARY KEY,
      interaction_id TEXT,
      model TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_gock_memories_importance
    ON gock_memories(importance DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_gock_memories_updated
    ON gock_memories(updated_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_gock_sessions_updated
    ON gock_sessions(updated_at DESC);
  `);

  return true;
}

// ============================================================
// DATABASE HEALTH
// ============================================================

async function databaseIsHealthy() {
  if (!pool) {
    return false;
  }

  try {
    await pool.query(
      "SELECT 1"
    );

    return true;
  } catch (error) {
    console.error(
      "[DB] Health check failed:",
      error?.message ||
        error
    );

    return false;
  }
}

// ============================================================
// SESSION HELPERS
// ============================================================

function generateSessionId() {
  return crypto.randomBytes(32).toString("hex");
}

function parseCookies(
  cookieHeader
) {
  const cookies = {};

  if (
    typeof cookieHeader !==
    "string"
  ) {
    return cookies;
  }

  for (
    const part of cookieHeader.split(";")
  ) {
    const index =
      part.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key =
      part
        .slice(0, index)
        .trim();

    const value =
      part
        .slice(index + 1)
        .trim();

    if (!key) {
      continue;
    }

    cookies[key] =
      decodeURIComponent(
        value
      );
  }

  return cookies;
}

function setSessionCookie(
  res,
  sessionId
) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(
      sessionId
    )}`,

    "Path=/",

    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,

    "HttpOnly",

    "SameSite=Lax",
  ];

  if (IS_PRODUCTION) {
    parts.push(
      "Secure"
    );
  }

  res.setHeader(
    "Set-Cookie",
    parts.join("; ")
  );
}

function clearSessionCookie(
  res
) {
  const parts = [
    `${SESSION_COOKIE}=`,

    "Path=/",

    "Max-Age=0",

    "HttpOnly",

    "SameSite=Lax",
  ];

  if (IS_PRODUCTION) {
    parts.push(
      "Secure"
    );
  }

  res.setHeader(
    "Set-Cookie",
    parts.join("; ")
  );
}

async function getOrCreateSession(
  req,
  res
) {
  const cookies =
    parseCookies(
      req.headers.cookie
    );

  let sessionId =
    cookies[
      SESSION_COOKIE
    ];

  if (
    typeof sessionId !==
      "string" ||
    !/^[a-f0-9]{64}$/.test(
      sessionId
    )
  ) {
    sessionId =
      generateSessionId();

    setSessionCookie(
      res,
      sessionId
    );
  }

  if (pool) {
    await pool.query(
      `
        INSERT INTO gock_sessions
          (
            session_id
          )
        VALUES
          ($1)
        ON CONFLICT
          (session_id)
        DO NOTHING
      `,
      [sessionId]
    );
  }

  return sessionId;
}

// ============================================================
// SESSION STATE
// ============================================================

async function getSessionState(
  sessionId
) {
  if (!pool) {
    return null;
  }

  const result =
    await pool.query(
      `
        SELECT
          session_id,
          interaction_id,
          model,
          created_at,
          updated_at
        FROM gock_sessions
        WHERE session_id = $1
        LIMIT 1
      `,
      [sessionId]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function saveSessionInteraction(
  sessionId,
  interactionId
) {
  if (!pool) {
    return;
  }

  if (
    !interactionId
  ) {
    return;
  }

  await pool.query(
    `
      INSERT INTO gock_sessions
        (
          session_id,
          interaction_id,
          model,
          updated_at
        )
      VALUES
        (
          $1,
          $2,
          $3,
          NOW()
        )
      ON CONFLICT
        (session_id)
      DO UPDATE SET
        interaction_id =
          EXCLUDED.interaction_id,
        model =
          EXCLUDED.model,
        updated_at =
          NOW()
    `,
    [
      sessionId,
      interactionId,
      GEMINI_MODEL,
    ]
  );
}

async function resetSession(
  sessionId
) {
  if (!pool) {
    return;
  }

  await pool.query(
    `
      UPDATE gock_sessions
      SET
        interaction_id = NULL,
        model = NULL,
        updated_at = NOW()
      WHERE session_id = $1
    `,
    [sessionId]
  );
}

// ============================================================
// SESSION LOCKS
// ============================================================
//
// Prevents two simultaneous messages from the same browser
// from racing and corrupting the conversation chain.
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
    ) || Promise.resolve();

  let release;

  const current =
    new Promise(
      (resolve) => {
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
  limit = MAX_MEMORIES
) {
  if (!pool) {
    return [];
  }

  const safeLimit =
    Math.min(
      Math.max(
        Number.parseInt(
          limit,
          10
        ) || MAX_MEMORIES,
        1
      ),
      100
    );

  const result =
    await pool.query(
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

async function saveMemory(
  memory,
  category = "general",
  importance = 3
) {
  if (!pool) {
    return null;
  }

  if (
    typeof memory !==
    "string"
  ) {
    return null;
  }

  const cleanMemory =
    memory
      .replace(/\u0000/g, "")
      .trim()
      .slice(
        0,
        MAX_MEMORY_LENGTH
      );

  if (!cleanMemory) {
    return null;
  }

  const cleanCategory =
    typeof category ===
      "string" &&
    category.trim()
      ? category
          .trim()
          .slice(0, 100)
      : "general";

  const safeImportance =
    Math.min(
      Math.max(
        Number.parseInt(
          importance,
          10
        ) || 3,
        1
      ),
      5
    );

  const existing =
    await pool.query(
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
    existing.rows.length >
    0
  ) {
    const updated =
      await pool.query(
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

  const inserted =
    await pool.query(
      `
        INSERT INTO gock_memories
          (
            category,
            memory,
            importance
          )
        VALUES
          (
            $1,
            $2,
            $3
          )
        RETURNING *
      `,
      [
        cleanCategory,
        cleanMemory,
        safeImportance,
      ]
    );

  return inserted.rows[0];
}

// ------------------------------------------------------------
// Relevant memory retrieval
// ------------------------------------------------------------

async function getRelevantMemories(
  message
) {
  if (!pool) {
    return [];
  }

  if (
    typeof message !==
      "string" ||
    !message.trim()
  ) {
    return [];
  }

  const words =
    message
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
      .slice(0, 12);

  if (
    words.length === 0
  ) {
    return getMemories(
      MAX_MEMORIES
    );
  }

  const conditions =
    words.map(
      (_, index) =>
        `memory ILIKE $${
          index + 1
        }`
    );

  const values =
    words.map(
      (word) =>
        `%${word}%`
    );

  try {
    const result =
      await pool.query(
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
          MAX_MEMORIES,
        ]
      );

    if (
      result.rows.length >
      0
    ) {
      return result.rows;
    }

    return getMemories(
      MAX_MEMORIES
    );
  } catch (error) {
    console.error(
      "[MEMORY] Retrieval failed:",
      error?.message ||
        error
    );

    return [];
  }
}

// ============================================================
// INPUT NORMALIZATION
// ============================================================

function normalizeMessage(
  message
) {
  if (
    typeof message !==
    "string"
  ) {
    return "";
  }

  return message
    .replace(/\u0000/g, "")
    .trim()
    .slice(
      0,
      MAX_MESSAGE_LENGTH
    );
}

function normalizeHistory(
  history
) {
  if (
    !Array.isArray(history)
  ) {
    return [];
  }

  return history
    .slice(
      -MAX_HISTORY_MESSAGES
    )
    .map(
      (item) => {
        if (
          !item ||
          typeof item !==
            "object"
        ) {
          return null;
        }

        const role =
          item.role ===
            "assistant" ||
          item.role ===
            "model"
            ? "model"
            : item.role ===
                "user"
              ? "user"
              : null;

        const text =
          typeof item.content ===
          "string"
            ? item.content
            : typeof item.text ===
                "string"
              ? item.text
              : "";

        if (
          !role ||
          !text.trim()
        ) {
          return null;
        }

        return {
          role,

          text:
            text
              .replace(
                /\u0000/g,
                ""
              )
              .slice(
                0,
                MAX_MESSAGE_LENGTH
              ),
        };
      }
    )
    .filter(Boolean);
}

// ============================================================
// GOCK CONTEXT
// ============================================================

async function buildGockContext(
  message,
  suppliedContext
) {
  const memories =
    await getRelevantMemories(
      message
    );

  const context =
    suppliedContext &&
    typeof suppliedContext ===
      "object" &&
    !Array.isArray(
      suppliedContext
    )
      ? {
          ...suppliedContext,
        }
      : {};

  if (
    memories.length > 0
  ) {
    context.persistentMemories =
      memories.map(
        (item) => ({
          category:
            item.category,

          memory:
            item.memory,

          importance:
            item.importance,
        })
      );
  }

  return context;
}

// ============================================================
// MEMORY COMMANDS
// ============================================================

function extractExplicitMemory(
  message
) {
  const patterns = [
    /^remember that\s+(.+)$/i,

    /^remember\s+(.+)$/i,

    /^save this\s*:\s*(.+)$/i,

    /^save this\s+(.+)$/i,

    /^keep this in memory\s*:\s*(.+)$/i,

    /^keep this in memory\s+(.+)$/i,
  ];

  for (
    const pattern of patterns
  ) {
    const match =
      message.match(
        pattern
      );

    if (
      match?.[1]?.trim()
    ) {
      return match[1]
        .trim()
        .slice(
          0,
          MAX_MEMORY_LENGTH
        );
    }
  }

  return null;
}

// ============================================================
// GEMINI ERRORS
// ============================================================

class GeminiError extends Error {
  constructor(
    message,
    status = 502,
    code = "GEMINI_ERROR",
    extra = {}
  ) {
    super(message);

    this.name =
      "GeminiError";

    this.status =
      status;

    this.code =
      code;

    Object.assign(
      this,
      extra
    );
  }
}

// ============================================================
// RETRY / RATE LIMIT HELPERS
// ============================================================

function extractRetrySeconds(
  message,
  headers
) {
  const retryAfter =
    headers?.get(
      "retry-after"
    );

  if (retryAfter) {
    const value =
      Number(
        retryAfter
      );

    if (
      Number.isFinite(
        value
      )
    ) {
      return Math.ceil(
        value
      );
    }
  }

  const match =
    String(
      message || ""
    ).match(
      /retry in\s+([\d.]+)\s*s/i
    );

  if (match) {
    const value =
      Number(
        match[1]
      );

    if (
      Number.isFinite(
        value
      )
    ) {
      return Math.ceil(
        value
      );
    }
  }

  return null;
}

function isRetryableStatus(
  status
) {
  return [
    500,
    502,
    503,
    504,
  ].includes(
    status
  );
}

function sleep(
  milliseconds
) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        milliseconds
      )
  );
}

// ============================================================
// GEMINI REQUEST
// ============================================================

async function callGemini(
  body,
  {
    stream = false,
    requestId = null,
  } = {}
) {
  if (
    !GEMINI_API_KEY
  ) {
    throw new GeminiError(
      "GEMINI_API_KEY is not configured.",
      500,
      "GEMINI_API_KEY_MISSING"
    );
  }

  let lastError =
    null;

  for (
    let attempt = 0;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        GEMINI_TIMEOUT_MS
      );

    try {
      const response =
        await fetch(
          GEMINI_INTERACTIONS_URL,
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",

              "Accept": stream
                ? "text/event-stream"
                : "application/json",

              "x-goog-api-key":
                GEMINI_API_KEY,

              "X-Request-ID":
                requestId ||
                crypto.randomUUID(),
            },

            body:
              JSON.stringify(
                body
              ),

            signal:
              controller.signal,
          }
        );

      // ------------------------------------------------------
      // Streaming responses are handled elsewhere.
      // ------------------------------------------------------

      if (stream) {
        if (
          !response.ok
        ) {
          let data = null;

          try {
            data =
              await response.json();
          } catch {
            // ignore
          }

          const message =
            data?.error?.message ||
            `Gemini returned HTTP ${response.status}.`;

          const retrySeconds =
            extractRetrySeconds(
              message,
              response.headers
            );

          if (
            response.status ===
              429 ||
            data?.error?.status ===
              "RESOURCE_EXHAUSTED"
          ) {
            throw new GeminiError(
              message,
              429,
              "GEMINI_RATE_LIMITED",
              {
                retryAfterSeconds:
                  retrySeconds,
              }
            );
          }

          throw new GeminiError(
            message,
            response.status,
            "GEMINI_API_ERROR"
          );
        }

        if (
          !response.body
        ) {
          throw new GeminiError(
            "Gemini did not return a streaming body.",
            502,
            "GEMINI_NO_STREAM"
          );
        }

        return response;
      }

      let data = null;

      try {
        data =
          await response.json();
      } catch {
        data = null;
      }

      if (
        !response.ok
      ) {
        const message =
          data?.error?.message ||
          `Gemini returned HTTP ${response.status}.`;

        const retrySeconds =
          extractRetrySeconds(
            message,
            response.headers
          );

        const rateLimited =
          response.status ===
            429 ||
          data?.error?.status ===
            "RESOURCE_EXHAUSTED" ||
          /quota|rate.?limit|resource.?exhausted/i.test(
            message
          );

        if (
          rateLimited
        ) {
          throw new GeminiError(
            message,
            429,
            "GEMINI_RATE_LIMITED",
            {
              retryAfterSeconds:
                retrySeconds,
            }
          );
        }

        if (
          isRetryableStatus(
            response.status
          ) &&
          attempt <
            MAX_RETRIES
        ) {
          lastError =
            new GeminiError(
              message,
              response.status,
              "GEMINI_TRANSIENT_ERROR"
            );

          const delay =
            500 *
            2 ** attempt;

          await sleep(
            delay
          );

          continue;
        }

        throw new GeminiError(
          message,
          response.status,
          "GEMINI_API_ERROR"
        );
      }

      if (
        data?.status ===
        "failed"
      ) {
        throw new GeminiError(
          data?.error?.message ||
            "Gemini interaction failed.",
          502,
          "GEMINI_INTERACTION_FAILED"
        );
      }

      return data;
    } catch (error) {
      if (
        error?.name ===
        "AbortError"
      ) {
        lastError =
          new GeminiError(
            "Gemini request timed out.",
            504,
            "GEMINI_TIMEOUT"
          );

        if (
          attempt <
          MAX_RETRIES
        ) {
          await sleep(
            500 *
              2 ** attempt
          );

          continue;
        }

        throw lastError;
      }

      if (
        error instanceof
        GeminiError
      ) {
        if (
          error.code ===
            "GEMINI_RATE_LIMITED" ||
          error.code ===
            "GEMINI_API_ERROR" ||
          error.code ===
            "GEMINI_API_KEY_MISSING"
        ) {
          throw error;
        }

        if (
          error.status >=
            500 &&
          attempt <
            MAX_RETRIES
        ) {
          lastError =
            error;

          await sleep(
            500 *
              2 ** attempt
          );

          continue;
        }

        throw error;
      }

      lastError =
        new GeminiError(
          error?.message ||
            "Network error communicating with Gemini.",
          502,
          "GEMINI_NETWORK_ERROR"
        );

      if (
        attempt <
        MAX_RETRIES
      ) {
        await sleep(
          500 *
            2 ** attempt
        );

        continue;
      }

      throw lastError;
    } finally {
      clearTimeout(
        timeout
      );
    }
  }

  throw (
    lastError ||
    new GeminiError(
      "Gemini request failed.",
      502,
      "GEMINI_ERROR"
    )
  );
}

// ============================================================
// GEMINI OUTPUT
// ============================================================

function extractGeminiText(
  data
) {
  if (
    typeof data?.output_text ===
      "string" &&
    data.output_text.trim()
  ) {
    return data.output_text.trim();
  }

  const steps =
    Array.isArray(
      data?.steps
    )
      ? data.steps
      : [];

  const parts = [];

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
        parts.push(
          item.text
        );
      }
    }
  }

  return parts
    .join("")
    .trim();
}

// ============================================================
// GEMINI BODY
// ============================================================

function buildGenerationConfig() {
  const config = {
    thinking_level:
      GEMINI_THINKING_LEVEL,
  };

  if (
    Number.isFinite(
      GEMINI_MAX_OUTPUT_TOKENS
    ) &&
    GEMINI_MAX_OUTPUT_TOKENS >
      0
  ) {
    config.max_output_tokens =
      GEMINI_MAX_OUTPUT_TOKENS;
  }

  return config;
}

async function buildGeminiBody(
  {
    message,
    context,
    previousInteractionId,
  }
) {
  const gockContext =
    await buildGockContext(
      message,
      context
    );

  const systemInstruction =
    buildGockSystemInstruction(
      gockContext
    );

  const body = {
    model:
      GEMINI_MODEL,

    input:
      message,

    system_instruction:
      systemInstruction,

    generation_config:
      buildGenerationConfig(),

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
// STANDARD MESSAGE
// ============================================================

async function generateGockResponse({
  sessionId,
  message,
  context,
  requestId,
}) {
  let state =
    await getSessionState(
      sessionId
    );

  let previousInteractionId =
    state?.interaction_id ||
    null;

  // ----------------------------------------------------------
  // First attempt: continue server-side conversation.
  // ----------------------------------------------------------

  try {
    const body =
      await buildGeminiBody({
        message,
        context,
        previousInteractionId,
      });

    const data =
      await callGemini(
        body,
        {
          requestId,
        }
      );

    const reply =
      extractGeminiText(
        data
      );

    if (!reply) {
      throw new GeminiError(
        "Gemini returned no usable text.",
        502,
        "GEMINI_EMPTY_RESPONSE"
      );
    }

    const interactionId =
      data?.id || null;

    if (
      interactionId
    ) {
      await saveSessionInteraction(
        sessionId,
        interactionId
      );
    }

    return {
      reply,

      interactionId,

      stateful: true,

      usage:
        data?.usage ||
        null,
    };
  } catch (error) {
    // --------------------------------------------------------
    // If Google's stored interaction expired, start a fresh
    // conversation rather than permanently breaking Gock.
    // --------------------------------------------------------

    const expired =
      error?.status ===
        404 ||
      /not found|expired|unknown interaction/i.test(
        error?.message || ""
      );

    if (
      expired &&
      previousInteractionId
    ) {
      console.warn(
        `[SESSION] Interaction expired for ${sessionId}; starting a new conversation.`
      );

      await resetSession(
        sessionId
      );

      const freshBody =
        await buildGeminiBody({
          message,
          context,
          previousInteractionId:
            null,
        });

      const freshData =
        await callGemini(
          freshBody,
          {
            requestId,
          }
        );

      const freshReply =
        extractGeminiText(
          freshData
        );

      if (!freshReply) {
        throw new GeminiError(
          "Gemini returned no usable text after conversation reset.",
          502,
          "GEMINI_EMPTY_RESPONSE"
        );
      }

      const freshId =
        freshData?.id ||
        null;

      if (freshId) {
        await saveSessionInteraction(
          sessionId,
          freshId
        );
      }

      return {
        reply:
          freshReply,

        interactionId:
          freshId,

        stateful: true,

        conversationReset:
          true,

        usage:
          freshData?.usage ||
          null,
      };
    }

    throw error;
  }
}

// ============================================================
// STREAMING
// ============================================================

async function streamGockResponse({
  sessionId,
  message,
  context,
  requestId,
  res,
}) {
  const state =
    await getSessionState(
      sessionId
    );

  const previousInteractionId =
    state?.interaction_id ||
    null;

  const body =
    await buildGeminiBody({
      message,
      context,
      previousInteractionId,
    });

  body.stream = true;

  const response =
    await callGemini(
      body,
      {
        stream: true,
        requestId,
      }
    );

  // ----------------------------------------------------------
  // SSE headers
  // ----------------------------------------------------------

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

  let buffer = "";

  let interactionId =
    null;

  let finalUsage =
    null;

  let completed =
    false;

  const decoder =
    new TextDecoder();

  function sendEvent(
    event,
    payload
  ) {
    if (
      res.writableEnded
    ) {
      return;
    }

    res.write(
      `event: ${event}\n`
    );

    res.write(
      `data: ${JSON.stringify(
        payload
      )}\n\n`
    );
  }

  sendEvent(
    "start",
    {
      requestId,
      model:
        GEMINI_MODEL,
    }
  );

  const reader =
    response.body.getReader();

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

      buffer += decoder.decode(
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
        const lines =
          block.split(
            /\r?\n/
          );

        let eventName =
          null;

        const dataLines =
          [];

        for (
          const line of lines
        ) {
          if (
            line.startsWith(
              "event:"
            )
          ) {
            eventName =
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
                .trimStart()
            );
          }
        }

        if (
          dataLines.length ===
          0
        ) {
          continue;
        }

        const rawData =
          dataLines.join(
            "\n"
          );

        if (
          rawData ===
          "[DONE]"
        ) {
          continue;
        }

        let data = null;

        try {
          data =
            JSON.parse(
              rawData
            );
        } catch {
          continue;
        }

        // ----------------------------------------------------
        // Interaction created
        // ----------------------------------------------------

        if (
          eventName ===
          "interaction.created"
        ) {
          interactionId =
            data?.interaction
              ?.id ||
            null;

          sendEvent(
            "interaction",
            {
              interactionId,
              status:
                data?.interaction
                  ?.status ||
                "in_progress",
            }
          );

          continue;
        }

        // ----------------------------------------------------
        // Text delta
        // ----------------------------------------------------

        if (
          eventName ===
            "step.delta" &&
          data?.delta
            ?.type ===
            "text"
        ) {
          const text =
            data.delta.text ||
            "";

          if (text) {
            sendEvent(
              "text",
              {
                text,
              }
            );
          }

          continue;
        }

        // ----------------------------------------------------
        // Completion
        // ----------------------------------------------------

        if (
          eventName ===
          "interaction.completed"
        ) {
          completed =
            data?.interaction
              ?.status ===
            "completed";

          interactionId =
            data?.interaction
              ?.id ||
            interactionId;

          finalUsage =
            data?.interaction
              ?.usage ||
            null;

          continue;
        }

        // ----------------------------------------------------
        // Error
        // ----------------------------------------------------

        if (
          eventName ===
          "error"
        ) {
          const message =
            data?.error
              ?.message ||
            "Gemini streaming error.";

          throw new GeminiError(
            message,
            502,
            "GEMINI_STREAM_ERROR"
          );
        }
      }
    }

    // Process any final buffered SSE block.
    if (
      buffer.trim()
    ) {
      const lines =
        buffer.split(
          /\r?\n/
        );

      for (
        const line of lines
      ) {
        if (
          line.startsWith(
            "data:"
          )
        ) {
          const raw =
            line
              .slice(5)
              .trim();

          if (
            !raw ||
            raw ===
              "[DONE]"
          ) {
            continue;
          }

          try {
            const data =
              JSON.parse(
                raw
              );

            if (
              data?.interaction
                ?.id
            ) {
              interactionId =
                data
                  .interaction
                  .id;
            }

            if (
              data?.interaction
                ?.status ===
              "completed"
            ) {
              completed =
                true;
            }
          } catch {
            // Ignore incomplete final SSE data.
          }
        }
      }
    }

    if (
      completed &&
      interactionId
    ) {
      await saveSessionInteraction(
        sessionId,
        interactionId
      );
    }

    sendEvent(
      "done",
      {
        interactionId,
        completed,
        usage:
          finalUsage,
      }
    );

    if (
      !res.writableEnded
    ) {
      res.end();
    }
  } catch (error) {
    console.error(
      "[STREAM] Error:",
      error?.message ||
        error
    );

    if (
      !res.writableEnded
    ) {
      sendEvent(
        "error",
        {
          code:
            error?.code ||
            "GEMINI_STREAM_ERROR",

          error:
            error?.message ||
            "Streaming failed.",
        }
      );

      res.end();
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore.
    }
  }
}

// ============================================================
// SIMPLE RATE LIMITER
// ============================================================
//
// This is intentionally lightweight and local.
// It protects the Render instance from accidental request
// floods without requiring another paid service.
// ============================================================

const rateBuckets =
  new Map();

const RATE_WINDOW_MS =
  60 * 1000;

const RATE_LIMIT =
  30;

function rateLimitKey(
  req
) {
  const session =
    parseCookies(
      req.headers.cookie
    )[
      SESSION_COOKIE
    ];

  if (
    session &&
    /^[a-f0-9]{64}$/.test(
      session
    )
  ) {
    return `session:${session}`;
  }

  const forwarded =
    req.headers[
      "x-forwarded-for"
    ];

  const ip =
    typeof forwarded ===
      "string"
      ? forwarded
          .split(",")[0]
          .trim()
      : req.ip ||
        "unknown";

  return `ip:${ip}`;
}

function isRateLimited(
  req
) {
  const key =
    rateLimitKey(req);

  const now =
    Date.now();

  const bucket =
    rateBuckets.get(
      key
    ) || {
      start: now,
      count: 0,
    };

  if (
    now -
      bucket.start >=
    RATE_WINDOW_MS
  ) {
    bucket.start =
      now;

    bucket.count =
      0;
  }

  bucket.count +=
    1;

  rateBuckets.set(
    key,
    bucket
  );

  if (
    bucket.count >
    RATE_LIMIT
  ) {
    return true;
  }

  return false;
}

// Periodically remove old buckets.
setInterval(
  () => {
    const now =
      Date.now();

    for (
      const [
        key,
        bucket,
      ] of rateBuckets
    ) {
      if (
        now -
          bucket.start >
        RATE_WINDOW_MS * 2
      ) {
        rateBuckets.delete(
          key
        );
      }
    }
  },
  RATE_WINDOW_MS
).unref();

// ============================================================
// HEALTH
// ============================================================

async function buildHealth() {
  const database =
    await databaseIsHealthy();

  return {
    ok: true,

    name: "Gock",

    status: "online",

    model:
      GEMINI_MODEL,

    engine:
      "Gemini Interactions API",

    core:
      "connected",

    database:
      database
        ? "connected"
        : "disconnected",

    gemini:
      GEMINI_API_KEY
        ? "configured"
        : "missing",

    streaming:
      "available",

    state:
      pool
        ? "postgresql-backed"
        : "memoryless",

    environment:
      NODE_ENV,
  };
}

app.get(
  "/health",
  async (req, res) => {
    try {
      res.json(
        await buildHealth()
      );
    } catch (error) {
      console.error(
        "[HEALTH]",
        error
      );

      res.status(500).json({
        ok: false,
        status: "error",
      });
    }
  }
);

app.get(
  "/api/health",
  async (req, res) => {
    try {
      res.json(
        await buildHealth()
      );
    } catch (error) {
      console.error(
        "[API HEALTH]",
        error
      );

      res.status(500).json({
        ok: false,
        status: "error",
      });
    }
  }
);

// ============================================================
// CONTEXT
// ============================================================

app.get(
  "/api/context",
  async (req, res) => {
    try {
      const memories =
        await getMemories(
          MAX_MEMORIES
        );

      res.json({
        ok: true,

        name: "Gock",

        model:
          GEMINI_MODEL,

        engine:
          "Gemini Interactions API",

        core:
          "connected",

        database:
          pool
            ? "configured"
            : "not configured",

        memories,
      });
    } catch (error) {
      console.error(
        "[CONTEXT]",
        error
      );

      res.status(500).json({
        ok: false,

        error:
          "Could not load Gock context.",
      });
    }
  }
);

// ============================================================
// MEMORIES API
// ============================================================

app.get(
  "/api/memories",
  async (req, res) => {
    try {
      const memories =
        await getMemories(
          req.query.limit
        );

      res.json({
        ok: true,

        memories,

        count:
          memories.length,
      });
    } catch (error) {
      console.error(
        "[MEMORIES]",
        error
      );

      res.status(500).json({
        ok: false,

        error:
          "Could not load Gock memories.",
      });
    }
  }
);

app.post(
  "/api/memory",
  async (req, res) => {
    try {
      const memory =
        typeof req.body?.memory ===
        "string"
          ? req.body.memory
          : "";

      if (
        !memory.trim()
      ) {
        return res.status(
          400
        ).json({
          ok: false,

          error:
            "memory must be a non-empty string.",
        });
      }

      const saved =
        await saveMemory(
          memory,
          req.body?.category ||
            "general",
          req.body?.importance ||
            3
        );

      if (!saved) {
        return res.status(
          503
        ).json({
          ok: false,

          error:
            "PostgreSQL memory is not configured.",
        });
      }

      res.json({
        ok: true,

        memory:
          saved,
      });
    } catch (error) {
      console.error(
        "[MEMORY POST]",
        error
      );

      res.status(500).json({
        ok: false,

        error:
          "Could not save memory.",
      });
    }
  }
);

// ============================================================
// CONVERSATION RESET
// ============================================================

app.post(
  "/api/conversation/reset",
  async (req, res) => {
    try {
      const sessionId =
        await getOrCreateSession(
          req,
          res
        );

      await withSessionLock(
        sessionId,
        async () => {
          await resetSession(
            sessionId
          );
        }
      );

      res.json({
        ok: true,

        reset: true,

        message:
          "Gock conversation state has been reset.",
      });
    } catch (error) {
      console.error(
        "[RESET]",
        error
      );

      res.status(500).json({
        ok: false,

        error:
          "Could not reset conversation.",
      });
    }
  }
);

// ============================================================
// MAIN MESSAGE API
// ============================================================

app.post(
  "/api/message",
  async (req, res) => {
    const startedAt =
      Date.now();

    if (
      isRateLimited(req)
    ) {
      return res
        .status(429)
        .json({
          ok: false,

          code:
            "GOCK_RATE_LIMITED",

          error:
            "Too many requests. Please slow down.",
        });
    }

    const message =
      normalizeMessage(
        req.body?.message
      );

    if (!message) {
      return res
        .status(400)
        .json({
          ok: false,

          error:
            "message must be a non-empty string.",
        });
    }

    const context =
      req.body?.context;

    const memoryRequest =
      extractExplicitMemory(
        message
      );

    try {
      const sessionId =
        await getOrCreateSession(
          req,
          res
        );

      const result =
        await withSessionLock(
          sessionId,
          async () => {
            // ----------------------------------------------
            // Save explicit memory first.
            // ----------------------------------------------

            if (
              memoryRequest
            ) {
              try {
                await saveMemory(
                  memoryRequest,
                  "user",
                  4
                );

                console.log(
                  `[${req.requestId}] memory saved`
                );
              } catch (
                memoryError
              ) {
                console.error(
                  `[${req.requestId}] memory save failed:`,
                  memoryError?.message ||
                    memoryError
                );
              }
            }

            // ----------------------------------------------
            // Generate response.
            // ----------------------------------------------

            return generateGockResponse(
              {
                sessionId,

                message,

                context,

                requestId:
                  req.requestId,
              }
            );
          }
        );

      const duration =
        Date.now() -
        startedAt;

      console.log(
        `[${req.requestId}] chat success ${duration}ms`
      );

      return res.json({
        ok: true,

        reply:
          result.reply,

        model:
          GEMINI_MODEL,

        engine:
          "Gemini Interactions API",

        interactionId:
          result.interactionId,

        stateful:
          result.stateful,

        conversationReset:
          Boolean(
            result.conversationReset
          ),

        memory:
          memoryRequest
            ? "saved"
            : "unchanged",

        usage:
          result.usage ||
          null,

        requestId:
          req.requestId,
      });
    } catch (error) {
      console.error(
        `[${req.requestId}] chat failed:`,
        error?.message ||
          error
      );

      if (
        error?.code ===
        "GEMINI_RATE_LIMITED"
      ) {
        const payload = {
          ok: false,

          code:
            "GEMINI_RATE_LIMITED",

          error:
            "Gemini API quota or rate limit reached.",

          message:
            "Gock's server, Core, and PostgreSQL memory are still working. Gemini is temporarily limiting new responses.",

          model:
            GEMINI_MODEL,

          engine:
            "Gemini Interactions API",

          requestId:
            req.requestId,
        };

        if (
          Number.isFinite(
            error.retryAfterSeconds
          )
        ) {
          payload.retryAfterSeconds =
            error.retryAfterSeconds;
        }

        return res
          .status(429)
          .json(payload);
      }

      if (
        error?.code ===
        "GEMINI_API_KEY_MISSING"
      ) {
        return res
          .status(500)
          .json({
            ok: false,

            code:
              "GEMINI_API_KEY_MISSING",

            error:
              "GEMINI_API_KEY is not configured on the server.",

            requestId:
              req.requestId,
          });
      }

      if (
        error?.code ===
        "GEMINI_TIMEOUT"
      ) {
        return res
          .status(504)
          .json({
            ok: false,

            code:
              "GEMINI_TIMEOUT",

            error:
              "Gock timed out while waiting for Gemini.",

            requestId:
              req.requestId,
          });
      }

      const status =
        Number(
          error?.status
        );

      return res
        .status(
          Number.isInteger(
            status
          ) &&
            status >= 400 &&
            status <= 599
            ? status
            : 502
        )
        .json({
          ok: false,

          code:
            error?.code ||
            "GEMINI_ERROR",

          error:
            error?.message ||
            "Gock could not get a response from Gemini.",

          engine:
            "Gemini Interactions API",

          requestId:
            req.requestId,
        });
    }
  }
);

// ============================================================
// STREAMING MESSAGE API
// ============================================================

app.post(
  "/api/message/stream",
  async (req, res) => {
    if (
      isRateLimited(req)
    ) {
      return res
        .status(429)
        .json({
          ok: false,

          code:
            "GOCK_RATE_LIMITED",

          error:
            "Too many requests. Please slow down.",
        });
    }

    const message =
      normalizeMessage(
        req.body?.message
      );

    if (!message) {
      return res
        .status(400)
        .json({
          ok: false,

          error:
            "message must be a non-empty string.",
        });
    }

    const context =
      req.body?.context;

    const memoryRequest =
      extractExplicitMemory(
        message
      );

    try {
      const sessionId =
        await getOrCreateSession(
          req,
          res
        );

      await withSessionLock(
        sessionId,
        async () => {
          if (
            memoryRequest
          ) {
            try {
              await saveMemory(
                memoryRequest,
                "user",
                4
              );
            } catch (
              memoryError
            ) {
              console.error(
                `[${req.requestId}] stream memory error:`,
                memoryError?.message ||
                  memoryError
              );
            }
          }

          await streamGockResponse(
            {
              sessionId,

              message,

              context,

              requestId:
                req.requestId,

              res,
            }
          );
        }
      );
    } catch (error) {
      console.error(
        `[${req.requestId}] stream failed:`,
        error?.message ||
          error
      );

      if (
        !res.headersSent
      ) {
        if (
          error?.code ===
          "GEMINI_RATE_LIMITED"
        ) {
          return res
            .status(429)
            .json({
              ok: false,

              code:
                "GEMINI_RATE_LIMITED",

              error:
                "Gemini API quota or rate limit reached.",

              retryAfterSeconds:
                error.retryAfterSeconds ||
                null,

              requestId:
                req.requestId,
            });
        }

        return res
          .status(
            Number(
              error?.status
            ) || 502
          )
          .json({
            ok: false,

            code:
              error?.code ||
              "GEMINI_STREAM_ERROR",

            error:
              error?.message ||
              "Streaming failed.",

            requestId:
              req.requestId,
          });
      }
    }
  }
);

// ============================================================
// STATIC FRONTEND
// ============================================================

app.use(
  express.static(
    __dirname,
    {
      extensions: [
        "html",
      ],
    }
  )
);

// ============================================================
// API 404
// ============================================================

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      ok: false,

      error:
        "API endpoint not found.",

      requestId:
        req.requestId,
    });
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
      `[${req.requestId || "unknown"}] server error:`,
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    res.status(500).json({
      ok: false,

      error:
        "Internal server error.",

      requestId:
        req.requestId,
    });
  }
);

// ============================================================
// START
// ============================================================

async function startServer() {
  console.log(
    "=================================================="
  );

  console.log(
    "GOCK SERVER"
  );

  console.log(
    "=================================================="
  );

  console.log(
    `Environment: ${NODE_ENV}`
  );

  console.log(
    `Port: ${PORT}`
  );

  console.log(
    `Model: ${GEMINI_MODEL}`
  );

  console.log(
    `Thinking level: ${GEMINI_THINKING_LEVEL}`
  );

  console.log(
    `Engine: Gemini Interactions API`
  );

  console.log(
    `Gemini key: ${
      GEMINI_API_KEY
        ? "configured"
        : "MISSING"
    }`
  );

  console.log(
    `PostgreSQL: ${
      pool
        ? "configured"
        : "not configured"
    }`
  );

  console.log(
    "State: PostgreSQL-backed Gemini interaction sessions"
  );

  console.log(
    "Streaming: enabled"
  );

  console.log(
    "=================================================="
  );

  // ----------------------------------------------------------
  // Database
  // ----------------------------------------------------------

  if (pool) {
    try {
      await initializeDatabase();

      console.log(
        "[DB] PostgreSQL ready."
      );

      console.log(
        "[DB] Memory table ready."
      );

      console.log(
        "[DB] Session table ready."
      );
    } catch (error) {
      console.error(
        "[DB] Initialization failed:",
        error?.message ||
          error
      );
    }
  }

  // ----------------------------------------------------------
  // Server
  // ----------------------------------------------------------

  app.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        "=================================================="
      );

      console.log(
        `GOCK IS LIVE ON PORT ${PORT}`
      );

      console.log(
        "=================================================="
      );
    }
  );
}

startServer();
