
export const DATABASE_NAME = process.env.MONGODB_DB ?? "book-nook";
export const BOOKS_COLLECTION = "books";
export const BORROWS_COLLECTION = "borrows";


export const BORROW_STATUS = {
  ACTIVE: "active",
  RETURNED: "returned",
};


export const BOOK_CATEGORIES = ["Fiction", "Science", "History", "Kids", "Others"];

/** Query sort keys understood by GET /api/books, mapped to MongoDB sorts. */
export const BOOK_SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  "title-asc": { title: 1 },
  "title-desc": { title: -1 },
  "rating-desc": { rating: -1, createdAt: -1 },
};

export const DEFAULT_PAGE_SIZE = 12;
export const MAX_PAGE_SIZE = 60;
