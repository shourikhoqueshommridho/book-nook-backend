import { Router } from "express";
import { getBooksCollection } from "../database.js";
import { BOOK_CATEGORIES } from "../constants.js";

const router = Router();

/* GET /api/categories
   Returns the categories that can be used as filters. When the library
   is still empty (no books stored yet) the canonical five assignment
   categories are returned so the UI always has a complete filter list. */
router.get("/", async (_req, res) => {
  const books = await getBooksCollection();
  const distinct = await books.distinct("category");
  const categories = distinct.length > 0
    ? BOOK_CATEGORIES.filter((category) => distinct.includes(category)).concat(
        distinct.filter((category) => !BOOK_CATEGORIES.includes(category))
      )
    : BOOK_CATEGORIES;
  res.json({ categories });
});

export default router;
