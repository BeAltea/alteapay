# AlteaPay v2 — single image for web (Next.js) and BullMQ workers.
# Web:     CMD (next start)
# Workers: command ["npx","tsx","lib/queue/start-workers.ts"] (k8s overrides)
#
# NEXT_PUBLIC_* are baked into the client bundle at build time — pass the
# browser-facing values (e.g. http://127.0.0.1:54321 for local Supabase) as
# build args. Server-side code uses SUPABASE_URL at runtime instead.
FROM node:20-bookworm-slim AS base
RUN npm install -g pnpm@10
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM build AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1
RUN groupadd -g 1001 app && useradd -u 1001 -g app -m app \
    && chown -R app:app /app/.next
USER 1001
EXPOSE 3000
CMD ["pnpm", "start"]
