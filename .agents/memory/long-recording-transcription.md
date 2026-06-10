---
name: Long recording transcription (chunking + background job)
description: How transcription handles files over the 25MB OpenAI limit, and why it runs as a polled background job.
---

# Long recording transcription

OpenAI's transcription endpoint rejects audio over 25MB (~1h). To accept 2–3h
recordings, the server splits oversized uploads with ffmpeg into mono mp3 segments
(re-encoded so each chunk's size is predictable and safely under the limit), then
transcribes + structures each chunk and stitches the segments in order.

**Why background + DB-polling instead of one request:** a 3h file → ~18 chunks →
~15 min of work, far too long to hold a single HTTP request open through the proxy.
The upload endpoint inserts the row as `status: "processing"` and returns 201
immediately; a fire-and-forget task updates `progress`/`statusMessage` on the row;
the client polls `GET /transcriptions/:id` (React Query `refetchInterval` while
processing) and renders the proc view from those fields.

**How to apply / gotchas:**
- New status columns on `transcriptions`: `status`, `progress`, `statusMessage`,
  `error`. They default to a finished state (`done`/100/""), so pre-existing rows
  and the small-file fast path stay correct.
- Multer uses **disk** storage (not memory) so large uploads don't blow RAM; the
  temp file is removed in the processing `finally` block.
- Per-chunk failures throw `ChunkError` (carries a friendly Russian `userMessage`
  naming which part failed); the route persists it to the row's `error`.
- Known limitation: an API server restart mid-job leaves a row stuck in
  `processing` (in-memory job, not a durable queue). Acceptable for current scale.
- Structuring is per-chunk (keeps each well under the model's output token limit);
  do not switch to structuring the whole transcript at once.
