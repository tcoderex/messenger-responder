// ---------------------------------------------------------------------------
// Vercel serverless function config – allow up to 60 s for browser emulation
// ---------------------------------------------------------------------------
export const maxDuration = 60;

import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Lightweight promisify helpers for the callback-based fca-unofficial API
// ---------------------------------------------------------------------------

function login(credentials: {
  email: string;
  password: string;
}): Promise<any> {
  return new Promise((resolve, reject) => {
    // -------------------------------------------------------------------------
    // MOCK: Prevent `@dongdev/fca-unofficial` from loading `sqlite3` or
    // initializing a real Sequelize sqlite database on serverless Vercel.
    // -------------------------------------------------------------------------
    try {
      const path = require("path");
      const { createRequire } = require("module");
      const req = typeof require !== "undefined" ? require : createRequire(process.cwd());

      const fcaPath = req.resolve("@dongdev/fca-unofficial");
      const modelsDir = path.join(path.dirname(fcaPath), "lib", "database", "models");
      const modelsIndex = path.join(modelsDir, "index.js");

      const mockModels = {
        sequelize: {
          authenticate: async () => {},
          define: () => ({
            findOne: async () => null,
            create: async () => ({ get: () => ({}) }),
            update: async () => ({ get: () => ({}) }),
            destroy: async () => 0,
            findAll: async () => [],
          }),
          Transaction: {
            ISOLATION_LEVELS: {
              READ_COMMITTED: "READ_COMMITTED"
            }
          }
        },
        syncAll: async () => {},
        Thread: {
          findOne: async () => null,
          create: async () => ({ get: () => ({}) }),
          update: async () => ({ get: () => ({}) }),
          destroy: async () => 0,
          findAll: async () => [],
        }
      };

      req.cache[modelsDir] = {
        id: modelsDir,
        filename: modelsDir,
        loaded: true,
        exports: mockModels
      } as any;

      req.cache[modelsIndex] = {
        id: modelsIndex,
        filename: modelsIndex,
        loaded: true,
        exports: mockModels
      } as any;
    } catch (e) {
      console.error("Failed to inject require cache mock for fca-unofficial models:", e);
    }

    // FIX: Vercel serverless functions have a read-only filesystem except for
    // /tmp. The @dongdev/fca-unofficial library calls
    //   path.join(process.cwd(), "Fca_Database")
    // at require-time and tries to mkdir there. We temporarily override
    // process.cwd to /tmp so that write succeeds.
    const originalCwd = process.cwd;
    process.cwd = () => "/tmp";
    try {
      const loginFn = require("@dongdev/fca-unofficial");
      loginFn(credentials, (err: unknown, api: any) => {
        if (err) reject(err);
        else resolve(api);
      });
    } finally {
      process.cwd = originalCwd;
    }
  });
}

function getCurrentUserId(api: any): Promise<string> {
  // api.getCurrentUserID is the canonical method; fall back to api.uid if it
  // doesn't exist (some forks expose it as a property instead).
  if (typeof api.getCurrentUserID === "function") {
    return new Promise((resolve, reject) => {
      api.getCurrentUserID((err: unknown, id: string) => {
        if (err) reject(err);
        else resolve(String(id));
      });
    });
  }
  return Promise.resolve(String(api.uid ?? "0"));
}

function getThreadList(api: any, limit: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    api.getThreadList(limit, null, ["INBOX"], (err: unknown, list: any[]) => {
      if (err) reject(err);
      else resolve(list ?? []);
    });
  });
}

function sendMessage(
  api: any,
  message: string,
  threadID: string,
): Promise<any> {
  return new Promise((resolve, reject) => {
    api.sendMessage(message, threadID, (err: unknown, info: any) => {
      if (err) reject(err);
      else resolve(info);
    });
  });
}

// ---------------------------------------------------------------------------
// Helper – extract the latest message body and sender ID from a thread object
// ---------------------------------------------------------------------------

function extractLatestMessage(
  thread: any,
): { body: string; senderID: string | null } {
  // Common shapes across fca-unofficial forks:
  //   1. thread.lastMessage.body / .senderID
  //   2. thread.snippet (plain text of latest message)
  const lm = thread.lastMessage ?? {};
  const body: string =
    lm.body ?? thread.snippet ?? thread.snippetText ?? "";
  const senderID: string | null =
    lm.senderID ?? lm.senderId ?? null;
  return { body: String(body), senderID };
}

// ---------------------------------------------------------------------------
// GET /api/respond
// ---------------------------------------------------------------------------

export async function GET() {
  const appStateStr = process.env.FB_APP_STATE;
  const email = process.env.FB_EMAIL;
  const password = process.env.FB_PASSWORD;

  if (!appStateStr && (!email || !password)) {
    return NextResponse.json(
      {
        error:
          "Missing credentials. Set FB_APP_STATE or (FB_EMAIL and FB_PASSWORD) in environment variables.",
      },
      { status: 500 },
    );
  }

  try {
    // 1. Login
    let credentials: any;
    if (appStateStr) {
      try {
        let cleanState = appStateStr.trim();
        if (
          (cleanState.startsWith("'") && cleanState.endsWith("'")) ||
          (cleanState.startsWith('"') && cleanState.endsWith('"'))
        ) {
          cleanState = cleanState.slice(1, -1);
        }
        credentials = { appState: JSON.parse(cleanState) };
      } catch (parseErr) {
        return NextResponse.json(
          {
            error: "Failed to parse FB_APP_STATE environment variable as JSON.",
          },
          { status: 500 },
        );
      }
    } else {
      credentials = { email, password };
    }
    const api = await login(credentials);

    // 2. Determine current user's ID
    const myUserId = await getCurrentUserId(api);

    // 3. Fetch recent inbox threads
    const threads = await getThreadList(api, 15);

    let evaluatedCount = 0;
    const replies: Array<{ threadID: string; threadName: string }> = [];

    for (const thread of threads) {
      const { body, senderID } = extractLatestMessage(thread);
      evaluatedCount++;

      // Only act if:
      //   - a sender is present (not a system message)
      //   - the sender is NOT the logged-in user
      //   - the message body (trimmed, lowercased) equals "hi"
      if (
        senderID &&
        String(senderID) !== String(myUserId) &&
        body.trim().toLowerCase() === "hi"
      ) {
        await sendMessage(api, "hello", thread.threadID);
        replies.push({
          threadID: thread.threadID,
          threadName: thread.name || thread.threadID,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      evaluatedThreads: evaluatedCount,
      autoRepliesSent: replies.length,
      replies,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown error during execution";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
