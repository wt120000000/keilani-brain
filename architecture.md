
### `ARCHITECTURE.md`
```md
# Architecture

**Front-end:** Framer site hitting Netlify Functions (this repo).  
**API:** Netlify Functions → OpenAI + Supabase + Stripe.  
**DB:** Supabase Postgres + pgvector for RAG.

## Chat flow
1. Client POST `/api/chat` with `X-User-Id` and `message`/`messages`.
2. CORS allowlist & OPTIONS handled.
3. Rate-limit (per-minute) + daily entitlement check.
4. RAG (optional): embed query → `rpc('match_kb')` → build context.
5. OpenAI chat completion.
6. Best-effort persistence of messages; daily usage bump.
7. Response includes `rag.used` & `rag.hits`.

## RAG schema (simplified)
`kb_chunks(id, title, source, chunk, embedding vector(1536), metadata jsonb, created_at)`  
Index: `kb_chunks_embedding_idx` on `embedding`  
RPC: `match_kb(query_embedding vector(1536), match_count int, similarity_threshold float)`

## Billing
- `/api/billing-checkout` creates Stripe Checkout Session (subscription).
- `/api/webhooks-stripe` updates `user_plans` on successful checkout / cancellation.
- Optional `/api/billing-portal` to manage/cancel.

## Retention
- Netlify cron runs `/api/purge-old` daily (deletes messages older than 90 days).
- Alternatively, pg_cron job in Supabase (we use Netlify cron).

## Privacy
- Anonymous `user_id` in browser.
- 90-day deletion by default; `/api/forget` to wipe sooner.
- CSP & CORS enforced.
