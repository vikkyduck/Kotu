# Локальные эмбеддинги для библиотеки Kotu.
#
# Зачем: индексация библиотеки не должна покидать сервер. Раньше векторы
# считал text-embedding-3-small за границей — из-за этого расшифровки
# приходилось маскировать уже на этапе индексации. Теперь вся векторизация
# локальная; за границу тексты уходят только в промптах лекций.
#
# Модель: intfloat/multilingual-e5-large (1024 измерения). У E5 префиксы
# обязательны: "passage: " для фрагментов, "query: " для запросов — без них
# качество поиска заметно падает.
import os

from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODEL_NAME = os.environ.get("EMBED_MODEL", "intfloat/multilingual-e5-large")

app = FastAPI()
model = SentenceTransformer(MODEL_NAME, device="cpu")


class EmbedRequest(BaseModel):
    texts: list[str]
    kind: str = "passage"  # passage | query


@app.get("/healthz")
def healthz():
    return {"status": "ok", "model": MODEL_NAME}


@app.post("/embed")
def embed(req: EmbedRequest):
    prefix = "query: " if req.kind == "query" else "passage: "
    prepared = [prefix + t for t in req.texts]
    vectors = model.encode(
        prepared,
        batch_size=8,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    return {"vectors": [v.tolist() for v in vectors]}
