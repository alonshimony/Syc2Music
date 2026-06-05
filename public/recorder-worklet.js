// AudioWorkletProcessor that forwards mono PCM frames (Float32) to the main thread.
// Runs on the audio render thread, so timing is tight and glitch-free.
class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      // Copy: the underlying buffer is reused by the engine after process() returns.
      this.port.postMessage(input[0].slice(0));
    }
    return true; // keep the processor alive
  }
}

registerProcessor("recorder-processor", RecorderProcessor);
