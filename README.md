# BookNook monorepo

This GitHub repository contains two independently deployed applications:

- `book-nook-frontend/` — Next.js 16 frontend and Better Auth routes.
- `book-nook-backend/` — Express API, deployed separately.

The top-level `src/`, `index.js`, `auth.js`, and `package.json` are a legacy
backend copy. They are retained in the repository, but the repository root is
not a Vercel application and must not be selected as either Vercel project's
Root Directory.

## Vercel projects

Connect both Vercel projects to this GitHub repository and keep their roots
fixed:

| Vercel project | Root Directory | Framework |
| --- | --- | --- |
| `book-nook-frontend` | `book-nook-frontend` | Next.js |
| `book-nook-backend` | `book-nook-backend` | Express / Node.js |

The frontend and backend each have a `vercel.json` inside their own app
directory. The repository-root `vercel.json` now skips root-based deployments;
it previously pointed at the legacy Express copy and could make a root-based
deployment build the backend instead of Next.js.

Vercel's Root Directory is a project setting, not a `vercel.json` property.
Set it in each project's **Settings → Build and Deployment → Root Directory**.
Once configured, GitHub pushes continue to deploy each project from its own
directory; a commit cannot change that setting. Keep **Include source files
outside the Root Directory** disabled for both projects.

Configure `BACKEND_API_URL` on the frontend Vercel project to the backend's
HTTPS origin. The frontend proxies the Express API through same-origin `/api/*`
routes while Better Auth keeps ownership of `/api/auth/*`.
