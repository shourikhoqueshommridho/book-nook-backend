import { Router } from "express";
import { ObjectId } from "mongodb";
import {
  getBorrowsCollection,
  getBooksCollection,
  getDatabase,
  getMongoClient,
  toApiBorrow,
} from "../database.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../auth.js";
import { BOOKS_COLLECTION, BORROW_STATUS, BORROWS_COLLECTION } from "../constants.js";
import { requireString } from "../validation.js";

const router = Router();

/* --- Id + duplicate-error helpers ---------------------------------------------- */

/** Parses and validates a request-supplied id string into an ObjectId. */
function parseId(value, label) {
  if (typeof value !== "string" || !ObjectId.isValid(value)) {
    throw new ApiError(400, `"${label}" is not a valid id.`);
  }
  return new ObjectId(value);
}

/** Maps the unique-index duplicate-key error to a friendly 409. */
function isDuplicateBorrowError(error) {
  return error.code === 11000 && error.message?.includes("unique_active_borrow_per_book_user");
}

/* --- Transaction support probing ------------------------------------------------- */

/**
 * Multi-document transactions need a replica set. Some deployments
 * (single-node mongod) don't support them, so the borrow operations probe the
 * capability once and fall back to a compensated non-transactional flow.
 */
let transactionCapable = null;

async function supportsTransactions() {
  if (transactionCapable !== null) {
    return transactionCapable;
  }

  const session = getMongoClient().startSession();
  try {
    session.startTransaction();
    await getMongoClient().db().command({ ping: 1 }, { session });
    await session.commitTransaction();
    transactionCapable = true;
  } catch {
    transactionCapable = false;
  } finally {
    await session.endSession().catch(() => {});
  }

  return transactionCapable;
}

/* --- Borrow step ---------------------------------------------------------------- */

/**
 * Borrows one book: duplicate-guard → snapshot → atomic decrement → insert.
 *
 * When `session` is provided every read/write joins that transaction, so a
 * failure anywhere aborts the whole thing with no compensation needed.
 *
 * Without a session (deployments without transaction support) the copies
 * decrement is still a single atomic conditional update
 * (`$inc` guarded by `copiesAvailable > 0`), and the borrow insert failing —
 * for any reason — is compensated by immediately restoring the copy, so a
 * decrement is never left behind without a borrow record.
 */
async function borrowOne({ bookId, user, session = null }) {
  const db = await getDatabase();
  const books = db.collection(BOOKS_COLLECTION);
  const borrows = db.collection(BORROWS_COLLECTION);
  const withSession = session ? { session } : {};

  // 1. Duplicate guard (defense in depth — the unique partial index also
  //    enforces this at insert time, even against racing requests).
  const duplicate = await borrows.findOne(
    { bookId, userEmail: user.email, status: BORROW_STATUS.ACTIVE },
    withSession
  );
  if (duplicate) {
    throw new ApiError(
      409,
      "You already have an active borrow for this book. Return it before borrowing again."
    );
  }

  // 2. Book must exist — snapshot title/cover for the borrow record.
  const book = await books.findOne({ _id: bookId }, withSession);
  if (!book) {
    throw new ApiError(404, `No book found with id "${bookId.toString()}".`);
  }

  // 3. ATOMIC decrement: the `copiesAvailable > 0` filter lives in the same
  //    update as `$inc: -1`, so even N concurrent borrows of the last copy
  //    can only ever succeed once.
  const decremented = await books.findOneAndUpdate(
    { _id: bookId, copiesAvailable: { $type: "number", $gt: 0 } },
    { $inc: { copiesAvailable: -1 } },
    { ...withSession, returnDocument: "before" }
  );

  if (!decremented) {
    // Distinguish "no such book" from "no available copies".
    const stillExists = await books.findOne({ _id: bookId }, withSession);
    throw stillExists
      ? new ApiError(409, "No available copies left for this book.")
      : new ApiError(404, `No book found with id "${bookId.toString()}".`);
  }

  // 4. Insert the borrow record. The unique partial index turns racing
  //    duplicate borrows into an E11000 here.
  const record = {
    bookId,
    bookTitle: book.title,
    bookImage: book.cover,
    userEmail: user.email,
    borrowDate: new Date(),
    returnDate: null,
    status: BORROW_STATUS.ACTIVE,
  };

  try {
    await borrows.insertOne(record, withSession);
  } catch (error) {
    if (!session) {
      // No transaction rollback available — manually give the copy back.
      await books
        .updateOne({ _id: bookId }, { $inc: { copiesAvailable: 1 } })
        .catch(() => {
          // Extremely rare (process dying mid-compensation). Logged, never
          //masked: copies drift is detectable against the borrow records.
          console.error(
            `Borrow compensation failed for book ${bookId.toString()} — available copies may have drifted.`
          );
        });
    }
    throw isDuplicateBorrowError(error)
      ? new ApiError(
          409,
          "You already have an active borrow for this book. Return it before borrowing again."
        )
      : error;
  }

  return record;
}

