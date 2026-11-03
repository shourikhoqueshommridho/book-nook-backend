
/**
 * BookNook API — Express server
 * Single-file backend with MongoDB connection.
 */

import "dotenv/config";
import express from "express";
import multer from "multer";
import { MongoClient, ObjectId } from "mongodb";
import { requireAuth, ApiError } from "./auth.js";

/* --- Server setup ------------------------------------------------------------ */

const app = express();
const PORT = process.env.PORT || 5000;

/* --- Domain constants -------------------------------------------------------- */

const DATABASE_NAME = "book-nook";
const BOOKS_COLLECTION = "books";

const BOOK_CATEGORIES = ["Fiction", "Science", "History", "Kids", "Others"];

const BOOK_SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  "title-asc": { title: 1 },
  "title-desc": { title: -1 },
  "rating-desc": { rating: -1, createdAt: -1 },
};

const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 60;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMGBB_UPLOAD_URL = "https://api.imgbb.com/1/upload";

/* --- MongoDB connection ------------------------------------------------------ */

if (!process.env.MONGODB_URI) {
  console.error("WARNING: MONGODB_URI is missing!");
}

const client = new MongoClient(process.env.MONGODB_URI ?? "", {
  serverSelectionTimeoutMS: 5000,
});

let dbPromise = null;
let indexesPromise = null;

function getDatabase() {
  if (!process.env.MONGODB_URI) {
    throw new ApiError(
      503,
      "Database not configured. Set MONGODB_URI in the backend .env file."
    );
  }

  if (!dbPromise) {
    dbPromise = client
      .connect()
      .then(() => {
        console.log("MongoDB connected successfully!");
        console.log(`Database: ${DATABASE_NAME}`);

        return client.db(DATABASE_NAME);
      })
      .catch((error) => {
        dbPromise = null;

        console.error("MongoDB connection failed:", error.message);

        throw new ApiError(
          503,
          "Could not connect to MongoDB.",
          error.message
        );
      });
  }

  return dbPromise;
}

/* --- Books collection -------------------------------------------------------- */

async function getBooksCollection() {
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

/* --- Date and response helpers ----------------------------------------------- */

function toISOString(value, fallback) {
  const date = value ? new Date(value) : fallback;

  if (Number.isNaN(date.getTime())) {
    return fallback.toISOString();
  }

  return date.toISOString();
}

function toApiBook(doc) {
  const createdAt = toISOString(doc.createdAt, new Date());
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

/* --- Request validation helpers ---------------------------------------------- */

function requireString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(
      400,
      `"${field}" is required and must be a non-empty string.`
    );
  }

  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null) return undefined;

  if (typeof value !== "string") {
    throw new ApiError(400, `"${field}" must be a string.`);
  }

  return value.trim();
}

function requireCover(value) {
  const cover = requireString(value, "cover");

  const isHttp = /^https?:\/\/\S+$/i.test(cover);
  const isLocalPath = cover.startsWith("/");

  if (!isHttp && !isLocalPath) {
    throw new ApiError(
      400,
      '"cover" must be an http(s) URL or a path starting with "/".'
    );
  }

  return cover;
}

function optionalRating(value) {
  if (value === undefined || value === null) return null;

  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 5
  ) {
    throw new ApiError(400, '"rating" must be a number between 0 and 5.');
  }

  return value;
}

function optionalCount(value, field) {
  if (value === undefined || value === null) return 0;

  if (!Number.isInteger(value) || value < 0) {
    throw new ApiError(
      400,
      `"${field}" must be a non-negative integer.`
    );
  }

  return value;
}

function requirePositiveCount(value, field = "copies") {
  if (!Number.isInteger(value) || value < 1) {
    throw new ApiError(
      400,
      `"${field}" must be a positive integer.`
    );
  }

  if (value > 10000) {
    throw new ApiError(
      400,
      `"${field}" can be at most 10000.`
    );
  }

  return value;
}

function parseId(id) {
  if (!ObjectId.isValid(id)) {
    throw new ApiError(400, `"${id}" is not a valid book id.`);
  }

  return new ObjectId(id);
}

/* --- Query helpers ----------------------------------------------------------- */

function parsePagination(query) {
  const page = Math.max(
    1,
    Number.parseInt(query.page ?? "1", 10) || 1
  );

  const parsedLimit = Number.parseInt(
    query.limit ?? String(DEFAULT_PAGE_SIZE),
    10
  );

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

  if (description !== undefined) {
    doc.description = description;
  }

  if (body.rating !== undefined) {
    doc.rating = optionalRating(body.rating);
  }

  if (body.copies !== undefined) {
    doc.copies = optionalCount(body.copies, "copies");
  }

  if (body.copiesAvailable !== undefined) {
    doc.copiesAvailable = optionalCount(
      body.copiesAvailable,
      "copiesAvailable"
    );
  }

  doc.updatedAt = new Date();

  return doc;
}

/* --- Image upload helpers ---------------------------------------------------- */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, callback) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/avif",
    ];

    if (allowed.includes(file.mimetype)) {
      callback(null, true);
      return;
    }

    callback(
      new ApiError(
        400,
        "Unsupported image type. Use JPG, PNG, GIF, WebP, or AVIF."
      )
    );
  },
});

function assertRealImage(buffer) {
  const jpeg =
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff;

  const png =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;

  const gif =
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46;

  const webp =
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP";

  const avif =
    buffer.subarray(4, 12).toString("ascii") === "ftypavif";

  if (!jpeg && !png && !gif && !webp && !avif) {
    throw new ApiError(
      400,
      "This file is not a real image. Please choose a valid image file."
    );
  }
}

