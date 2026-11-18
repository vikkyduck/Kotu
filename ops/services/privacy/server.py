"""
Kotu — локальное распознавание персональных данных (natasha, русский язык).
Работает ТОЛЬКО внутри сервера: 127.0.0.1:9020, наружу не смотрит.
Нужен для того, чтобы имена пациентов заменялись плейсхолдерами ДО того,
как текст уйдёт в зарубежную модель на оформление (см. ARCHITECTURE.md §10).

POST /ner {"text": "..."} -> {"spans": [{"start": int, "stop": int, "text": str, "type": "PER"|"LOC"}]}
"""
from fastapi import FastAPI
from pydantic import BaseModel
from natasha import Segmenter, NewsEmbedding, NewsNERTagger, Doc

app = FastAPI()

_segmenter = Segmenter()
_ner_tagger = NewsNERTagger(NewsEmbedding())

# ORG намеренно не маскируем: правило продукта — имена людей, клички,
# города и адреса. Маскировать все организации значило бы резать читаемость.
MASKED_TYPES = {"PER", "LOC"}


class NerRequest(BaseModel):
    text: str


@app.get("/healthz")
def healthz():
    return {"status": "ok", "engine": "natasha"}


@app.post("/ner")
def ner(req: NerRequest):
    doc = Doc(req.text)
    doc.segment(_segmenter)
    doc.tag_ner(_ner_tagger)
    spans = [
        {"start": s.start, "stop": s.stop, "text": s.text, "type": s.type}
        for s in doc.spans
        if s.type in MASKED_TYPES
    ]
    spans.sort(key=lambda s: s["start"])
    return {"spans": spans}