/* --- Return step ----------------------------------------------------------------- */

/**
 * Returns a previously borrowed book.
 *
 * The "claim" is a single atomic `findOneAndUpdate` on
 * `{ _id, userEmail, status: "active" }` → `$set { status: "returned" }`.
 * Only the first concurrent return can ever match that filter; every later
 * attempt (or a double-return race) sees no match and fails. The copy is
 * restored with `$inc` exactly once per successful claim.
 */
async function returnOne({ borrowId, user, session = null }) {
  const db = await getDatabase();
  const books = db.collection(BOOKS_COLLECTION);
  const borrows = db.collection(BORROWS_COLLECTION);
  const withSession = session ? { session } : {};

  // 1. Ownership/existence/already-returned diagnostics (read-only).
  const existing = await borrows.findOne({ _id: borrowId }, withSession);
  if (!existing) {
    throw new ApiError(404, `No borrow record found with id "${borrowId.toString()}".`);
  }
  if (existing.userEmail !== user.email) {
    // Ownership comes from the verified token — foreign records are
    // rejected before any write happens.
    throw new ApiError(403, "This borrow record does not belong to you.");
  }
  if (existing.status !== BORROW_STATUS.ACTIVE) {
    throw new ApiError(409, "This book has already been returned.");
  }

  // 2. Atomic claim of the active borrow (duplicate-return guard).
  const claimed = await borrows.findOneAndUpdate(
    { _id: borrowId, status: BORROW_STATUS.ACTIVE },
    { $set: { status: BORROW_STATUS.RETURNED, returnDate: new Date() } },
    { ...withSession, returnDocument: "after" }
  );
  if (!claimed) {
    throw new ApiError(409, "This book has already been returned.");
  }

  // 3. Restore exactly one available copy.
  const restored = await books.updateOne(
    { _id: claimed.bookId },
    { $inc: { copiesAvailable: 1 } },
    withSession
  );

  if (!session && restored.modifiedCount === 0) {
    const bookStillExists = await books.findOne({ _id: claimed.bookId });
    if (bookStillExists) {
      // The copy could not be restored — undo the claim so the user keeps a
      // consistent state and can retry, instead of losing a copy silently.
      await borrows.updateOne(
        { _id: borrowId },
        { $set: { status: BORROW_STATUS.ACTIVE, returnDate: null } }
      );
      throw new ApiError(
        500,
        "The book could not be returned right now. Please try again."
      );
    }
    // The book itself was deleted meanwhile: marking the borrow returned is
    // still correct — there is simply no copy count left to restore.
  }

  return claimed;
}

/* --- Routes ----------------------------------------------------------------------- */

/**
 * POST /api/borrows — borrow a book.
 * Body: { bookId: string }. Identity and ownership come exclusively from the
 * verified Better Auth JWT, never from the request body.
 */
router.post("/", requireAuth, async (req, res) => {
  const bookId = parseId(requireString(req.body?.bookId, "bookId"), "bookId");

  // Create indexes up-front so the unique partial guard exists before the
  // first insert (and before any transaction is started).
  await Promise.all([getBooksCollection(), getBorrowsCollection()]);

  let record;
  if (await supportsTransactions()) {
    const session = getMongoClient().startSession();
    try {
      await session.withTransaction(async () => {
        record = await borrowOne({ bookId, user: req.user, session });
      });
    } finally {
      await session.endSession();
    }
  } else {
    record = await borrowOne({ bookId, user: req.user });
  }

  res.status(201).json({
    message: "Book borrowed successfully.",
    borrow: toApiBorrow(record),
  });
});

/**
 * GET /api/borrows — the authenticated user's borrow records, newest first.
 * A `userEmail` query parameter is deliberately ignored: identity is taken
 * from the verified token, so other users' records cannot be leaked.
 */
router.get("/", requireAuth, async (req, res) => {
  const borrows = await getBorrowsCollection();
  const docs = await borrows
    .find({ userEmail: req.user.email })
    .sort({ borrowDate: -1, _id: -1 })
    .toArray();

  res.json({ borrows: docs.map(toApiBorrow) });
});

/**
 * DELETE /api/borrows/:id — return a borrowed book.
 * Restores one available copy via $inc and flips the record to "returned".
 */
router.delete("/:id", requireAuth, async (req, res) => {
  const borrowId = parseId(req.params.id, "id");

  // Ensure indexes exist up-front (mirrors the POST handler).
  await Promise.all([getBooksCollection(), getBorrowsCollection()]);

  let returned;
  if (await supportsTransactions()) {
    const session = getMongoClient().startSession();
    try {
      await session.withTransaction(async () => {
        returned = await returnOne({ borrowId, user: req.user, session });
      });
    } finally {
      await session.endSession();
    }
  } else {
    returned = await returnOne({ borrowId, user: req.user });
  }

  res.json({
    message: "Book returned successfully.",
    borrow: toApiBorrow(returned),
  });
});

export default router;
