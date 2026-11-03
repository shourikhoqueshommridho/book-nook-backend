
import { MongoClient } from "mongodb";
import { ApiError } from "./errors.js";
import {
  BOOKS_COLLECTION,
  BORROWS_COLLECTION,
  DATABASE_NAME,
} from "./constants.js";

const client = new MongoClient(process.env.MONGODB_URI ?? "", {
  serverSelectionTimeoutMS: 5000,
});

let dbPromise = null;
let indexesPromise = null;
let borrowIndexesPromise = null;

/**
 * Lazily connect once and return the database.
 */
export function getDatabase() {
  if (!process.env.MONGODB_URI) {
    throw new ApiError(
      503,
      "Database not configured. Set MONGODB_URI in the backend .env file."
    );
  }

  if (!dbPromise) {
    dbPromise = client
      .connect()
      .then(() => client.db(DATABASE_NAME))
      .catch((error) => {
        dbPromise = null;

        throw new ApiError(
          503,
          "Could not connect to MongoDB.",
          error.message
        );
      });
  }

  return dbPromise;
}

/** Direct client handle — used by the borrow system for sessions/transactions. */
export function getMongoClient() {
  return client;
}

/** Close the pooled client (only used by the test suite teardown). */
export async function closeDatabase() {
  if (dbPromise) {
    dbPromise = null;
    indexesPromise = null;
    borrowIndexesPromise = null;
    await client.close();
  }
}

/**
 * Get the borrows collection and create its indexes once.
 *
 * The unique partial index is the real duplicate-borrow guard: only ONE
 * active borrow per (bookId, userEmail) can ever exist, even under racing
 * requests or code paths that skip the application-level check.
 */
export async function getBorrowsCollection() {
  const db = await getDatabase();
  const borrows = db.collection(BORROWS_COLLECTION);

  if (!borrowIndexesPromise) {
    borrowIndexesPromise = borrows
      .createIndexes([
        // GET /api/borrows — newest first per user.
        { key: { userEmail: 1, borrowDate: -1 } },
        // DELETE /api/borrows/:id — find a book's borrows when returning.
        { key: { bookId: 1 } },
        // The duplicate-borrow guard: one active borrow per user per book.
        {
          key: { bookId: 1, userEmail: 1 },
          name: "unique_active_borrow_per_book_user",
          unique: true,
          partialFilterExpression: { status: "active" },
        },
      ])
      .catch((error) => {
        borrowIndexesPromise = null;
        throw error;
      });
  }

  await borrowIndexesPromise;

  return borrows;
}

/**
 * Get books collection and create indexes once.
 */
export async function getBooksCollection() {
  const db = await getDatabase();
  const books = db.collection(BOOKS_COLLECTION);

  if (!indexesPromise) {
    indexesPromise = books
      .createIndexes([
        { key: { title: 1 } },
        { key: { author: 1 } },
        { key: { category: 1 } },
        { key: { createdAt: -1 } },
        { key: { rating: -1 } },
      ])
      .catch((error) => {
        indexesPromise = null;
        throw error;
      });
  }

  await indexesPromise;

  return books;
}

/**
 * Safely convert MongoDB date values into ISO strings.
 */
function toISOString(value, fallback) {
  const date = value ? new Date(value) : fallback;

  if (Number.isNaN(date.getTime())) {
    return fallback.toISOString();
  }

  return date.toISOString();
}

/**
 * Convert MongoDB document into API response format.
 */
export function toApiBook(doc) {
  const now = new Date();

  const createdAt = toISOString(doc.createdAt, now);
  const updatedAt = toISOString(doc.updatedAt, new Date(createdAt));

  return {
    id: doc._id.toString(),
    title: doc.title,
    author: doc.author,
    category: doc.category,
    cover: doc.cover,
    description: doc.description ?? "",
    rating: typeof doc.rating === "number" ? doc.rating : null,
    copies: doc.copies ?? 0,
    copiesAvailable: doc.copiesAvailable ?? 0,
    addedBy:
      doc.addedBy && typeof doc.addedBy === "object"
        ? {
            name: doc.addedBy.name ?? "",
            email: doc.addedBy.email ?? "",
          }
        : undefined,
    createdAt,
    updatedAt,
  };
}

/**
 * Convert a MongoDB borrows document into the API response format.
 */
export function toApiBorrow(doc) {
  const createdAt = new Date();

  return {
    id: doc._id.toString(),
    bookId: doc.bookId.toString(),
    bookTitle: doc.bookTitle,
    bookImage: doc.bookImage,
    userEmail: doc.userEmail,
    borrowDate: toISOString(doc.borrowDate, createdAt),
    returnDate: doc.returnDate
      ? toISOString(doc.returnDate, createdAt)
      : null,
    status: doc.status,
  };
}
