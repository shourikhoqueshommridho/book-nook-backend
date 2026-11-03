import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { after, before, describe, it } from "node:test";

import { startTestEnv } from "./harness.js";



const ALICE = { sub: "user-alice", name: "Alice Tester", email: "alice@example.com" };
const BOB = { sub: "user-bob", name: "Bob Tester", email: "bob@example.com" };
const RACERS = Array.from({ length: 6 }, (_, i) => ({
  sub: `racer-${i}`,
  name: `Racer ${i}`,
  email: `racer-${i}@example.com`,
}));



let api;
let signToken;
let books;
let borrows;
let stop;

async function readBook(bookId) {
  return books.findOne({ _id: new ObjectId(bookId) });
}

describe("Borrow System", () => {
  before(async () => {
    const env = await startTestEnv();
    ({ api, signToken, books, borrows, stop } = env);
  });

  it("POST /borrows — happy path: creates an active record and decrements copies by exactly 1", async () => {
    const book = await seedBook({ copies: 3, copiesAvailable: 3, title: "Atomic Habits" });

    const res = await api("/api/borrows", {
      method: "POST",
      token: await signToken(ALICE),
      body: { bookId: book.id },
    });

    assert.equal(res.status, 201);
    const borrow = res.body.borrow;
    assert.equal(borrow.status, "active");
    assert.equal(borrow.bookTitle, "Atomic Habits");
    assert.equal(borrow.bookImage, book.cover);
    assert.equal(borrow.userEmail, ALICE.email);
    assert.equal(typeof borrow.borrowDate, "string");
    assert.equal(borrow.returnDate, null);

    const stored = await borrows.findOne({ _id: new ObjectId(borrow.id) });
    assert.ok(stored);
    assert.equal(stored.userEmail, ALICE.email);
    assert.equal(stored.status, "active");

    const updated = await readBook(book.id);
    assert.equal(updated.copiesAvailable, 2); // 3 - 1
    assert.equal(updated.copies, 3); // total never changes on borrow
  });

  it("POST /borrows — without a JWT → 401", async () => {
    const book = await seedBook({ copies: 2, copiesAvailable: 2 });
    const res = await api("/api/borrows", {
      method: "POST",
      body: { bookId: book.id },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Sign in to perform this action.");

    const updated = await readBook(book.id);
    assert.equal(updated.copiesAvailable, 2); // untouched
  });

  it("POST /borrows — invalid book id → 400", async () => {
    const res = await api("/api/borrows", {
      method: "POST",
      token: await signToken(ALICE),
      body: { bookId: "not-an-objectid" },
    });
    assert.equal(res.status, 400);
  });

  it("POST /borrows — nonexistent book → 404", async () => {
    const res = await api("/api/borrows", {
      method: "POST",
      token: await signToken(ALICE),
      body: { bookId: new ObjectId().toString() },
    });
    assert.equal(res.status, 404);
  });

  it("POST /borrows — zero available copies → 409, database untouched", async () => {
    const book = await seedBook({ copies: 5, copiesAvailable: 0 });
    const res = await api("/api/borrows", {
      method: "POST",
      token: await signToken(ALICE),
      body: { bookId: book.id },
    });
    assert.equal(res.status, 409);

    const count = await borrows.countDocuments({ bookId: new ObjectId(book.id) });
    assert.equal(count, 0);
    const updated = await readBook(book.id);
    assert.equal(updated.copiesAvailable, 0);
  });

  it("POST /borrows — same user borrows the same book twice → 409, copies unchanged", async () => {
    // alice's active borrow of "Atomic Habits" from the happy-path test.
    const book = await readBook(
      (await borrows.findOne({ userEmail: ALICE.email, status: "active" })).bookId
    );
    const response = await api("/api/borrows", {
      method: "POST",
      token: await signToken(ALICE),
      body: { bookId: book._id.toString() },
    });
    assert.equal(response.status, 409);
    const updated = await readBook(book._id.toString());
    assert.equal(updated.copiesAvailable, 2); // exactly what it was
  });

  it("GET /borrows — returns only the authenticating user's records; a smuggled userEmail param is ignored", async () => {
    // bob borrows his own book so both users have one active record each.
    const bobBook = await seedBook({ copies: 1, copiesAvailable: 1, title: "Bob's Book" });
    const bobBorrow = await api("/api/borrows", {
      method: "POST",
      token: await signToken(BOB),
      body: { bookId: bobBook.id },
    });
    assert.equal(bobBorrow.status, 201);

    const aliceList = await api("/api/borrows", {
      token: await signToken(ALICE),
    });
    assert.equal(aliceList.status, 200);
    assert.ok(Array.isArray(aliceList.body.borrows));
    assert.ok(aliceList.body.borrows.length >= 1);
    assert.ok(
      aliceList.body.borrows.every((b) => b.userEmail === ALICE.email),
      "alice only sees her own records"
    );
    assert.ok(aliceList.body.borrows.every((b) => b.bookId !== bobBook.id));

    // bob trying to read alice's records via a query param — must still be bob-only.
    const smuggled = await api(
      `/api/borrows?userEmail=${encodeURIComponent(ALICE.email)}`,
      { token: await signToken(BOB) }
    );
    assert.equal(smuggled.status, 200);
    assert.ok(
      smuggled.body.borrows.every((b) => b.userEmail === BOB.email),
      "userEmail query param must not override the token identity"
    );
  });

  it("DELETE /borrows/:id — happy path: marks returned and restores exactly one copy", async () => {
    const active = await borrows.findOne({ userEmail: ALICE.email, status: "active" });
    const before = await readBook(active.bookId.toString());
    assert.equal(before.copiesAvailable, 2);

    const res = await api(`/api/borrows/${active._id.toString()}`, {
      method: "DELETE",
      token: await signToken(ALICE),
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.borrow.status, "returned");
    assert.ok(typeof res.body.borrow.returnDate === "string");

    const updated = await readBook(active.bookId.toString());
    assert.equal(updated.copiesAvailable, 3); // 2 + 1, exactly once
  });

  it("DELETE /borrows/:id — another user's borrow record → 403, nothing changes", async () => {
    const book = await seedBook({ copies: 2, copiesAvailable: 2, title: "Shared Book" });
    const mine = await api("/api/borrows", {
      method: "POST",
      token: await signToken(ALICE),
      body: { bookId: book.id },
    });
    assert.equal(mine.status, 201);

    const res = await api(`/api/borrows/${mine.body.borrow.id}`, {
      method: "DELETE",
      token: await signToken(BOB), // bob is not the owner
    });
    assert.equal(res.status, 403);

    const stillActive = await borrows.findOne({
      _id: new ObjectId(mine.body.borrow.id),
    });
    assert.equal(stillActive.status, "active");
    assert.equal(stillActive.returnDate, null);
    const updated = await readBook(book.id);
    assert.equal(updated.copiesAvailable, 1); // unchanged
  });

  it("DELETE /borrows/:id — double return → 409, copies restored only once", async () => {
    const active = await borrows.findOne({ userEmail: ALICE.email, status: "active" });
    const first = await api(`/api/borrows/${active._id.toString()}`, {
      method: "DELETE",
      token: await signToken(ALICE),
    });
    assert.equal(first.status, 200);
    const afterFirst = await readBook(active.bookId.toString());

    const second = await api(`/api/borrows/${active._id.toString()}`, {
      method: "DELETE",
      token: await signToken(ALICE),
    });
    assert.equal(second.status, 409);

    const afterSecond = await readBook(active.bookId.toString());
    assert.equal(
      afterSecond.copiesAvailable,
      afterFirst.copiesAvailable,
      "a duplicate return must not increment copies twice"
    );
  });

  it("POST /borrows — 6 concurrent borrowers fight for the last copy: exactly one wins", async () => {
    const book = await seedBook({ copies: 1, copiesAvailable: 1, title: "Single Copy" });

    const results = await Promise.allSettled(
      RACERS.map(async (racer) =>
        api("/api/borrows", {
          method: "POST",
          token: await signToken(racer),
          body: { bookId: book.id },
        })
      )
    );

    const { won, lost, other } = results.reduce(
      (seen, result) => {
        if (result.status === "fulfilled") {
          if (result.value.status === 201) seen.won.push(result.value);
          else seen.lost.push(result.value);
        } else {
          seen.other.push(result);
        }
        return seen;
      },
      { won: [], lost: [], other: [] }
    );

    assert.equal(other.length, 0, `unexpected promise rejections: ${JSON.stringify(other)}`);
    assert.equal(won.length, 1, "exactly one borrower should win the last copy");
    assert.ok(
      lost.every((r) => r.status === 409),
      `losers must get 409, got: ${lost.map((r) => r.status).join(",")}`
    );

    const finalBook = await readBook(book.id);
    assert.equal(finalBook.copiesAvailable, 0, "available copies never oversubscribed");
    const activeCount = await borrows.countDocuments({
      bookId: new ObjectId(book.id),
      status: "active",
    });
    assert.equal(activeCount, 1, "exactly one active borrow record exists");
  });

  it("DELETE /borrows/:id — concurrent double return: exactly one 200, copies incremented exactly once", async () => {
    const book = await seedBook({ copies: 4, copiesAvailable: 4, title: "Race Return" });
    const borrow = await api("/api/borrows", {
      method: "POST",
      token: await signToken(ALICE),
      body: { bookId: book.id },
    });
    assert.equal(borrow.status, 201);

    const [r1, r2] = await Promise.all([
      api(`/api/borrows/${borrow.body.borrow.id}`, {
        method: "DELETE",
        token: await signToken(ALICE),
      }),
      api(`/api/borrows/${borrow.body.borrow.id}`, {
        method: "DELETE",
        token: await signToken(ALICE),
      }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 409]);

    const updated = await readBook(book.id);
    assert.equal(updated.copiesAvailable, 4); // 3 + 1, restored exactly once
  });

  it("GET /borrows — empty list is handled cleanly", async () => {
    const fresh = {
      sub: "fresh-user",
      name: "Fresh",
      email: "fresh@example.com",
    };
    const res = await api("/api/borrows", { token: await signToken(fresh) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.borrows, []);
  });

  after(async () => {
    // Drop ONLY the throwaway test database, then close everything.
    await stop();
  });
});

/** Seeds one book straight into the test database and returns its id. */
async function seedBook({ copies, copiesAvailable, title = "Test Book" }) {
  const doc = {
    title,
    author: "Test Author",
    category: "Fiction",
    cover: "https://example.com/test-cover.jpg",
    description: "A test book",
    rating: null,
    copies,
    copiesAvailable,
    addedBy: { name: ALICE.name, email: ALICE.email },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await books.insertOne(doc);
  return { ...doc, id: result.insertedId.toString() };
}
