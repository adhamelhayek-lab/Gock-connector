// ============================================================
// GOCK SERVER
// Server V4.0.0
//
// Includes:
// - Gock Core
// - Gemini Interactions API
// - PostgreSQL persistent memory
// - Stateful browser sessions
// - Streaming responses
// - Jev Connector integration
// - Jev market evaluation
// - Jev trade evaluation
// - Jev shared-memory access
//
// SAFETY
// - Gock never receives Jev private keys
// - Gock never executes trades
// - Jev remains paper/evaluation only
// - Jev API key stays server-side
// ============================================================

import express from "express";
import cors from "cors";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

import {
  buildGockSystemInstruction,
} from "./gock-core.js";

const { Pool } = pg;


// ============================================================
// PATHS
// ============================================================

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);


// ============================================================
// CONFIGURATION
// ============================================================

const app = express();

const PORT =
  Number(process.env.PORT) || 3000;

const NODE_ENV =
  process.env.NODE_ENV || "development";


// ============================================================
// GEMINI
// ============================================================

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "";

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.6-flash";

const GEMINI_THINKING_LEVEL =
  process.env.GEMINI_THINKING_LEVEL ||
  "medium";

const GEMINI_MAX_OUTPUT_TOKENS =
  Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) ||
  null;

const GEMINI_API_BASE =
  process.env.GEMINI_API_BASE ||
  "https://generativelanguage.googleapis.com/v1beta";

const GEMINI_INTERACTIONS_URL =
  `${GEMINI_API_BASE}/interactions`;


// ============================================================
// JEV CONNECTOR
// ============================================================

const JEV_CONNECTOR_URL =
  (
    process.env.JEV_CONNECTOR_URL ||
    "https://jev-connector.onrender.com"
  ).replace(/\/+$/, "");

const JEV_API_KEY =
  process.env.JEV_API_KEY || "";

const JEV_TIMEOUT_MS =
  Number(process.env.JEV_TIMEOUT_MS) ||
  30000;


// ============================================================
// DATABASE
// ============================================================

const DATABASE_URL =
  process.env.DATABASE_URL || "";

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
      NODE_ENV === "production"
        ? {
            rejectUnauthorized:
              false,
          }
        : false,
  });

}


// ============================================================
// LIMITS
// ============================================================

const MAX_MESSAGE_LENGTH =
  20000;

const MAX_MEMORY_LENGTH =
  2000;

const MAX_HISTORY_MESSAGES =
  40;

const MAX_MEMORIES =
  12;

const GEMINI_TIMEOUT =
  Number(process.env.GEMINI_TIMEOUT_MS) ||
  60000;

const MAX_RETRIES =
  2;


// ============================================================
// SESSION COOKIE
// ============================================================

const SESSION_COOKIE =
  "gock_session";

const SESSION_MAX_AGE =
  7 * 24 * 60 * 60 * 1000;


// ============================================================
// EXPRESS
// ============================================================

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
    strict: true,
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "1mb",
  })
);


// ============================================================
// REQUEST ID
// ============================================================

app.use((req, res, next) => {

  const incoming =
    req.headers["x-request-id"];

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

});


// ============================================================
// LOCAL RATE LIMITER
// ============================================================

const RATE_WINDOW =
  60 * 1000;

const RATE_LIMIT =
  30;

const rateStore =
  new Map();


function getClientAddress(req) {

  const forwarded =
    req.headers["x-forwarded-for"];

  if (
    typeof forwarded === "string"
  ) {

    return forwarded
      .split(",")[0]
      .trim();

  }

  return (
    req.socket?.remoteAddress ||
    "unknown"
  );

}


function rateLimit(req, res, next) {

  const now =
    Date.now();

  const key =
    `${getClientAddress(req)}:${getSessionId(req) || "none"}`;

  let record =
    rateStore.get(key);

  if (
    !record ||
    now - record.startedAt >
      RATE_WINDOW
  ) {

    record = {
      startedAt: now,
      count: 0,
    };

    rateStore.set(
      key,
      record
    );

  }

  record.count++;

  if (
    record.count >
    RATE_LIMIT
  ) {

    return res.status(429).json({

      ok: false,

      error:
        "Rate limit exceeded",

      requestId:
        req.requestId,

    });

  }

  next();

}


app.use(rateLimit);


setInterval(() => {

  const now =
    Date.now();

  for (
    const [key, record]
    of rateStore
  ) {

    if (
      now - record.startedAt >
      RATE_WINDOW
    ) {

      rateStore.delete(key);

    }

  }

}, RATE_WINDOW).unref();


// ============================================================
// COOKIE HELPERS
// ============================================================

function parseCookies(req) {

  const header =
    req.headers.cookie || "";

  const cookies = {};

  for (
    const part of header.split(";")
  ) {

    const index =
      part.indexOf("=");

    if (index === -1) {
      continue;
    }

    const name =
      part
        .slice(0, index)
        .trim();

    const value =
      part
        .slice(index + 1)
        .trim();

    if (name) {
      cookies[name] =
        decodeURIComponent(value);
    }

  }

  return cookies;

}


