// AudioWorkletProcessor that forwards mono PCM frames (Float32) to the main thread,
// tagged with the audio-clock time (`currentTime`) of the render quantum they were
// captured in. That tag lets the main thread compute exactly when the first sample
// was captured, instead of when the message happened to arrive.
class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      // Copy: the underlying buffer is reused by the engine after process() returns.
      // `currentTime` is a global of AudioWorkletGlobalScope.
      this.port.postMessage({ samples: input[0].slice(0), time: currentTime });
    }
    return true; // keep the processor alive
  }
}

registerProcessor("recorder-processor", RecorderProcessor);
