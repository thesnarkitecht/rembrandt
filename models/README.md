# On-device AI models

All run locally in the browser through MediaPipe Tasks (TFLite, WebAssembly). Nothing is uploaded.

| File | Purpose | Source (Apache-2.0) |
|---|---|---|
| `depth.tflite` | relative depth (lens blur, depth masks) | `storage.googleapis.com/mediapipe-assets/mobilenetsweep_dptrigmqn384_unit_384_384_fp16quant_fp32input_opt.tflite` |
| `subject-person.tflite` | people segmentation | `storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite` |
| `subject-general.tflite` | 21-class scene segmentation (DeepLab v3) | `storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/latest/deeplab_v3.tflite` |
| `object.tflite` | click-to-select objects (MagicTouch) | `storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/latest/magic_touch.tflite` |
| `people.tflite` | People masks: hair, face skin, body skin, clothes (selfie multiclass segmenter) | `storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite` |
| `face.task` | face landmarks: Remove blemishes, People masks (eyes, irises, brows, lips, teeth), culling (closed eyes) | `storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task` |

## Super Resolution

Runs on the GPU through Rembrandt's own WebGPU / WebGL2 kernels (`src/ai/upscale.js`), not MediaPipe.

| File | Purpose | Source (BSD-3-Clause) |
|---|---|---|
| `sr-general-x4.bin` | Super Resolution and Restore: `realesr-general-x4v3` and `realesr-general-wdn-x4v3` (SRVGGNetCompact), converted to half precision | `github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/` |

Format: the 4 bytes `RSR1`, then the two networks one after the other, each as 34 layers of weights
`[out][in][3][3]`, biases `[out]` and (all but the last layer) PReLU slopes `[out]`, as little-endian
float16. Real-ESRGAN is Copyright (c) 2021 Xintao Wang, under the BSD 3-Clause license (`LICENSE-Real-ESRGAN`).

## AI Denoise

Runs on the same GPU kernels as Super Resolution (`src/ai/denoise.js`).

| File | Purpose | Source (MIT) |
|---|---|---|
| `denoise-ffdnet-color.bin` | AI Denoise: FFDNet for colour images (Zhang, Zuo & Zhang, IEEE TIP 2018), converted to half precision | `github.com/cszn/KAIR/releases/download/v1.0/ffdnet_color.pth` |

Format: the 4 bytes `RDN1`, then 12 layers of weights `[out][in][3][3]` and biases `[out]` as
little-endian float16 (13 → 96 → … → 96 → 12 channels, ReLU between layers, on the photo
pixel-unshuffled by 2 plus a noise-level map). KAIR is Copyright (c) 2019 Kai Zhang, under the MIT
license (`LICENSE-KAIR`).
