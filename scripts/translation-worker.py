#!/usr/bin/env python3
"""JSON-lines worker for direct inference with Argos translation packages."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

import ctranslate2
import sentencepiece as spm


MAX_TEXTS = 64
MAX_TEXT_LENGTH = 10_000
MAX_TOTAL_LENGTH = 40_000
_HANGUL = re.compile(r"[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]")


class ArgosModel:
    def __init__(self, package_dir: Path) -> None:
        model_dir = package_dir / "model"
        tokenizer_path = package_dir / "sentencepiece.model"
        if not model_dir.is_dir() or not tokenizer_path.is_file():
            raise ValueError(f"Invalid Argos package: {package_dir}")
        self.translator = ctranslate2.Translator(
            str(model_dir), device="cpu", compute_type="int8", inter_threads=1
        )
        self.tokenizer = spm.SentencePieceProcessor(model_file=str(tokenizer_path))

    def translate(self, texts: list[str]) -> list[str]:
        if not texts:
            return []
        tokenized = [self.tokenizer.encode(text, out_type=str) for text in texts]
        batches = self.translator.translate_batch(
            tokenized,
            replace_unknowns=True,
            max_batch_size=16,
            batch_type="tokens",
            beam_size=4,
            length_penalty=0.2,
        )
        return [
            self.tokenizer.decode_pieces(batch.hypotheses[0])
            .replace("▁", " ")
            .replace("_", " ")
            .lstrip()
            for batch in batches
        ]


class Worker:
    def __init__(self) -> None:
        self.models: dict[str, ArgosModel] = {}

    def _model(self, pair: str, models_dir: Path) -> ArgosModel:
        package_dir = (models_dir / pair).resolve()
        models_root = models_dir.resolve()
        if package_dir.parent != models_root:
            raise ValueError("Invalid language pair")
        key = str(package_dir)
        if key not in self.models:
            self.models[key] = ArgosModel(package_dir)
        return self.models[key]

    def handle(self, request: dict[str, Any]) -> list[str]:
        texts = request.get("texts")
        source = request.get("from", "auto")
        target = request.get("to")
        models_dir = Path(request.get("modelsDir", ""))
        if not isinstance(texts, list) or not all(isinstance(v, str) for v in texts):
            raise ValueError("texts must be an array of strings")
        if not texts or len(texts) > MAX_TEXTS:
            raise ValueError(f"texts must contain 1-{MAX_TEXTS} items")
        if any(len(v) > MAX_TEXT_LENGTH for v in texts) or sum(map(len, texts)) > MAX_TOTAL_LENGTH:
            raise ValueError("Translation request is too large")
        if source not in ("auto", "en", "ko") or target not in ("en", "ko"):
            raise ValueError("Only auto/en/ko to en/ko translation is supported")
        if not models_dir.is_dir():
            raise ValueError("Translation models are not installed")

        results = [""] * len(texts)
        groups: dict[str, list[tuple[int, str]]] = {}
        for index, text in enumerate(texts):
            detected = "ko" if source == "auto" and _HANGUL.search(text) else source
            if detected == "auto":
                detected = "en"
            if detected == target or not text.strip():
                results[index] = text
                continue
            pair = f"{detected}-{target}"
            if pair not in ("en-ko", "ko-en"):
                raise ValueError(f"Unsupported language pair: {pair}")
            groups.setdefault(pair, []).append((index, text))

        for pair, values in groups.items():
            translated = self._model(pair, models_dir).translate([v[1] for v in values])
            for (index, _), output in zip(values, translated, strict=True):
                results[index] = output
        return results


def emit(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> None:
    worker = Worker()
    for line in sys.stdin:
        request_id: Any = None
        try:
            request = json.loads(line.lstrip("\ufeff"))
            if not isinstance(request, dict):
                raise ValueError("Request must be an object")
            request_id = request.get("id")
            emit({"id": request_id, "translations": worker.handle(request)})
        except Exception as error:
            print(f"translation worker error: {error}", file=sys.stderr, flush=True)
            emit({"id": request_id, "error": str(error)})


if __name__ == "__main__":
    main()
