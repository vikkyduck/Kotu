---
name: OpenAI AI Integration proxy quirks
description: Non-obvious limits of the Replit-managed OpenAI integration proxy (AI_INTEGRATIONS_OPENAI_*)
---

# OpenAI AI Integration proxy quirks

- The proxy rejects `POST /audio/speech` (text-to-speech) with `INVALID_ENDPOINT` / "is not supported". Do not plan TTS through `AI_INTEGRATIONS_OPENAI_BASE_URL`.
  **Why:** discovered while trying to generate a test audio clip — wasted a round trip assuming OpenAI TTS would work.
  **How to apply:** to generate speech audio, use a different route (e.g. media-generation audio skill) or a real sample file; the proxy is fine for transcription (`/audio/transcriptions`) and chat/completions.

- Audio transcription via `gpt-4o-mini-transcribe` works and detects format from the uploaded filename — pass the original filename (with extension) when sending the buffer so no ffmpeg/format conversion is needed. Whisper-family upload cap is 25 MB.
