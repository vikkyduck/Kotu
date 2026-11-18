"""
Kotu — локальный транскрибатор.
faster-whisper large-v3-turbo (int8) в БАТЧЕВОМ режиме: на 8 vCPU этой ноды
даёт RTF ~0.2 против ~1.0 у последовательного декодера (замер 2026-07-22).
OpenAI-совместимый эндпоинт POST /v1/audio/transcriptions -> {"text": ...}
"""
import os
import tempfile

from faster_whisper import WhisperModel, BatchedInferencePipeline
from fastapi import FastAPI, File, Form, UploadFile

MODEL_NAME = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "ru")
THREADS = int(os.environ.get("WHISPER_THREADS", "8"))
BATCH = int(os.environ.get("WHISPER_BATCH", "8"))

app = FastAPI()
_model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", cpu_threads=THREADS)
pipeline = BatchedInferencePipeline(model=_model)


@app.get("/healthz")
def healthz():
    return {"status": "ok", "engine": "faster-whisper/batched", "model": MODEL_NAME, "batch": BATCH}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model_field: str | None = Form(default=None, alias="model"),
    language: str | None = Form(default=None),
):
    suffix = os.path.splitext(file.filename or "audio.mp3")[1] or ".mp3"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        path = tmp.name
    try:
        segments, _info = pipeline.transcribe(path, language=language or LANGUAGE, batch_size=BATCH)
        text = " ".join(s.text.strip() for s in segments)
        return {"text": text.strip()}
    finally:
        os.unlink(path)
