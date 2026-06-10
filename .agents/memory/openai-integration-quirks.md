---
name: OpenAI AI Integration proxy quirks
description: Non-obvious limits of the Replit-managed OpenAI integration proxy (AI_INTEGRATIONS_OPENAI_*)
---

# OpenAI AI Integration proxy quirks

- The proxy rejects `POST /audio/speech` (text-to-speech) with `INVALID_ENDPOINT` / "is not supported". Do not plan TTS through `AI_INTEGRATIONS_OPENAI_BASE_URL`.
  **Why:** discovered while trying to generate a test audio clip — wasted a round trip assuming OpenAI TTS would work.
  **How to apply:** to generate speech audio, use a different route (e.g. media-generation audio skill) or a real sample file; the proxy is fine for transcription (`/audio/transcriptions`) and chat/completions.

- Audio transcription (`gpt-4o-transcribe` and `-mini-transcribe`) detects format from the uploaded filename. Do NOT rely on that for broad format support — OpenAI only accepts a fixed format list, so sending an arbitrary user upload (e.g. an exotic codec, or a short-but-long-duration file) directly can fail. Instead always pre-normalize with ffmpeg to mp3 (see below), then the filename is always `.mp3` and detection is moot.
  **Limits:** 25 MB file cap AND a hard 1500-second (25-minute) duration cap per request (error: "audio duration N seconds is longer than 1500 seconds"). The duration cap, not file size, is usually the real bottleneck for real recordings.
  **How to apply:** always split/normalize server-side with ffmpeg (available) into time-based chunks (`-f segment -segment_time`) re-encoded to mono 16 kHz mp3 (`-ac 1 -ar 16000` — what speech models use internally, no quality loss, tiny files), transcribe chunks (bounded concurrency), then stitch. Doing this for EVERY upload (not just long ones) is what makes broad input formats — webm/opus, aac, amr, wma, video containers, … — work reliably. See `splitAudioIntoChunks` / `transcribeLongAudio` in `artifacts/api-server/src/lib/transcription.ts`. `gpt-4o-transcribe` is the higher-quality model and is accepted by the proxy.
