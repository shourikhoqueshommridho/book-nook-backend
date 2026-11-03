import { Router } from "express";
import { ObjectId } from "mongodb";
import { getBooksCollection, toApiBook } from "../database.js";
import { ApiError } from "../errors.js";
import { requireAuth } from "../auth.js";
import {
  BOOK_CATEGORIES,
  BOOK_SORTS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../constants.js";
import {
  optionalCount,
  optionalRating,
  optionalString,
  requireCover,
  requirePositiveCount,
  requireString,
} from "../validation.js";

const router = Router();

function parsePagination(query) {
  const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
  const parsedLimit = Number.parseInt(query.limit ?? String(DEFAULT_PAGE_SIZE), 10);
  const limit = Number.isNaN(parsedLimit)
    ? DEFAULT_PAGE_SIZE
    : Math.min(Math.max(1, parsedLimit), MAX_PAGE_SIZE);
  return { page, limit };
}

function parseSort(query) {
  const sort = query.sort ?? "newest";
  if (!Object.hasOwn(BOOK_SORTS, sort)) {
    throw new ApiError(
      400,
      `Invalid "sort" value. Valid values: ${Object.keys(BOOK_SORTS).join(", ")}.`
    );
  }
  return sort;
}

/** Build the MongoDB filter from q / category query parameters. */
function buildFilter(query) {
  const filter = {};
  const q = typeof query.q === "string" ? query.q.trim() : "";
  if (q) {
    const pattern = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { title: { $regex: pattern, $options: "i" } },
      { author: { $regex: pattern, $options: "i" } },
    ];
  }
  const categories = (query.category ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (categories.length > 0) {
    for (const value of categories) {
      if (!BOOK_CATEGORIES.includes(value)) {
        throw new ApiError(
          400,
          `Unknown category "${value}". Valid categories: ${BOOK_CATEGORIES.join(", ")}.`
        );
      }
    }
    filter.category = { $in: categories };
  }
  return filter;
}

/* GET /api/books?q=&category=&sort=&page=&limit=[&mine=true]
   Public by default. `mine=true` switches to the authenticated user's own
   books — the email comes from the verified JWT, never from query params. */
router.get("/", async (req, res) => {
  const mine = req.query.mine === "true";
  if (mine) {
    // Inline auth gate: wraps requireAuth in a promise. Its third parameter
    // (Express `next`) receives an ApiError(401) on failure — rejected here —
    // or is called with no argument on success, which resolves the promise.
    await new Promise((resolve, reject) =>
      requireAuth(req, res, (error) => (error ? reject(error) : resolve()))
    );
  }

  const { page, limit } = parsePagination(req.query);
  const sort = parseSort(req.query);
  const filter = buildFilter(req.query);
  if (mine) {
    filter["addedBy.email"] = req.user.email;
  }

  const books = await getBooksCollection();
  const [total, docs] = await Promise.all([
    books.countDocuments(filter),
    books
      .find(filter)
      .sort(BOOK_SORTS[sort])
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
  ]);

  res.json({
    books: docs.map(toApiBook),
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
});

function parseId(id) {
  if (!ObjectId.isValid(id)) {
    throw new ApiError(400, `"${id}" is not a valid book id.`);
  }
  return new ObjectId(id);
}

/* GET /api/books/:id */
router.get("/:id", async (req, res) => {
  const books = await getBooksCollection();
  const doc = await books.findOne({ _id: parseId(req.params.id) });
  if (!doc) {
    throw new ApiError(404, `No book found with id "${req.params.id}".`);
  }
  res.json({ book: toApiBook(doc) });
});

function buildBookDocument(body, { partial }) {
  const doc = {};

  if (!partial || body.title !== undefined) {
    doc.title = requireString(body.title, "title");
  }
  if (!partial || body.author !== undefined) {
    doc.author = requireString(body.author, "author");
  }
  if (!partial || body.category !== undefined) {
    doc.category = requireString(body.category, "category");
    if (!BOOK_CATEGORIES.includes(doc.category)) {
      throw new ApiError(
        400,
        `"category" must be one of: ${BOOK_CATEGORIES.join(", ")}.`
      );
    }
  }
  if (!partial || body.cover !== undefined) {
    doc.cover = requireCover(body.cover);
  }

  const description = optionalString(body.description, "description");
  if (description !== undefined) doc.description = description;
  if (body.rating !== undefined) doc.rating = optionalRating(body.rating);
  if (body.copies !== undefined) doc.copies = optionalCount(body.copies, "copies");
  if (body.copiesAvailable !== undefined) {
    doc.copiesAvailable = optionalCount(body.copiesAvailable, "copiesAvailable");
  }

  doc.updatedAt = new Date();
  return doc;
}

/* POST /api/books — protected: JWT verified against Better Auth JWKS,
   ownership is taken from the token, never from the request body. */
router.post("/", requireAuth, async (req, res) => {
  const doc = buildBookDocument(req.body, { partial: false });
  doc.rating = optionalRating(req.body.rating);
  // A new borrowable book must have at least one copy...
  doc.copies = requirePositiveCount(req.body.copies ?? req.body.totalCopies);
  // ...and fresh books start with all copies available.
  doc.copiesAvailable = doc.copies;
  // Assignment-required description field.
  doc.description = requireString(req.body.description, "description");
  // Ownership from the verified JWT — client-sent addedBy/email is ignored.
  doc.addedBy = { name: req.user.name, email: req.user.email };
  doc.createdAt = new Date();

  const books = await getBooksCollection();
  const result = await books.insertOne(doc);
  const stored = await books.findOne({ _id: result.insertedId });
  res.status(201).json({ book: toApiBook(stored) });
});

/* PATCH /api/books/:id — owner-only.
   Identity comes from the verified JWT (never a client-sent body field).
   Editable fields are whitelisted by buildBookDocument, so client attempts
   to write protected server-controlled fields — _id, addedBy, createdAt —
   are safely ignored and can never be persisted. */
router.patch("/:id", requireAuth, async (req, res) => {
  const books = await getBooksCollection();
  const bookId = parseId(req.params.id);

  const existing = await books.findOne(
    { _id: bookId },
    { projection: { addedBy: 1 } }
  );
  if (!existing) {
    throw new ApiError(404, `No book found with id "${req.params.id}".`);
  }
  if (existing.addedBy?.email !== req.user.email) {
    throw new ApiError(
      403,
      "You can only edit books you added to the library."
    );
  }

  const doc = buildBookDocument(req.body, { partial: true });
  const updated = await books.findOneAndUpdate(
    { _id: bookId },
    { $set: doc },
    { returnDocument: "after" }
  );
  if (!updated) {
    throw new ApiError(404, `No book found with id "${req.params.id}".`);
  }
  res.json({ book: toApiBook(updated) });
});

/* DELETE /api/books/:id — owner-only. Never lets one user delete a book
   added by another user. */
router.delete("/:id", requireAuth, async (req, res) => {
  const books = await getBooksCollection();
  const bookId = parseId(req.params.id);

  const existing = await books.findOne(
    { _id: bookId },
    { projection: { addedBy: 1 } }
  );
  if (!existing) {
    throw new ApiError(404, `No book found with id "${req.params.id}".`);
  }
  if (existing.addedBy?.email !== req.user.email) {
    throw new ApiError(
      403,
      "You can only delete books you added to the library."
    );
  }

  const result = await books.deleteOne({ _id: bookId });
  if (result.deletedCount === 0) {
    throw new ApiError(404, `No book found with id "${req.params.id}".`);
  }
  res.json({ deleted: true, id: req.params.id });
});

export default router;