function getSessionId(req) {

  const cookies =
    parseCookies(req);

  return cookies[
    SESSION_COOKIE
  ] || null;

}


function generateSessionId() {

  return crypto.randomBytes(32)
    .toString("hex");

}


function setSessionCookie(
  res,
  sessionId
) {

  const secure =
    NODE_ENV === "production"
      ? "; Secure"
      : "";

  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
      SESSION_MAX_AGE / 1000
    )}${secure}`
  );

}


// ============================================================
// DATABASE INITIALIZATION
// ============================================================

async function initializeDatabase() {

  if (!pool) {
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gock_memories (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL DEFAULT 'general',
      memory TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_gock_memories_importance_updated
    ON gock_memories
    (importance DESC, updated_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gock_sessions (
      session_id TEXT PRIMARY KEY,
      interaction_id TEXT,
      model TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_gock_sessions_updated
    ON gock_sessions
    (updated_at DESC)
  `);

}


// ============================================================
// SESSION STATE
// ============================================================

const memorySessions =
  new Map();

const sessionLocks =
  new Map();


async function getOrCreateSession(
  req,
  res
) {

  let sessionId =
    getSessionId(req);

  if (!sessionId) {

    sessionId =
      generateSessionId();

    setSessionCookie(
      res,
      sessionId
    );

  }

  if (!pool) {

    if (!memorySessions.has(sessionId)) {

      memorySessions.set(
        sessionId,
        {
          interactionId: null,
          model: GEMINI_MODEL,
        }
      );

    }

    return {
      sessionId,
      ...memorySessions.get(
        sessionId
      ),
    };

  }

  const result =
    await pool.query(
      `
      SELECT
        session_id,
        interaction_id,
        model
      FROM gock_sessions
      WHERE session_id = $1
      `,
      [sessionId]
    );

  if (
    result.rows.length === 0
  ) {

    await pool.query(
      `
      INSERT INTO gock_sessions
      (
        session_id,
        model
      )
      VALUES ($1, $2)
      `,
      [
        sessionId,
        GEMINI_MODEL,
      ]
    );

    return {
      sessionId,
      interactionId: null,
      model: GEMINI_MODEL,
    };

  }

  return {
    sessionId,
    interactionId:
      result.rows[0].interaction_id,
    model:
      result.rows[0].model ||
      GEMINI_MODEL,
  };

}


async function saveSessionInteraction(
  sessionId,
  interactionId
) {

  if (!sessionId) {
    return;
  }

  if (!pool) {

    const current =
      memorySessions.get(
        sessionId
      ) || {};

    memorySessions.set(
      sessionId,
      {
        ...current,
        interactionId,
        model:
          GEMINI_MODEL,
      }
    );

    return;
  }

  await pool.query(
    `
    UPDATE gock_sessions
    SET
      interaction_id = $2,
      model = $3,
      updated_at = NOW()
    WHERE session_id = $1
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

  if (!sessionId) {
    return;
  }

  if (!pool) {

    memorySessions.set(
      sessionId,
      {
        interactionId: null,
        model: GEMINI_MODEL,
      }
    );

    return;
  }

  await pool.query(
    `
    UPDATE gock_sessions
    SET
      interaction_id = NULL,
      model = $2,
      updated_at = NOW()
    WHERE session_id = $1
    `,
    [
      sessionId,
      GEMINI_MODEL,
    ]
  );

}


async function withSessionLock(
  sessionId,
  task
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
    previous.then(
      () => current
    )
  );

  try {

    await previous;

    return await task();

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
// GOCK MEMORY
// ============================================================

async function getMemories(
  limit = MAX_MEMORIES
) {

  const safeLimit =
    Math.max(
      1,
      Math.min(
        MAX_MEMORIES,
        Number(limit) || MAX_MEMORIES
      )
    );

  if (!pool) {
    return [];
  }

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

    return {
      saved: false,
      reason: "database-unavailable",
    };

  }

  const cleanMemory =
    String(memory || "")
      .replace(/\0/g, "")
      .trim()
      .slice(
        0,
        MAX_MEMORY_LENGTH
      );

  if (!cleanMemory) {

    return {
      saved: false,
      reason: "empty",
    };

  }

  const cleanCategory =
    String(category || "general")
      .replace(/\0/g, "")
      .trim()
      .slice(0, 100) ||
    "general";

  const cleanImportance =
    Math.max(
      1,
      Math.min(
        5,
        Math.floor(
          Number(importance) || 3
        )
      )
    );

  const existing =
    await pool.query(
      `
      SELECT id
      FROM gock_memories
      WHERE LOWER(memory) = LOWER($1)
      LIMIT 1
      `,
      [cleanMemory]
    );

  if (
    existing.rows.length > 0
  ) {

    await pool.query(
      `
      UPDATE gock_memories
      SET
        category = $2,
        importance = $3,
        updated_at = NOW()
      WHERE id = $1
      `,
      [
        existing.rows[0].id,
        cleanCategory,
        cleanImportance,
      ]
    );

    return {
      saved: true,
      updated: true,
      memory: cleanMemory,
    };

  }

  await pool.query(
    `
    INSERT INTO gock_memories
    (
      category,
      memory,
      importance
    )
    VALUES ($1, $2, $3)
    `,
    [
      cleanCategory,
      cleanMemory,
      cleanImportance,
    ]
  );

  return {
    saved: true,
    updated: false,
    memory: cleanMemory,
  };

}


async function getRelevantMemories(
  message
) {

  if (!pool) {
    return [];
  }

  const words =
    String(message || "")
      .toLowerCase()
      .replace(
        /[^a-zA-Z0-9_]+/g,
        " "
      )
      .split(/\s+/)
      .filter(
        (word) =>
          word.length >= 4
      )
      .slice(0, 12);

  if (words.length === 0) {

    return getMemories(
      MAX_MEMORIES
    );

  }

  const conditions =
    words
      .map(
        (_, index) =>
          `memory ILIKE $${index + 1}`
      )
      .join(" OR ");

  const values =
    words.map(
      (word) => `%${word}%`
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
      WHERE ${conditions}
      ORDER BY
        importance DESC,
        updated_at DESC
      LIMIT ${MAX_MEMORIES}
      `,
      values
    );

  if (result.rows.length > 0) {
    return result.rows;
  }

  return getMemories(
    MAX_MEMORIES
  );

}


