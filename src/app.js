import "dotenv/config";
import express from "express";
import booksRouter from "./routes/books.js";
import categoriesRouter from "./routes/categories.js";
import uploadsRouter from "./routes/uploads.js";
import borrowsRouter from "./routes/borrows.js";
import { ApiError } from "./errors.js";


/**
 * The BookNook Express app. Kept separate from server.js so the test suite
 * can boot it on an ephemeral port without touching process.env.PORT.
 */
const app = express();
const PORT = process.env.PORT ?? 5000;

/* --- CORS (hand-rolled, no extra dependency) ------------------------------ */
const corsOrigin = process.env.CORS_ORIGIN ?? "*";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS"
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json({ limit: "1mb" }));

/* --- Routes ---------------------------------------------------------------- */
app.use("/api/books", booksRouter);
app.use("/api/categories", categoriesRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/borrows", borrowsRouter);

app.get("/api/health", async (_req, res) => {
  let database = "unavailable";
  try {
    await getDatabase();
    database = "connected";
  } catch {
    // Reported as "unavailable" because the status code still tells truth
  }
  res.json({ status: "ok", database });
});

/* Unknown API paths -> JSON 404 */
app.use("/api", (_req, _res, next) => {
  next(new ApiError(404, "API endpoint not found."));
});

/* Central error handler: ApiError keeps its status, anything else is a 500 */
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
app.get("/", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "Welcome to BookNook API!",
    status: "Server is running",
  });
});

export default app;
export { PORT };
