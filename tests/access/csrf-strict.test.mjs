/**
 * STRICT backend CSRF enforcement regression tests (FIX 3a).
 *
 * A real Express app on an ephemeral port, driven with fetch, against a real
 * PostgreSQL-backed session. FAILS LOUDLY without PostgreSQL.
 *
 * These lock in the fix for the verified defect where the presented CSRF token was
 * resolved as `req.header(CSRF_HEADER) ?? readCookie(req, csrfName)` — accepting the
 * READABLE CSRF COOKIE as a substitute for the header. A cross-site form POST makes
 * the browser send our cookies automatically, so a cookie fallback silently defeated
 * the header requirement. The header is now the ONLY accepted proof.
 *
 * Proven here:
 *  - a custom SESSION_COOKIE_NAME works end to end (verify -> mutate) and the CSRF
 *    cookie name follows it (`<name>_csrf`);
 *  - a valid session cookie WITHOUT a CSRF header -> 403 csrf_failed;
 *  - a valid session cookie WITH the CSRF COOKIE but no header -> 403 (the regression);
 *  - a wrong/garbage header -> 403;
 *  - an empty/whitespace header -> 403;
 *  - correct Origin + session + header -> 200;
 *  - a wrong Origin -> 403 bad_origin;
 *  - a MISSING Origin on a mutation -> 403;
 *  - GET reads still work without a CSRF header;
 *  - logout with a live session requires the header (403 without, 200 with);
 *  - logout with a dead/expired session clears cookies and returns 200 without a header;
 *  - /api/access/verify succeeds with no pre-existing CSRF token.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cookieHeader, createDbSchema, parseSetCookies, startApp, verify } from "./helpers.mjs";

const SECRET = "correct-horse-battery-staple";
const ORIGIN = "http://localhost:5173";

let db;
before(async () => {
  db = await createDbSchema("access_csrf_strict");
});
after(async () => {
  if (db) await db.drop();
});

/* ---------------- custom SESSION_COOKIE_NAME end to end ------------------- */

test("a custom SESSION_COOKIE_NAME works end to end and the CSRF cookie name follows it", async () => {
  const COOKIE = "sekb_session_custom";
  const CSRF_COOKIE = `${COOKIE}_csrf`;
  const app = await startApp(db.databaseUrl, {
    env: { SITE_ACCESS_SECRET: SECRET, SESSION_COOKIE_NAME: COOKIE },
  });
  try {
    const v = await verify(app.origin, SECRET);
    assert.equal(v.res.status, 200);

    // Cookies use the custom names.
    assert.ok(v.cookies[COOKIE], "session cookie uses the custom name");
    assert.ok(v.cookies[CSRF_COOKIE], "CSRF cookie name is <SESSION_COOKIE_NAME>_csrf");
    assert.ok(!v.cookies[CSRF_COOKIE].attrs.httponly, "CSRF cookie is JS-readable");

    const token = v.cookies[COOKIE].value;
    const csrf = v.body.csrf_token;
    const cookie = cookieHeader({ [COOKIE]: token });

    // A protected mutation succeeds with the correctly-named session cookie + header.
    const ok = await fetch(`${app.origin}/api/box/start`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(ok.status, 200);
  } finally {
    await app.close();
  }
});

/* ------------- valid session, no CSRF header at all -> 403 --------------- */

test("a valid session cookie WITHOUT a CSRF header is rejected 403 csrf_failed", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const v = await verify(app.origin, SECRET);
    const cookie = cookieHeader({ [app.config.sessionCookieName]: v.cookies[app.config.sessionCookieName].value });

    const res = await fetch(`${app.origin}/api/box/start`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "csrf_failed");
  } finally {
    await app.close();
  }
});

/* --------- REGRESSION: CSRF cookie present but no header -> 403 ----------- */

test("a valid session cookie WITH the CSRF COOKIE but no header is rejected 403 (the regression)", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const v = await verify(app.origin, SECRET);
    const name = app.config.sessionCookieName;
    const csrfName = `${name}_csrf`;
    const token = v.cookies[name].value;
    const csrf = v.body.csrf_token;

    // Send BOTH cookies (as a browser would on a cross-site POST) but NO header.
    // Before the fix this was accepted via the cookie fallback; it must now 403.
    const cookie = cookieHeader({ [name]: token, [csrfName]: csrf });
    const res = await fetch(`${app.origin}/api/box/start`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 403, "CSRF cookie must NOT substitute for the header");
    assert.equal((await res.json()).code, "csrf_failed");
  } finally {
    await app.close();
  }
});

/* ----------------------- wrong/garbage header -> 403 --------------------- */

test("a wrong/garbage CSRF header is rejected 403", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const v = await verify(app.origin, SECRET);
    const name = app.config.sessionCookieName;
    const cookie = cookieHeader({ [name]: v.cookies[name].value });

    const res = await fetch(`${app.origin}/api/box/start`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "x-csrf-token": "not-the-real-token", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "csrf_failed");
  } finally {
    await app.close();
  }
});

/* --------------------- empty/whitespace header -> 403 -------------------- */

test("an empty or whitespace-only CSRF header is rejected 403 (same as missing)", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const v = await verify(app.origin, SECRET);
    const name = app.config.sessionCookieName;
    const cookie = cookieHeader({ [name]: v.cookies[name].value });

    for (const value of ["", "   ", "\t", "\n"]) {
      const res = await fetch(`${app.origin}/api/box/start`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "x-csrf-token": value, "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(res.status, 403, `empty/whitespace header ${JSON.stringify(value)} must be rejected`);
      assert.equal((await res.json()).code, "csrf_failed");
    }
  } finally {
    await app.close();
  }
});

