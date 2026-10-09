# Third-party assets

OpenCapture downloads the following pinned assets at build time. `assets-manifest.json`
records the authoritative HTTPS URL, byte size, archive hash, extracted-file hashes,
and destination for each file. The build fails if any of those checks do not match.

## eSearch OCR model releases

- Components: PaddleOCR v6 small detection/recognition model, Korean recognition
  model and dictionary, and document-orientation classifier.
- Upstream: https://github.com/xushengfeng/eSearch-OCR
- Release assets: 4.0.0 and 8.1.0, as pinned in `assets-manifest.json`.
- Repository license: Apache License 2.0.
- Model ancestry: PaddleOCR/PaddlePaddle. The release repository identifies the
  distributed model project under Apache-2.0; retain upstream notices when adding
  or replacing models.

## eSearch segmentation model

- Component: `seg.onnx` background-segmentation model.
- Upstream: https://github.com/xushengfeng/eSearch-seg
- Release: 1.0.0.
- Repository license: Apache License 2.0.

## FFmpeg

- Component: FFmpeg 6.1 Windows x64 executable from the upstream eSearch release.
- Source release: https://github.com/xushengfeng/eSearch/releases/tag/13.0.0-beta.1
- FFmpeg licensing information and source links: https://ffmpeg.org/legal.html
- Distributed build label: GPL; the archive's `LICENSE.txt` is installed alongside
  `ffmpeg.exe`. OpenCapture is GPL-3.0 licensed.

## Windows clipboard integration

- The original `copy.exe` helper is excluded from OpenCapture distribution.
- Selected-text copying uses the existing uiohook-napi keyboard integration.

## U2Net small background removal

- Model: U2NetP by Xuebin Qin et al.; Apache-2.0 repository license.
- Source: https://github.com/xuebinqin/U-2-Net
- ONNX conversion distributed by rembg: https://github.com/danielgatis/rembg
- The manifest pins the model's SHA256 and size; MD5 also matches rembg's published checksum.

## Embedded local translation

- Python 3.12.10 (PSF), CTranslate2 4.8.2 (MIT), SentencePiece 0.2.2 (Apache-2.0), NumPy 2.2.6 (BSD-3-Clause).
- Runtime download URLs and hashes are recorded by scripts/prepare-translation.py and the embedded runtime manifest. Wheel license files remain included.
- Argos English/Korean 1.1 models are downloaded only after an explicit user action. They are not bundled; their source README/attributions are retained with the installed models. Model redistribution terms are not inferred from the Argos code license.

## Application provenance

- Fork of https://github.com/xushengfeng/eSearch at commit 68ad11636392f204085efa81caab0b3d19e4dc28 (GPL-3.0).
- The upstream LICENSE and authorship are retained. OpenCapture adds the Korean launcher, collections, local translation runtime/service, pin comparison controls and capture extensions.

No other downloaded models are part of the default bundle. In particular, optional
models offered by application settings must be reviewed and explicitly added to the
manifest before a release may package them.
