import { ApiError } from "./errors.js";

/** Throws ApiError(400) when a required request field is invalid. */
export function requireString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, `"${field}" is required and must be a non-empty string.`);
  }
  return value.trim();
}

export function optionalString(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ApiError(400, `"${field}" must be a string.`);
  }
  return value.trim();
}

/** Cover must look like a URL or a root-relative image path. */
export function requireCover(value) {
  const cover = requireString(value, "cover");
  const isHttp = /^https?:\/\/\S+$/i.test(cover);
  const isLocalPath = cover.startsWith("/");
  if (!isHttp && !isLocalPath) {
    throw new ApiError(400, '"cover" must be an http(s) URL or a path starting with "/".');
  }
  return cover;
}

export function optionalRating(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 5) {
    throw new ApiError(400, '"rating" must be a number between 0 and 5.');
  }
  return value;
}

export function optionalCount(value, field) {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new ApiError(400, `"${field}" must be a non-negative integer.`);
  }
  return value;
}

/** Strictly positive integer — used for total copies on book creation. */
export function requirePositiveCount(value, field = "copies") {
  if (!Number.isInteger(value) || value < 1) {
    throw new ApiError(400, `"${field}" must be a positive integer.`);
  }
  if (value > 10000) {
    throw new ApiError(400, `"${field}" can be at most 10000.`);
  }
  return value;
}
