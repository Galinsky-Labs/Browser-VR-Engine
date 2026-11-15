// Minimal WebAudio spatialization for entity-attached emitters (M01/M02 preview).
// Starts only after an explicit user gesture; tones are synthesized, no media files.
export function createSpatialAudio() {
  let context = null;
  let master = null;
  let enabled = false;
  const voices = new Map();

  function voiceFor(sound) {
    let voice = voices.get(sound.node);
    if (voice) return voice;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const panner = new PannerNode(context, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: Math.max(0.1, Number(sound.data.refDistance) || 1), rolloffFactor: 1, maxDistance: 100 });
    oscillator.type = 'sine';
    oscillator.frequency.value = Math.min(4000, Math.max(40, Number(sound.data.frequency) || 220));
    gain.gain.value = Math.min(1, Math.max(0, Number(sound.data.gain) || 0.1));
    oscillator.connect(gain).connect(panner).connect(master);
    oscillator.start();
    voice = { oscillator, gain, panner };
    voices.set(sound.node, voice);
    return voice;
  }

  return {
    toggle() {
      if (!context) { context = new AudioContext(); master = context.createGain(); master.connect(context.destination); }
      enabled = !enabled;
      master.gain.setTargetAtTime(enabled ? 1 : 0, context.currentTime, 0.05);
      if (enabled) context.resume();
      return enabled;
    },
    reset() {
      for (const voice of voices.values()) { voice.oscillator.stop(); voice.oscillator.disconnect(); voice.panner.disconnect(); }
      voices.clear();
    },
    update(listenerPosition, forward, sounds) {
      if (!context || !enabled) return;
      const listener = context.listener;
      const t = context.currentTime;
      if (listener.positionX) {
        listener.positionX.setTargetAtTime(listenerPosition.x, t, 0.02);
        listener.positionY.setTargetAtTime(listenerPosition.y, t, 0.02);
        // The scene and WebAudio are both right-handed, so coordinates map directly.
        listener.positionZ.setTargetAtTime(listenerPosition.z, t, 0.02);
        listener.forwardX.setTargetAtTime(forward.x, t, 0.02);
        listener.forwardY.setTargetAtTime(forward.y, t, 0.02);
        listener.forwardZ.setTargetAtTime(forward.z, t, 0.02);
      }
      for (const sound of sounds) {
        const voice = voiceFor(sound);
        const p = sound.node.getAbsolutePosition();
        voice.panner.positionX.setTargetAtTime(p.x, t, 0.02);
        voice.panner.positionY.setTargetAtTime(p.y, t, 0.02);
        voice.panner.positionZ.setTargetAtTime(p.z, t, 0.02);
      }
    }
  };
}
