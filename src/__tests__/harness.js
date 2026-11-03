/**
 * Shared integration-test harness for the BookNook API test suite.
 *
 * Runs via `npm test` (node:test). Each test file gets its own child process,
 * so importing this harness sets up a fully isolated environment per file:
 *
 * - A throwaway MongoDB test database (`book-nook-test-<random hex>`) on the
 *   same cluster as dev — the real "book-nook" database is never touched and
 *   the test database is dropped during teardown.
 * - A throwaway JWKS endpoint: the suite generates a real
 *   Ed25519 keypair and serves the public key, so JWTs are verified through
 *   the exact production path (jose remote JWKS in src/auth.js), never faked.
 * - The real Express app booted on an ephemeral port.
 *
 * Environment overrides are applied at import time, BEFORE ../app.js is
 * dynamically imported, matching dotenv's no-override behavior in .env.
 */
import "dotenv/config";

import crypto from "node:crypto";
import http from "node:http";

import { MongoClient, ObjectId } from "mongodb";
import { exportJWK, SignJWT } from "jose";

const ALG = "EdDSA";
const TEST_DB_NAME = `book-nook-test-${crypto.randomBytes(4).toString("hex")}`;
const TEST_ISSUER = "test-issuer";
const TEST_AUDIENCE = "test-audience";

const KEY_PAIR = crypto.generateKeyPairSync("ed25519");

// Identity used for books seeded without an explicit owner.
const SEED_OWNER = { name: "Seed Owner", email: "seed-owner@booknook.test" };

process.env.JWT_ISSUER = TEST_ISSUER;
process.env.JWT_AUDIENCE = TEST_AUDIENCE;
process.env.MONGODB_DB = TEST_DB_NAME;

const { default: app } = await import("../app.js");
const { closeDatabase } = await import("../database.js");

/** Signs a real EdDSA JWT exactly like the Better Auth JWT plugin would. */
async function signToken(user, { expiresIn = "15m" } = {}) {
  return new SignJWT({ name: user.name, email: user.email, image: null })
    .setProtectedHeader({ alg: ALG, kid: "test-key-1" })
    .setSubject(user.sub)
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(KEY_PAIR.privateKey);
}

/** Boots JWKS + API servers and a throwaway Mongo test DB. Call in before(). */
export async function startTestEnv() {
  const publicJwk = {
    ...(await exportJWK(KEY_PAIR.publicKey)),
    kid: "test-key-1",
    alg: ALG,
    use: "sig",
  };

  const jwksServer = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  // auth.js reads JWKS_URL lazily on the first request — safe to set now.
  process.env.JWKS_URL = `http://127.0.0.1:${jwksServer.address().port}/jwks`;

  const apiServer = http.createServer(app);
  await new Promise((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  const apiBase = `http://127.0.0.1:${apiServer.address().port}`;

  const testClient = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 20_000,
  });
  await testClient.connect();

  async function api(path, { method = "GET", token, body } = {}) {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await response.json().catch(() => null);
    return { status: response.status, body: json };
  }

  async function seedBook({
    copies,
    copiesAvailable,
    title = "Test Book",
    owner = SEED_OWNER,
  }) {
    const doc = {
      title,
      author: "Test Author",
      category: "Fiction",
      cover: "https://example.com/test-cover.jpg",
      description: "A test book",
      rating: null,
      copies,
      copiesAvailable,
      addedBy: { name: owner.name, email: owner.email },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await books.insertOne(doc);
    return { ...doc, id: result.insertedId.toString() };
  }

  async function readBook(bookId) {
    return books.findOne({ _id: new ObjectId(bookId) });
  }

  const books = testClient.db(TEST_DB_NAME).collection("books");
  const borrows = testClient.db(TEST_DB_NAME).collection("borrows");

  return {
    apiBase,
    dbName: TEST_DB_NAME,
    api,
    signToken,
    seedBook,
    readBook,
    books,
    borrows,
    stop: async () => {
      // Drop ONLY the throwaway test database, then close everything.
      await testClient.db(TEST_DB_NAME).dropDatabase().catch(() => {});
      await testClient.close().catch(() => {});
      await closeDatabase().catch(() => {});
      const close = (server) =>
        new Promise((resolve) => (server ? server.close(resolve) : resolve()));
      await Promise.all([close(apiServer), close(jwksServer)]);
    },
  };
}