// ============================================================
// MESSAGE NORMALIZATION
// ============================================================

function normalizeString(
  value,
  maxLength
) {

  return String(value ?? "")
    .replace(/\0/g, "")
    .trim()
    .slice(0, maxLength);

}


function normalizeHistory(
  history
) {

  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .slice(-MAX_HISTORY_MESSAGES)
    .filter(
      (item) =>
        item &&
        typeof item === "object"
    )
    .map((item) => ({
      role:
        normalizeString(
          item.role,
          30
        ),
      content:
        normalizeString(
          item.content,
          MAX_MESSAGE_LENGTH
        ),
    }))
    .filter(
      (item) =>
        item.content
    );

}


// ============================================================
// EXPLICIT MEMORY
// ============================================================

function extractExplicitMemory(
  message
) {

  const text =
    String(message || "")
      .trim();

  const patterns = [
    /^remember that\s+(.+)$/i,
    /^remember\s+(.+)$/i,
    /^save this:\s*(.+)$/i,
    /^save this\s+(.+)$/i,
    /^keep this in memory:\s*(.+)$/i,
    /^keep this in memory\s+(.+)$/i,
  ];

  for (
    const pattern of patterns
  ) {

    const match =
      text.match(pattern);

    if (match?.[1]) {

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
// GOCK CONTEXT
// ============================================================

async function buildGockContext(
  message,
  suppliedContext = {}
) {

  const relevantMemories =
    await getRelevantMemories(
      message
    );

  return {

    ...(
      suppliedContext &&
      typeof suppliedContext === "object" &&
      !Array.isArray(suppliedContext)
        ? suppliedContext
        : {}
    ),

    persistentMemories:
      relevantMemories,

  };

}


// ============================================================
// GEMINI ERROR
// ============================================================

class GeminiError extends Error {

  constructor(
    message,
    status = 500,
    code = null,
    data = null
  ) {

    super(message);

    this.name =
      "GeminiError";

    this.status =
      status;

    this.code =
      code;

    this.data =
      data;

  }

}


// ============================================================
// GEMINI RETRY
// ============================================================

function isRetryableGeminiError(
  error
) {

  return [
    429,
    500,
    502,
    503,
    504,
  ].includes(
    error?.status
  );

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
// GEMINI REQUEST
// ============================================================

async function callGemini(
  body,
  {
    stream = false,
    requestId = null,
  } = {}
) {

  if (!GEMINI_API_KEY) {

    throw new GeminiError(
      "Gemini API key is not configured",
      503,
      "MISSING_API_KEY"
    );

  }

  let lastError = null;

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
        GEMINI_TIMEOUT
      );

    try {

      const response =
        await fetch(
          GEMINI_INTERACTIONS_URL,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",

              "x-goog-api-key":
                GEMINI_API_KEY,

              Accept:
                stream
                  ? "text/event-stream"
                  : "application/json",

              ...(requestId
                ? {
                    "X-Request-ID":
                      requestId,
                  }
                : {}),
            },

            body:
              JSON.stringify(body),

            signal:
              controller.signal,
          }
        );

      if (!response.ok) {

        const text =
          await response.text();

        let data = null;

        try {
          data =
            JSON.parse(text);
        } catch {
          data = {
            raw: text.slice(
              0,
              2000
            ),
          };
        }

        const error =
          new GeminiError(
            data?.error?.message ||
              `Gemini request failed (${response.status})`,
            response.status,
            data?.error?.status ||
              null,
            data
          );

        if (
          isRetryableGeminiError(
            error
          ) &&
          attempt < MAX_RETRIES
        ) {

          lastError =
            error;

          await sleep(
            500 *
              Math.pow(
                2,
                attempt
              )
          );

          continue;

        }

        throw error;

      }

      if (stream) {

        return response;

      }

      const data =
        await response.json();

      if (
        data?.status ===
        "failed"
      ) {

        throw new GeminiError(
          "Gemini interaction failed",
          502,
          "INTERACTION_FAILED",
          data
        );

      }

      return data;

    } catch (error) {

      if (
        error?.name ===
        "AbortError"
      ) {

        throw new GeminiError(
          "Gemini request timed out",
          504,
          "TIMEOUT"
        );

      }

      if (
        error instanceof GeminiError
      ) {

        lastError =
          error;

        if (
          isRetryableGeminiError(
            error
          ) &&
          attempt < MAX_RETRIES
        ) {

          await sleep(
            500 *
              Math.pow(
                2,
                attempt
              )
          );

          continue;

        }

        throw error;

      }

      throw new GeminiError(
        error?.message ||
          "Gemini request failed",
        502,
        "NETWORK_ERROR"
      );

    } finally {

      clearTimeout(
        timeout
      );

    }

  }

  throw (
    lastError ||
    new GeminiError(
      "Gemini request failed",
      502
    )
  );

}


