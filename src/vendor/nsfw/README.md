# Explicit-image model

Used by `src/screen-worker.js` to check photos on the device before Cloud sync. Nothing is sent
anywhere to run it.

- `model.json`, `group1-shard1of1.bin`: the MobileNetV2 model from [NSFWJS](https://github.com/infinitered/nsfwjs)
  4.3.0 (MIT, `LICENSE-nsfwjs`), converted from the package's bundled JavaScript copies. Input 224×224
  RGB in [0, 1]; output scores for Drawing, Hentai, Neutral, Porn, Sexy.
- `tf.min.js`: [TensorFlow.js](https://github.com/tensorflow/tfjs) 4.22.0 (Apache-2.0, `LICENSE-tfjs`).