async function uploadToImgbb(buffer) {
  const apiKey = process.env.IMGBB_API_KEY;

  if (!apiKey) {
    throw new ApiError(
      503,
      "Image upload is not configured. Set IMGBB_API_KEY in the backend .env file."
    );
  }

  let response;

  try {
    const form = new FormData();
    form.append("image", buffer.toString("base64"));

    response = await fetch(`${IMGBB_UPLOAD_URL}?key=${apiKey}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw new ApiError(
      502,
      `Image upload to imgbb failed: ${error.message}`
    );
  }

  const result = (await response.json().catch(() => null)) ?? null;

  if (!response.ok || !result?.success || !result?.data?.url) {
    const detail =
      result?.error?.message ?? response.status ?? "Unknown error";

    throw new ApiError(
      response.ok ? 502 : response.status,
      `Image upload to imgbb failed: ${detail}`
    );
  }

  return result;
}

/* --- Middleware -------------------------------------------------------------- */

const corsOrigin = process.env.CORS_ORIGIN ?? "*";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

app.use(express.json({ limit: "1mb" }));

/* --- Routes ------------------------------------------------------------------ */

// Health check
app.get("/api/health", async (_req, res) => {
  try {
    await getDatabase();

    res.json({
      status: "ok",
      database: "connected",
    });
  } catch (error) {
    console.error("Health check failed:", error.message);

    res.status(503).json({
      status: "error",
      database: "unavailable",
    });
  }
});

// Get all books
app.get("/api/books", async (req, res) => {
  const { page, limit } = parsePagination(req.query);
  const sort = parseSort(req.query);
  const filter = buildFilter(req.query);

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

// Get a single book
app.get("/api/books/:id", async (req, res) => {
  const books = await getBooksCollection();

  const doc = await books.findOne({
    _id: parseId(req.params.id),
  });

  if (!doc) {
    throw new ApiError(
      404,
      `No book found with id "${req.params.id}".`
    );
  }

  res.json({ book: toApiBook(doc) });
});

// Create a book
app.post("/api/books", requireAuth, async (req, res) => {
  const doc = buildBookDocument(req.body, { partial: false });

  doc.rating = optionalRating(req.body.rating);
  doc.copies = requirePositiveCount(
    req.body.copies ?? req.body.totalCopies
  );
  doc.copiesAvailable = doc.copies;
  doc.description = requireString(req.body.description, "description");

  doc.addedBy = {
    name: req.user.name,
    email: req.user.email,
  };

  doc.createdAt = new Date();

  const books = await getBooksCollection();

  const result = await books.insertOne(doc);

  const stored = await books.findOne({
    _id: result.insertedId,
  });

  res.status(201).json({
    book: toApiBook(stored),
  });
});

// Update a book
app.patch("/api/books/:id", async (req, res) => {
  const doc = buildBookDocument(req.body, { partial: true });

  const books = await getBooksCollection();

  const updated = await books.findOneAndUpdate(
    { _id: parseId(req.params.id) },
    { $set: doc },
    { returnDocument: "after" }
  );

  if (!updated) {
    throw new ApiError(
      404,
      `No book found with id "${req.params.id}".`
    );
  }

  res.json({ book: toApiBook(updated) });
});

// Delete a book
app.delete("/api/books/:id", async (req, res) => {
  const books = await getBooksCollection();

  const result = await books.deleteOne({
    _id: parseId(req.params.id),
  });

  if (result.deletedCount === 0) {
    throw new ApiError(
      404,
      `No book found with id "${req.params.id}".`
    );
  }

  res.json({
    deleted: true,
    id: req.params.id,
  });
});

// Get categories
app.get("/api/categories", async (_req, res) => {
  const books = await getBooksCollection();
  const distinct = await books.distinct("category");

  const categories =
    distinct.length > 0
      ? BOOK_CATEGORIES.filter((category) =>
          distinct.includes(category)
        ).concat(
          distinct.filter(
            (category) => !BOOK_CATEGORIES.includes(category)
          )
        )
      : BOOK_CATEGORIES;

  res.json({ categories });
});

// Upload image
app.post(
  "/api/uploads/image",
  requireAuth,
  (req, res, next) => {
    upload.single("image")(req, res, (error) => next(error));
  },
  async (req, res) => {
    const file = req.file;

    if (!file) {
      throw new ApiError(
        400,
        'No image received. Send multipart/form-data with an "image" field.'
      );
    }

    if (file.size === 0) {
      throw new ApiError(400, "The uploaded file is empty.");
    }

    assertRealImage(file.buffer);

    const result = await uploadToImgbb(file.buffer);

    res.status(201).json({
      url: result.data.url,
      thumb: result.data.thumb?.url ?? null,
      deleteUrl: result.data.delete_url ?? null,
      uploadedBy: req.user.email,
    });
  }
);

/* --- Unknown API routes ------------------------------------------------------ */

app.use("/api", (_req, _res, next) => {
  next(new ApiError(404, "API endpoint not found."));
});

/* --- Central error handler --------------------------------------------------- */

app.use((error, _req, res, _next) => {
  const status = error instanceof ApiError ? error.status : 500;

  if (status === 500) {
    console.error("Unexpected API error:", error);
  }

  res.status(status).json({
    error: error.message ?? "Internal server error.",
    ...(error.details ? { details: error.details } : {}),
  });
});

/* --- Server startup ---------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(`BookNook API listening on http://localhost:${PORT}`);
});