// ============================================================
// GEMINI TEXT EXTRACTION
// ============================================================

function extractGeminiText(
  data
) {

  if (
    typeof data?.output_text ===
    "string"
  ) {

    return data.output_text;

  }

  if (
    Array.isArray(
      data?.output
    )
  ) {

    const parts = [];

    for (
      const step of data.output
    ) {

      if (
        typeof step?.text ===
        "string"
      ) {

        parts.push(
          step.text
        );

      }

      if (
        Array.isArray(
          step?.content
        )
      ) {

        for (
          const item of
            step.content
        ) {

          if (
            typeof item?.text ===
            "string"
          ) {

            parts.push(
              item.text
            );

          }

        }

      }

    }

    if (parts.length > 0) {
      return parts.join("");
    }

  }

  return "";

}


// ============================================================
// GEMINI GENERATION CONFIG
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
    GEMINI_MAX_OUTPUT_TOKENS > 0
  ) {

    config.max_output_tokens =
      GEMINI_MAX_OUTPUT_TOKENS;

  }

  return config;

}


// ============================================================
// GEMINI BODY
// ============================================================

function buildGeminiBody({
  message,
  context,
  previousInteractionId,
}) {

  const systemInstruction =
    buildGockSystemInstruction(
      context
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

    store:
      true,

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
// GENERATE GOCK RESPONSE
// ============================================================

async function generateGockResponse({
  message,
  context,
  session,
  requestId,
}) {

  let previousInteractionId =
    session.interactionId;

  let reset =
    false;

  try {

    const body =
      buildGeminiBody({
        message,
        context,
        previousInteractionId,
      });

    const data =
      await callGemini(
        body,
        {
          stream: false,
          requestId,
        }
      );

    const text =
      extractGeminiText(
        data
      );

    if (!text) {

      throw new GeminiError(
        "Gemini returned no text",
        502,
        "EMPTY_RESPONSE",
        data
      );

    }

    const interactionId =
      data?.id ||
      data?.interaction_id ||
      null;

    if (interactionId) {

      await saveSessionInteraction(
        session.sessionId,
        interactionId
      );

    }

    return {
      text,
      interactionId,
      reset,
      data,
    };

  } catch (error) {

    const shouldReset =
      previousInteractionId &&
      error?.status === 404;

    if (!shouldReset) {
      throw error;
    }

    await resetSession(
      session.sessionId
    );

    reset = true;

    const body =
      buildGeminiBody({
        message,
        context,
        previousInteractionId:
          null,
      });

    const data =
      await callGemini(
        body,
        {
          stream: false,
          requestId,
        }
      );

    const text =
      extractGeminiText(
        data
      );

    if (!text) {

      throw new GeminiError(
        "Gemini returned no text",
        502,
        "EMPTY_RESPONSE",
        data
      );

    }

    const interactionId =
      data?.id ||
      data?.interaction_id ||
      null;

    if (interactionId) {

      await saveSessionInteraction(
        session.sessionId,
        interactionId
      );

    }

    return {
      text,
      interactionId,
      reset,
      data,
    };

  }

}


// ============================================================
// JEV HELPERS
// ============================================================

function buildJevHeaders() {

  const headers = {

    "Content-Type":
      "application/json",

    Accept:
      "application/json",

  };

  if (JEV_API_KEY) {

    headers[
      "X-JEV-API-Key"
    ] =
      JEV_API_KEY;

  }

  return headers;

}


async function callJev(
  endpoint,
  {
    method = "GET",
    body = undefined,
    requestId = null,
  } = {}
) {

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      JEV_TIMEOUT_MS
    );

  try {

    const response =
      await fetch(
        `${JEV_CONNECTOR_URL}${endpoint}`,
        {
          method,

          headers: {
            ...buildJevHeaders(),

            ...(requestId
              ? {
                  "X-Request-ID":
                    requestId,
                }
              : {}),
          },

          ...(body !== undefined
            ? {
                body:
                  JSON.stringify(body),
              }
            : {}),

          signal:
            controller.signal,
        }
      );

    const text =
      await response.text();

    let data = null;

    try {

      data =
        text
          ? JSON.parse(text)
          : null;

    } catch {

      data = {
        ok: false,
        error:
          "Invalid response from Jev",
      };

    }

    if (!response.ok) {

      const error =
        new Error(
          data?.error ||
            `Jev request failed (${response.status})`
        );

      error.status =
        response.status;

      error.data =
        data;

      throw error;

    }

    return data;

  } catch (error) {

    if (
      error?.name ===
      "AbortError"
    ) {

      const timeoutError =
        new Error(
          "Jev request timed out"
        );

      timeoutError.status =
        504;

      throw timeoutError;

    }

    throw error;

  } finally {

    clearTimeout(
      timeout
    );

  }

}


// ============================================================
// JEV HEALTH
// ============================================================

async function getJevHealth(
  requestId
) {

  return callJev(
    "/health",
    {
      method: "GET",
      requestId,
    }
  );

}


// ============================================================
// JEV MARKET EVALUATION
// ============================================================

async function evaluateWithJev(
  marketData,
  requestId
) {

  return callJev(
    "/api/evaluate-market",
    {
      method: "POST",

      body: {
        marketData,
      },

      requestId,
    }
  );

}


// ============================================================
// JEV TRADE EVALUATION
// ============================================================

async function evaluateTradeWithJev(
  state,
  options,
  requestId
) {

  return callJev(
    "/api/evaluate-trade",
    {
      method: "POST",

      body: {
        state,
        options,
      },

      requestId,
    }
  );

}


// ============================================================
// JEV MEMORY CONTEXT
// ============================================================

async function getJevMemoryContext(
  input,
  requestId
) {

  return callJev(
    "/api/memory/context",
    {
      method: "POST",

      body: {
        input,
      },

      requestId,
    }
  );

}


// ============================================================
// JEV MEMORY SEARCH
// ============================================================

async function searchJevMemory(
  query,
  requestId
) {

  return callJev(
    "/api/memory/search",
    {
      method: "POST",

      body: {
        query,
      },

      requestId,
    }
  );

}


// ============================================================
// JEV MEMORY SAVE
// ============================================================

async function saveJevMemory(
  memory,
  requestId
) {

  return callJev(
    "/api/memory",
    {
      method: "POST",

      body: memory,

      requestId,
    }
  );

}


// ============================================================
// JEV STATUS
// ============================================================

app.get(
  "/api/jev/status",
  async (req, res) => {

    try {

      const health =
        await getJevHealth(
          req.requestId
        );

      return res.status(200).json({

        ok: true,

        connected: true,

        connector:
          JEV_CONNECTOR_URL,

        health,

        requestId:
          req.requestId,

      });

    } catch (error) {

      return res.status(200).json({

        ok: false,

        connected: false,

        connector:
          JEV_CONNECTOR_URL,

        error:
          "Jev connector unavailable",

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// JEV MARKET EVALUATION
// ============================================================

app.post(
  "/api/jev/evaluate-market",
  async (req, res) => {

    try {

      const marketData =
        req.body?.marketData ??
        req.body;

      if (
        !marketData ||
        typeof marketData !== "object" ||
        Array.isArray(marketData)
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Invalid market data",

          requestId:
            req.requestId,

        });

      }

      const result =
        await evaluateWithJev(
          marketData,
          req.requestId
        );

      return res.status(200).json({

        ok: true,

        service:
          "Gock",

        operation:
          "jev-market-evaluation",

        jev:
          result,

        executed:
          false,

        requestId:
          req.requestId,

      });

    } catch (error) {

      console.error(
        "[GOCK] Jev market evaluation:",
        error.message
      );

      return res.status(
        error?.status || 502
      ).json({

        ok: false,

        error:
          "Jev market evaluation failed",

        executed:
          false,

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// JEV TRADE EVALUATION
// ============================================================

app.post(
  "/api/jev/evaluate-trade",
  async (req, res) => {

    try {

      const state =
        req.body?.state ??
        req.body;

      const options =
        req.body?.options ??
        {};

      if (
        !state ||
        typeof state !== "object" ||
        Array.isArray(state)
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Invalid trader state",

          requestId:
            req.requestId,

        });

      }

      const result =
        await evaluateTradeWithJev(
          state,
          options,
          req.requestId
        );

      return res.status(200).json({

        ok: true,

        service:
          "Gock",

        operation:
          "jev-trade-evaluation",

        jev:
          result,

        executed:
          false,

        requestId:
          req.requestId,

      });

    } catch (error) {

      console.error(
        "[GOCK] Jev trade evaluation:",
        error.message
      );

      return res.status(
        error?.status || 502
      ).json({

        ok: false,

        error:
          "Jev trade evaluation failed",

        executed:
          false,

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// JEV MEMORY CONTEXT
// ============================================================

app.post(
  "/api/jev/memory/context",
  async (req, res) => {

    try {

      const input =
        req.body?.input ??
        req.body?.query ??
        "";

      if (
        typeof input !== "string" ||
        !input.trim()
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Memory context input is required",

          requestId:
            req.requestId,

        });

      }

      const result =
        await getJevMemoryContext(
          input.trim(),
          req.requestId
        );

      return res.status(200).json({

        ok: true,

        jev:
          result,

        requestId:
          req.requestId,

      });

    } catch (error) {

      console.error(
        "[GOCK] Jev memory context:",
        error.message
      );

      return res.status(
        error?.status || 502
      ).json({

        ok: false,

        error:
          "Jev memory context failed",

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// JEV MEMORY SEARCH
// ============================================================

app.post(
  "/api/jev/memory/search",
  async (req, res) => {

    try {

      const query =
        typeof req.body?.query === "string"
          ? req.body.query.trim()
          : "";

      if (!query) {

        return res.status(400).json({

          ok: false,

          error:
            "Search query is required",

          requestId:
            req.requestId,

        });

      }

      if (query.length > 500) {

        return res.status(400).json({

          ok: false,

          error:
            "Search query is too long",

          requestId:
            req.requestId,

        });

      }

      const result =
        await searchJevMemory(
          query,
          req.requestId
        );

      return res.status(200).json({

        ok: true,

        jev:
          result,

        requestId:
          req.requestId,

      });

    } catch (error) {

      console.error(
        "[GOCK] Jev memory search:",
        error.message
      );

      return res.status(
        error?.status || 502
      ).json({

        ok: false,

        error:
          "Jev memory search failed",

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// JEV MEMORY SAVE
// ============================================================

app.post(
  "/api/jev/memory",
  async (req, res) => {

    try {

      if (
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body)
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Memory object is required",

          requestId:
            req.requestId,

        });

      }

      const result =
        await saveJevMemory(
          req.body,
          req.requestId
        );

      return res.status(200).json({

        ok: true,

        jev:
          result,

        requestId:
          req.requestId,

      });

    } catch (error) {

      console.error(
        "[GOCK] Jev memory save:",
        error.message
      );

      return res.status(
        error?.status || 502
      ).json({

        ok: false,

        error:
          "Jev memory save failed",

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// GOCK CONTEXT ENDPOINT
// ============================================================

app.get(
  "/api/context",
  async (req, res) => {

    try {

      const memories =
        await getMemories(
          MAX_MEMORIES
        );

      return res.status(200).json({

        ok: true,

        name:
          "Gock",

        model:
          GEMINI_MODEL,

        engine:
          "Gemini Interactions API",

        persistentMemories:
          memories,

        jev: {

          connected:
            Boolean(
              JEV_CONNECTOR_URL
            ),

          evaluation:
            true,

          execution:
            false,

        },

        requestId:
          req.requestId,

      });

    } catch (error) {

      return res.status(500).json({

        ok: false,

        error:
          "Could not build context",

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// GOCK MEMORY ENDPOINTS
// ============================================================

app.get(
  "/api/memories",
  async (req, res) => {

    try {

      const limit =
        Math.max(
          1,
          Math.min(
            100,
            Number(req.query.limit) || 20
          )
        );

      const memories =
        await getMemories(
          limit
        );

      return res.status(200).json({

        ok: true,

        memories,

        requestId:
          req.requestId,

      });

    } catch (error) {

      return res.status(500).json({

        ok: false,

        error:
          "Could not retrieve memories",

        requestId:
          req.requestId,

      });

    }

  }
);


app.post(
  "/api/memory",
  async (req, res) => {

    try {

      const memory =
        req.body?.memory;

      const category =
        req.body?.category ||
        "general";

      const importance =
        req.body?.importance ||
        3;

      if (
        typeof memory !== "string" ||
        !memory.trim()
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Memory is required",

          requestId:
            req.requestId,

        });

      }

      const result =
        await saveMemory(
          memory,
          category,
          importance
        );

      return res.status(200).json({

        ok: true,

        result,

        requestId:
          req.requestId,

      });

    } catch (error) {

      return res.status(500).json({

        ok: false,

        error:
          "Could not save memory",

        requestId:
          req.requestId,

      });

    }

  }
);


app.post(
  "/api/conversation/reset",
  async (req, res) => {

    try {

      const session =
        await getOrCreateSession(
          req,
          res
        );

      await resetSession(
        session.sessionId
      );

      return res.status(200).json({

        ok: true,

        reset:
          true,

        requestId:
          req.requestId,

      });

    } catch (error) {

      return res.status(500).json({

        ok: false,

        error:
          "Could not reset conversation",

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// MAIN GOCK MESSAGE
// ============================================================

app.post(
  "/api/message",
  async (req, res) => {

    const message =
      normalizeString(
        req.body?.message,
        MAX_MESSAGE_LENGTH
      );

    if (!message) {

      return res.status(400).json({

        ok: false,

        error:
          "Message is required",

        requestId:
          req.requestId,

      });

    }

    try {

      const session =
        await getOrCreateSession(
          req,
          res
        );

      return await withSessionLock(
        session.sessionId,
        async () => {

          const explicitMemory =
            extractExplicitMemory(
              message
            );

          let memoryResult =
            null;

          if (explicitMemory) {

            memoryResult =
              await saveMemory(
                explicitMemory
              );

          }

          const context =
            await buildGockContext(
              message,
              req.body?.context
            );

          const result =
            await generateGockResponse({
              message,
              context,
              session,
              requestId:
                req.requestId,
            });

          return res.status(200).json({

            ok: true,

            reply:
              result.text,

            model:
              GEMINI_MODEL,

            engine:
              "Gemini Interactions API",

            interactionId:
              result.interactionId,

            stateful:
              true,

            conversationReset:
              result.reset,

            memory:
              memoryResult,

            jev: {

              available:
                true,

              evaluation:
                true,

              execution:
                false,

            },

            requestId:
              req.requestId,

          });

        }
      );

    } catch (error) {

      console.error(
        "[GOCK] Message error:",
        error.message
      );

      if (
        error?.code ===
        "MISSING_API_KEY"
      ) {

        return res.status(503).json({

          ok: false,

          error:
            "Gemini API is not configured",

          requestId:
            req.requestId,

        });

      }

      if (
        error?.code ===
        "TIMEOUT"
      ) {

        return res.status(504).json({

          ok: false,

          error:
            "AI request timed out",

          requestId:
            req.requestId,

        });

      }

      if (
        error?.status === 429
      ) {

        return res.status(429).json({

          ok: false,

          error:
            "AI service rate limit reached",

          requestId:
            req.requestId,

        });

      }

      return res.status(
        error?.status || 500
      ).json({

        ok: false,

        error:
          "Gock could not generate a response",

        requestId:
          req.requestId,

      });

    }

  }
);


// ============================================================
// STREAMING
// ============================================================

app.post(
  "/api/message/stream",
  async (req, res) => {

    const message =
      normalizeString(
        req.body?.message,
        MAX_MESSAGE_LENGTH
      );

    if (!message) {

      return res.status(400).json({

        ok: false,

        error:
          "Message is required",

        requestId:
          req.requestId,

      });

    }

    let session;

    try {

      session =
        await getOrCreateSession(
          req,
          res
        );

    } catch {

      return res.status(500).json({

        ok: false,

        error:
          "Could not create session",

        requestId:
          req.requestId,

      });

    }

    await withSessionLock(
      session.sessionId,
      async () => {

        try {

          const explicitMemory =
            extractExplicitMemory(
              message
            );

          if (explicitMemory) {

            await saveMemory(
              explicitMemory
            );

          }

          const context =
            await buildGockContext(
              message,
              req.body?.context
            );

          let previousInteractionId =
            session.interactionId;

          let response;

          try {

            response =
              await callGemini(
                buildGeminiBody({
                  message,
                  context,
                  previousInteractionId,
                }),
                {
                  stream: true,
                  requestId:
                    req.requestId,
                }
              );

          } catch (error) {

            if (
              previousInteractionId &&
              error?.status === 404
            ) {

              await resetSession(
                session.sessionId
              );

              previousInteractionId =
                null;

              response =
                await callGemini(
                  buildGeminiBody({
                    message,
                    context,
                    previousInteractionId,
                  }),
                  {
                    stream: true,
                    requestId:
                      req.requestId,
                  }
                );

            } else {

              throw error;

            }

          }

          res.status(200);

          res.setHeader(
            "Content-Type",
            "text/event-stream"
          );

          res.setHeader(
            "Cache-Control",
            "no-cache"
          );

          res.setHeader(
            "Connection",
            "keep-alive"
          );

          res.flushHeaders();

          let buffer = "";

          let interactionId =
            null;

          response.body.on(
            "data",
            (chunk) => {

              buffer +=
                chunk.toString(
                  "utf8"
                );

              const events =
                buffer.split(
                  "\n\n"
                );

              buffer =
                events.pop() || "";

              for (
                const event
                of events
              ) {

                const lines =
                  event.split("\n");

                let eventName =
                  "message";

                let dataText =
                  "";

                for (
                  const line
                    of lines
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

                    dataText +=
                      line
                        .slice(5)
                        .trim();

                  }

                }

                if (!dataText) {
                  continue;
                }

                let data;

                try {

                  data =
                    JSON.parse(
                      dataText
                    );

                } catch {

                  continue;

                }

                if (
                  eventName ===
                    "interaction.created" ||
                  eventName ===
                    "interaction.completed"
                ) {

                  interactionId =
                    data?.id ||
                    data?.interaction_id ||
                    interactionId;

                }

                if (
                  eventName ===
                  "step.delta"
                ) {

                  const text =
                    data?.text ||
                    data?.delta?.text ||
                    data?.content?.text ||
                    "";

                  if (text) {

                    res.write(
                      `data: ${JSON.stringify({
                        type: "text",
                        text,
                      })}\n\n`
                    );

                  }

                }

                if (
                  eventName ===
                  "error"
                ) {

                  res.write(
                    `data: ${JSON.stringify({
                      type: "error",
                      error:
                        data?.message ||
                        "Gemini streaming error",
                    })}\n\n`
                  );

                }

              }

            }
          );

          response.body.on(
            "end",
            async () => {

              try {

                if (
                  interactionId
                ) {

                  await saveSessionInteraction(
                    session.sessionId,
                    interactionId
                  );

                }

                res.write(
                  `data: ${JSON.stringify({
                    type: "done",
                    interactionId,
                  })}\n\n`
                );

                res.end();

              } catch {

                res.end();

              }

            }
          );

          response.body.on(
            "error",
            () => {

              if (
                !res.writableEnded
              ) {

                res.end();

              }

            }
          );

        } catch (error) {

          console.error(
            "[GOCK] Stream error:",
            error.message
          );

          if (
            !res.headersSent
          ) {

            return res.status(
              error?.status || 500
            ).json({

              ok: false,

              error:
                "Streaming request failed",

              requestId:
                req.requestId,

            });

          }

          if (
            !res.writableEnded
          ) {

            res.write(
              `data: ${JSON.stringify({
                type: "error",
                error:
                  "Streaming request failed",
              })}\n\n`
            );

            res.end();

          }

        }

      }
    );

  }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  async (req, res) => {

    let database =
      "disconnected";

    if (pool) {

      try {

        await pool.query(
          "SELECT 1"
        );

        database =
          "connected";

      } catch {

        database =
          "error";

      }

    }

    res.status(200).json({

      ok: true,

      name:
        "Gock",

      status:
        "online",

      model:
        GEMINI_MODEL,

      engine:
        "Gemini Interactions API",

      core:
        "connected",

      database,

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

      jev: {

        configured:
          Boolean(
            JEV_CONNECTOR_URL
          ),

        connector:
          JEV_CONNECTOR_URL,

        evaluation:
          true,

        execution:
          false,

      },

      environment:
        NODE_ENV,

      requestId:
        req.requestId,

    });

  }
);


app.get(
  "/api/health",
  async (req, res) => {

    return res.redirect(
      "/health"
    );

  }
);


// ============================================================
// ROOT
// ============================================================

app.get(
  "/",
  (req, res) => {

    res.status(200).json({

      ok: true,

      name:
        "Gock",

      status:
        "online",

      version:
        "4.0.0",

      model:
        GEMINI_MODEL,

      jev: {

        connected:
          Boolean(
            JEV_CONNECTOR_URL
          ),

        evaluation:
          true,

        execution:
          false,

      },

      requestId:
        req.requestId,

    });

  }
);


// ============================================================
// STATIC FRONTEND
// ============================================================

app.use(
  express.static(
    __dirname
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
        "API route not found",

      path:
        req.path,

      requestId:
        req.requestId,

    });

  }
);


// ============================================================
// GLOBAL 404
// ============================================================

app.use(
  (req, res) => {

    res.status(404).json({

      ok: false,

      error:
        "Route not found",

      path:
        req.path,

      requestId:
        req.requestId,

    });

  }
);


// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (error, req, res, next) => {

    console.error(
      "[GOCK] Unhandled error:",
      error.message
    );

    if (
      res.headersSent
    ) {

      return next(error);

    }

    res.status(500).json({

      ok: false,

      error:
        "Internal server error",

      requestId:
        req.requestId,

    });

  }
);


// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

let server = null;


function shutdown(signal) {

  console.log(
    `[GOCK] ${signal} received`
  );

  if (!server) {

    process.exit(0);

  }

  server.close(() => {

    console.log(
      "[GOCK] Server stopped"
    );

    if (pool) {

      pool.end()
        .catch(() => {})
        .finally(() =>
          process.exit(0)
        );

      return;

    }

    process.exit(0);

  });

  setTimeout(() => {

    console.error(
      "[GOCK] Forced shutdown"
    );

    process.exit(1);

  }, 10000).unref();

}


process.on(
  "SIGTERM",
  () =>
    shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () =>
    shutdown("SIGINT")
);


// ============================================================
// STARTUP
// ============================================================

async function start() {

  try {

    await initializeDatabase();

    console.log(
      "[GOCK] Database initialized"
    );

  } catch (error) {

    console.error(
      "[GOCK] Database initialization failed:",
      error.message
    );

  }

  server =
    app.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          "=========================================="
        );

        console.log(
          "GOCK SERVER V4.0.0"
        );

        console.log(
          "Status: ONLINE"
        );

        console.log(
          `Port: ${PORT}`
        );

        console.log(
          `Environment: ${NODE_ENV}`
        );

        console.log(
          `Gemini model: ${GEMINI_MODEL}`
        );

        console.log(
          `Gemini configured: ${Boolean(
            GEMINI_API_KEY
          )}`
        );

        console.log(
          `PostgreSQL: ${Boolean(pool)}`
        );

        console.log(
          `Jev connector: ${JEV_CONNECTOR_URL}`
        );

        console.log(
          `Jev API key configured: ${Boolean(
            JEV_API_KEY
          )}`
        );

        console.log(
          "Jev evaluation: ENABLED"
        );

        console.log(
          "Jev trade execution: DISABLED"
        );

        console.log(
          "=========================================="
        );

      }
    );

}


start();