/* ------------- correct Origin + session + header -> 200 ------------------ */

test("correct Origin + session cookie + CSRF header succeeds", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const v = await verify(app.origin, SECRET);
    const name = app.config.sessionCookieName;
    const cookie = cookieHeader({ [name]: v.cookies[name].value });

    const res = await fetch(`${app.origin}/api/box/start`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "x-csrf-token": v.body.csrf_token, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await app.close();
  }
});

/* --------------------------- wrong Origin -> 403 ------------------------- */

test("a wrong Origin is rejected 403 bad_origin (even with a valid header)", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const v = await verify(app.origin, SECRET);
    const name = app.config.sessionCookieName;
    const cookie = cookieHeader({ [name]: v.cookies[name].value });

    const res = await fetch(`${app.origin}/api/box/start`, {
      method: "POST",
      headers: {
        cookie,
        origin: "https://evil.example",
        "x-csrf-token": v.body.csrf_token,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "bad_origin");
  } finally {
    await app.close();
  }
});

/* -------------------------- missing Origin -> 403 ------------------------ */

test("a MISSING Origin on a mutation is rejected 403 bad_origin", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const v = await verify(app.origin, SECRET);
    const name = app.config.sessionCookieName;
    const cookie = cookieHeader({ [name]: v.cookies[name].value });

    // Node's fetch does not attach an Origin to a same-process request here, so this
    // is a mutation with no Origin header — it must be refused.
    const res = await fetch(`${app.origin}/api/box/start`, {
      method: "POST",
      headers: { cookie, "x-csrf-token": v.body.csrf_token, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "bad_origin");
  } finally {
    await app.close();
  }
});

/* -------------------- GET reads work without a header -------------------- */

test("GET reads still work without a CSRF header", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const v = await verify(app.origin, SECRET);
    const name = app.config.sessionCookieName;
    const cookie = cookieHeader({ [name]: v.cookies[name].value });

    for (const path of ["/api/box/status", "/api/runtime/status", "/api/export/status", "/api/broker/status"]) {
      const res = await fetch(`${app.origin}${path}`, { headers: { cookie } });
      assert.equal(res.status, 200, `${path} GET must not require a CSRF header`);
    }
  } finally {
    await app.close();
  }
});

/* --------------- logout with a LIVE session requires header -------------- */

test("logout with a live session requires the header: 403 without it, 200 with it", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const name = app.config.sessionCookieName;
    const csrfName = `${name}_csrf`;

    // A live session, logging out WITHOUT a header (only the cookies) must 403 —
    // the CSRF cookie must not substitute for the header.
    const v1 = await verify(app.origin, SECRET);
    const cookie1 = cookieHeader({ [name]: v1.cookies[name].value, [csrfName]: v1.body.csrf_token });
    const noHeader = await fetch(`${app.origin}/api/access/logout`, {
      method: "POST",
      headers: { cookie: cookie1, origin: ORIGIN },
    });
    assert.equal(noHeader.status, 403);
    assert.equal((await noHeader.json()).code, "csrf_failed");

    // With the header it succeeds and clears cookies.
    const withHeader = await fetch(`${app.origin}/api/access/logout`, {
      method: "POST",
      headers: { cookie: cookie1, origin: ORIGIN, "x-csrf-token": v1.body.csrf_token },
    });
    assert.equal(withHeader.status, 200);
    assert.deepEqual(await withHeader.json(), { authenticated: false });
    const cleared = parseSetCookies(withHeader);
    assert.equal(cleared[name].attrs["max-age"], "0", "logout clears the session cookie");

    // And the old session is now dead.
    const dead = await fetch(`${app.origin}/api/box/status`, {
      headers: { cookie: cookieHeader({ [name]: v1.cookies[name].value }) },
    });
    assert.equal(dead.status, 401);
  } finally {
    await app.close();
  }
});

/* ------------- logout with a DEAD session: no header needed -------------- */

test("logout with a dead/expired session clears cookies and returns 200 without a header", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const name = app.config.sessionCookieName;

    // Mint an already-expired session directly via the store, then present its
    // cookie to logout with NO CSRF header and NO Origin — a browser holding a dead
    // cookie must still be able to clear it.
    const minted = await app.sessionStore.mintSession(
      { siteAccessSecret: SECRET, ttlHours: -1 },
      { ip: "1.2.3.4", userAgent: "test", role: "full" },
    );
    const cookie = cookieHeader({ [name]: minted.sessionToken });

    const res = await fetch(`${app.origin}/api/access/logout`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(res.status, 200, "a dead session logs out without a CSRF header");
    assert.deepEqual(await res.json(), { authenticated: false });
    const cleared = parseSetCookies(res);
    assert.equal(cleared[name].attrs["max-age"], "0", "cookies are still cleared");

    // An unknown/never-existed session also clears without a header.
    const unknown = await fetch(`${app.origin}/api/access/logout`, {
      method: "POST",
      headers: { cookie: cookieHeader({ [name]: "totally-unknown-token" }) },
    });
    assert.equal(unknown.status, 200);
    assert.deepEqual(await unknown.json(), { authenticated: false });
  } finally {
    await app.close();
  }
});

/* ---------- verify is the only public mutation, needs no CSRF ------------ */

test("/api/access/verify succeeds with no pre-existing CSRF token", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    // No cookies, no CSRF header, no Origin from a prior session — verify is the
    // single public mutation and must not require a pre-existing CSRF token.
    const res = await fetch(`${app.origin}/api/access/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: SECRET }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.authenticated, true);
    assert.ok(typeof body.csrf_token === "string" && body.csrf_token.length >= 32);
  } finally {
    await app.close();
  }
});
