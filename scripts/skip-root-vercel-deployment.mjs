console.log(
  "Skipping the repository root: set this Vercel project's Root Directory to book-nook-frontend or book-nook-backend."
);

// Vercel treats exit code 0 from ignoreCommand as a skipped deployment.
process.exitCode = 0;
