import { Router } from "express";
import multer from "multer";
import { ApiError } from "../errors.js";
import { requireAuth } from "../auth.js";

const router = Router();


const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
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
const IMGBB_UPLOAD_URL = "https://api.imgbb.com/1/upload";
function assertRealImage(buffer) {
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
  const gif =
    buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46;
  const webp =
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP";
  const avif = buffer.subarray(4, 12).toString("ascii") === "ftypavif";

  if (!jpeg && !png && !gif && !webp && !avif) {
    throw new ApiError(
      400,
      "This file is not a real image. Please choose a valid image file."
    );
  }
}
router.post(
  "/image",
  requireAuth,
  (req, res, next) => {
    upload.single("image")(req, res, (error) => next(error));
  },
  async (req, res) => {
    const apiKey = process.env.IMGBB_API_KEY;
    if (!apiKey) {
      throw new ApiError(
        503,
        "Image upload is not configured. Set IMGBB_API_KEY in the backend .env file."
      );
    }

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

    let imgbbResponse;
    try {
      const form = new FormData();
      form.append("image", file.buffer.toString("base64"));
      imgbbResponse = await fetch(`${IMGBB_UPLOAD_URL}?key=${apiKey}`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ApiError(502, `Image upload to imgbb failed: ${error.message}`);
    }

    const result = (await imgbbResponse.json().catch(() => null)) ?? null;
    if (!imgbbResponse.ok || !result?.success || !result?.data?.url) {
      const detail =
        result?.error?.message ?? imgbbResponse.status ?? "Unknown error";
      throw new ApiError(
        imgbbResponse.ok ? 502 : imgbbResponse.status,
        `Image upload to imgbb failed: ${detail}`
      );
    }

    res.status(201).json({
      url: result.data.url,
      thumb: result.data.thumb?.url ?? null,
      deleteUrl: result.data.delete_url ?? null,
      uploadedBy: req.user.email,
    });
  }
);

export default router;
