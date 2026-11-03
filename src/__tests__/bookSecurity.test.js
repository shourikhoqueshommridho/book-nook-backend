/**
 * Integration tests for Book update/delete security (PATCH/DELETE
 * /api/books/:id) and the authenticated own-books filter
 * (GET /api/books?mine=true).
 *
 * Setup (run via `npm test` — see src/__tests__/harness.js): a throwaway
 * MongoDB test database is dropped at teardown; real JWTs are verified via
 * the production JWKS path; the real brand app is booted on an ephemeral port.
 */
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { after, before, describe, it } from "node:test";

import { startTestEnv } from "./harness.js";

const ALICE = { sub: "user-alice", name: "Alice Tester", email: "alice@example.com" };
const BOB = { sub: "user-bob", name: "Bob Tester", email: "bob@example.com" };
/** Owner wrapper used when a test needs a book that belonds to alice. */
const ALICE_OWNER = { name: ALICE.name, email: ALICE.email };
const BOB_BOOK_OWNER = { name: "Bob (seed)", email: BOB.email };

let api;
let signToken;
let seedBook;
let readBook;
let books;
let stop;

describe("Book security (PATCH/DELETE/mine)", () => {
  before(async () => {
    const env = await startTestEnv();
    ({ api, signToken, seedBook, readBook, books, stop } = env);
  });

  it("PATCH /api/books/:id — without a JWT → 401", async () => {
    const book = await seedBook({ copies: 1, copiesAvailable: 1, owner: ALICE_OWNER });
    const res = await api(`/api/books/${book.id}`, {
      method: "PATCH",
      body: { title: "Hacked Title" },
    });
    assert.equal(res.status, 401);

    const stored = await readBook(book.id);
    assert.equal(stored.title, "Test Book"); // unchanged
  });

  it("DELETE /api/books/:id — without a JWT → 401", async () => {
    const book = await seedBook({ copies: 1, copiesAvailable: 1, owner: ALICE_OWNER });
    const res = await api(`/api/books/${book.id}`, { method: "DELETE" });
    assert.equal(res.status, 401);

    const stillThere = await readBook(book.id);
    assert.ok(stillThere); // unchanged
  });

  it("PATCH — the owner can update their own book", async () => {
    const book = await seedBook({ copies: 2, copiesAvailable: 1, owner: ALICE_OWNER });
    const res = await api(`/api/books/${book.id}`, {
      method: "PATCH",
      token: await signToken(ALICE),
      body: {
        title: "Atomic Habits (Revised)",
        description: "Updated description",
        rating: 4.5,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.book.title, "Atomic Habits (Revised)");
    assert.equal(res.body.book.description, "Updated description");
    assert.equal(res.body.book.rating, 4.5);
    assert.equal(res.body.book.addedBy.email, ALICE.email); // ownership intact
  });

  it("DELETE — the owner can delete their own book", async () => {
    const book = await seedBook({ copies: 1, copiesAvailable: 1, owner: ALICE_OWNER });
    const res = await api(`/api/books/${book.id}`, {
      method: "DELETE",
      token: await signToken(ALICE),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, true);
    assert.equal(await readBook(book.id), null);
  });

  it("PATCH — another user cannot update someone else's book → 403", async () => {
    const book = await seedBook({ copies: 1, copiesAvailable: 1, owner: ALICE_OWNER });
    const res = await api(`/api/books/${book.id}`, {
      method: "PATCH",
      token: await signToken(BOB), // bob did not add this book
      body: { title: "Bob's Sneaky Edit" },
    });
    assert.equal(res.status, 403);

    const stored = await readBook(book.id);
    assert.equal(stored.title, "Test Book"); // unchanged
  });

  it("DELETE — another user cannot delete someone else's book → 403", async () => {
    const book = await seedBook({ copies: 1, copiesAvailable: 1, owner: ALICE_OWNER });
    const res = await api(`/api/books/${book.id}`, {
      method: "DELETE",
      token: await signToken(BOB),
    });
    assert.equal(res.status, 403);

    const stillThere = await readBook(book.id);
    assert.ok(stillThere); // unchanged
  });

  it("PATCH — invalid ObjectId → 400", async () => {
    const res = await api("/api/books/not-an-objectid", {
      method: "PATCH",
      token: await signToken(ALICE),
      body: { title: "Whatever" },
    });
    assert.equal(res.status, 400);
  });

  it("DELETE — invalid ObjectId → 400", async () => {
    const res = await api("/api/books/not-an-objectid", {
      method: "DELETE",
      token: await signToken(ALICE),
    });
    assert.equal(res.status, 400);
  });

  it("DELETE — nonexistent book (valid ObjectId) → 404", async () => {
    const res = await api(`/api/books/${new ObjectId().toString()}`, {
      method: "DELETE",
      token: await signToken(ALICE),
    });
    assert.equal(res.status, 404);
  });

  it("PATCH — nonexistent book (valid ObjectId) → 404", async () => {
    const res = await api(`/api/books/${new ObjectId().toString()}`, {
      method: "PATCH",
      token: await signToken(ALICE),
      body: { title: "Whatever" },
    });
    assert.equal(res.status, 404);
  });

  it("PATCH — protected server-controlled fields are safely ignored", async () => {
    const book = await seedBook({ copies: 2, copiesAvailable: 2, owner: ALICE_OWNER });
    const before = await readBook(book.id);

    const res = await api(`/api/books/${book.id}`, {
      method: "PATCH",
      token: await signToken(ALICE),
      body: {
        title: "Legit Edit",
        // Everything below must NOT be persisted:
        _id: new ObjectId().toString(),
        addedBy: { name: "Evil", email: "evil@example.com" },
        createdAt: "2000-01-01T00:00:00.000Z",
        updatedAt: "2000-01-01T00:00:00.000Z",
      },
    });
    assert.equal(res.status, 200);

    const after = await readBook(book.id);
    assert.equal(after.title, "Legit Edit"); // allowed edit did apply
    assert.equal(after._id.toString(), before._id.toString());
    assert.equal(after.addedBy.email, ALICE.email); // owner immutable
    assert.equal(
      after.createdAt.toString(),
      before.createdAt.toString(),
      "createdAt must not change"
    );
    assert.ok(after.updatedAt > before.updatedAt, "updatedAt is server-controlled");
  });

  it("GET /api/books?mine=true — authenticated own-books filter", async () => {
    const mine1 = await seedBook({ copies: 1, copiesAvailable: 1, title: "Alice 1", owner: ALICE_OWNER });
    await seedBook({ copies: 1, copiesAvailable: 1, title: "Alice 2", owner: ALICE_OWNER });
    await seedBook({ copies: 1, copiesAvailable: 1, title: "Bob 1", owner: BOB_BOOK_OWNER });

    // alice sees only her own books.
    const mine = await api("/api/books?mine=true", {
      token: await signToken(ALICE),
    });
    const aliceCount = await books.countDocuments({ "addedBy.email": ALICE.email });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.total, aliceCount); // every alice-owned book, nothing else
    assert.ok(mine.body.books.length >= 2);
    assert.ok(mine.body.books.every((b) => b.addedBy?.email === ALICE.email));
    assert.ok(mine.body.books.some((b) => b.title === mine1.title));
    assert.ok(!mine.body.books.some((b) => b.addedBy?.email !== ALICE.email));

    // bob sees only his own books, through the same filter.
    const bobMine = await api("/api/books?mine=true", { token: await signToken(BOB) });
    const bobCount = await books.countDocuments({ "addedBy.email": BOB.email });
    assert.equal(bobMine.status, 200);
    assert.equal(bobMine.body.total, bobCount);
    assert.ok(bobMine.body.books.every((b) => b.addedBy?.email === BOB.email));
  });

  it("GET /api/books?mine=true — without a JWT → 401", async () => {
    const res = await api("/api/books?mine=true");
    assert.equal(res.status, 401);
  });

  it("GET /api/books?mine=true — a smuggled identity query param cannot expose another user's books", async () => {
    const aliceBook = await seedBook({ copies: 1, copiesAvailable: 1, title: "Alice 3", owner: ALICE_OWNER });
    await seedBook({ copies: 1, copiesAvailable: 1, title: "Bob 2", owner: BOB_BOOK_OWNER });

    const alice = await api(
      `/api/books?mine=true&userEmail=${encodeURIComponent(BOB.email)}&addedBy=${encodeURIComponent(BOB.email)}`,
      { token: await signToken(ALICE) }
    );
    const expected = await books.countDocuments({ "addedBy.email": ALICE.email });
    assert.equal(alice.status, 200);
    assert.equal(alice.body.total, expected); // alice's own books only, smuggled param ignored
    assert.ok(alice.body.books.some((b) => b.title === aliceBook.title));
    assert.ok(
      alice.body.books.every((b) => b.addedBy?.email === ALICE.email),
      "query param identity manipulation must be ignored"
    );
    assert.ok(!alice.body.books.some((b) => b.addedBy?.email === BOB.email));
  });

  it("GET /api/books — the public listing still works without authentication", async () => {
    const res = await api("/api/books?sort=newest&limit=10");
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.total, "number");
    assert.ok(Array.isArray(res.body.books));
  });

  it("PATCH — invalid body (bad category) → 400", async () => {
    const book = await seedBook({ copies: 1, copiesAvailable: 1, owner: ALICE_OWNER });
    const res = await api(`/api/books/${book.id}`, {
      method: "PATCH",
      token: await signToken(ALICE),
      body: { title: "Still ok", category: "NotACategory" },
    });
    assert.equal(res.status, 400);
  });

  after(async () => {
    // Drop ONLY the throwaway test database, then close everything.
    await stop();
  });
});
