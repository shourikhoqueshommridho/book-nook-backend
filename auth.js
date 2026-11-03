/**
 * Better Auth JWT verification middleware for Express 5.
 *
 * Better Auth runs inside the Next.js app and serves its public signing keys
 * at GET {NEXT_PUBLIC_APP_URL}/api/auth/jwks. The Express API verifies every
 * incoming JWT against that remote JWKS — no shared secret, no second auth
 * system, and key rotation is automatically picked up.
 *
 * This is the only code kept outside index.js, because crypto/JWKS logic is
 * easier to read and maintain as its own small file.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

const JWT_ISSUER = process.env.JWT_ISSUER ?? "booknook";
const JWT_AUDIENCE = process.env.JWT_AUDIENCE ?? "booknook-api";

/** Operational error carrying an HTTP status code (shared with index.js). */
export class ApiError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

// Web-Key cache for Better Auth's public keys (created once, refreshed
// instead of re-fetched on every request).
let remoteJwks = null;

function getRemoteJwks() {
  const jwksUrl = process.env.JWKS_URL;
  if (!jwksUrl) {
    throw new ApiError(
      503,
      "Authentication is not configured on this server. Set JWKS_URL in the backend .env file."
    );
  }
  if (!remoteJwks) {
    remoteJwks = createRemoteJWKSet(new URL(jwksUrl), {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
  }
  return remoteJwks;
}

function extractBearerToken(req) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

/** Verifies signature, algorithm, expiry, issuer and audience. */
export async function verifyAuthToken(token) {
  try {
    const { payload } = await jwtVerify(token, getRemoteJwks(), {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ["EdDSA"],
      clockTolerance: 5,
    });
    return payload;
  } catch (error) {
    throw new ApiError(
      401,
      error.code === "ERR_JWT_EXPIRED"
        ? "Your session has expired. Please sign in again."
        : "Invalid or missing authentication token.",
      error.code
    );
  }
}

/** Express middleware: rejects requests without a valid Better Auth JWT. */
export async function requireAuth(req, _res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      throw new ApiError(401, "Sign in to perform this action.");
    }

    const payload = await verifyAuthToken(token);
    if (!payload.sub || typeof payload.email !== "string") {
      throw new ApiError(401, "Authentication token is missing required user claims.");
    }

    // The verified token — not the client body — is the only source of
    // identity used downstream (e.g. book ownership).
    req.user = {
      id: payload.sub,
      name: typeof payload.name === "string" ? payload.name : "",
      email: payload.email,
      image: typeof payload.image === "string" ? payload.image : null,
    };
    next();
  } catch (error) {
    next(error);
  }
}
