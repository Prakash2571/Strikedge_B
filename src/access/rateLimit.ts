/**
 * Rate limiting for the access gate.
 *
 * This wraps the ported, dependency-free fixed-window limiter in `src/ratelimit.ts`
 * with the two buckets the passcode gate needs, so the policy lives in one place
 * and the routes just mount the middleware.
 *
 * VERIFY BUCKET
 * The passcode is the one credential guarding the whole app, so verify is the
 * brute-force target. The policy is exactly 10 attempts per 5 minutes per client
 * IP; the 11th within the window is refused with 429. Keying is by IP (read from
 * X-Forwarded-For behind nginx, else the socket address), matching the ported
 * limiter's behaviour.
 */

import type { RequestHandler } from "express";
import { rateLimit } from "../ratelimit.js";

/** Window and cap for the passcode verify endpoint. */
export const VERIFY_WINDOW_MS = 5 * 60_000;
export const VERIFY_MAX_ATTEMPTS = 10;

/**
 * 10 verify attempts per 5 minutes per IP; the 11th is refused.
 *
 * The message is deliberately generic and identical to the invalid-passcode
 * error's tone: it must not help an attacker distinguish "you were rate limited
 * because you were wrong a lot" from anything about the secret's state.
 */
export function createVerifyRateLimit(): RequestHandler {
  return rateLimit({
    windowMs: VERIFY_WINDOW_MS,
    max: VERIFY_MAX_ATTEMPTS,
    message: "Too many attempts. Please wait a few minutes and try again.",
  });
}
