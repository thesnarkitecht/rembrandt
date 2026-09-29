# On-device AI models

All run locally in the browser through MediaPipe Tasks (TFLite, WebAssembly). Nothing is uploaded.

| File | Purpose | Source (Apache-2.0) |
|---|---|---|
| `depth.tflite` | relative depth (lens blur, depth masks) | `storage.googleapis.com/mediapipe-assets/mobilenetsweep_dptrigmqn384_unit_384_384_fp16quant_fp32input_opt.tflite` |
| `subject-person.tflite` | people segmentation | `storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite` |
| `subject-general.tflite` | 21-class scene segmentation (DeepLab v3) | `storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/latest/deeplab_v3.tflite` |
| `object.tflite` | click-to-select objects (MagicTouch) | `storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/latest/magic_touch.tflite` |
