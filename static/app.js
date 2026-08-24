// Thin audio glue only — all protocol logic (Hamming encode/decode,
// bitstream <-> tone mapping) lives server-side in app.py.

let audioCtx = null;
let CONFIG = null;
let detectedTones = [];

// Throughput measurement — timed entirely on the receiver's own clock.
// Transmitter and receiver are meant to be separate devices/tabs with no
// shared clock, so timing can't rely on anything the transmitter recorded;
// instead we time from the first data tone the receiver detects to the
// last one, which also naturally excludes START/STOP tone time.
let rxDataStartTime = null; // when the first data tone was detected
let rxLastBitTime = null;   // when the last data tone was detected

function getAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

async function getConfig() {
  if (!CONFIG) {
    const res = await fetch('/api/config');
    CONFIG = await res.json();
  }
  return CONFIG;
}

// --- TRANSMITTER ---
async function transmitMessage() {
  const { cfg, sequence } = await getSignal();
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') await ctx.resume();

  let now = ctx.currentTime;
  sequence.forEach((freq) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.8, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + cfg.toneDur - 0.02);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + cfg.toneDur);
    now += cfg.toneDur + cfg.interToneGap;
  });
}

async function getSignal() {
  const cfg = await getConfig();
  const bits = document.getElementById('txMsg').value.trim();
  const errIdx = parseInt(document.getElementById('txErr').value, 10);
  const res = await fetch('/api/transmit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bits, errIdx })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Transmit failed');
  }
  return { cfg, sequence: (await res.json()).sequence };
}

function writeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  writeString(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE'); writeString(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeString(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true));
  return new Blob([view], { type: 'audio/wav' });
}

async function downloadSignal() {
  const { cfg, sequence } = await getSignal();
  const sampleRate = 44100;
  const frameDuration = cfg.toneDur + cfg.interToneGap;
  const offline = new OfflineAudioContext(1, Math.ceil(sequence.length * frameDuration * sampleRate), sampleRate);
  sequence.forEach((freq, index) => {
    const oscillator = offline.createOscillator();
    const gain = offline.createGain();
    const start = index * frameDuration;
    oscillator.frequency.value = freq;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.8, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + cfg.toneDur - 0.02);
    oscillator.connect(gain); gain.connect(offline.destination);
    oscillator.start(start); oscillator.stop(start + cfg.toneDur);
  });
  const rendered = await offline.startRendering();
  const blob = writeWav(rendered.getChannelData(0), sampleRate);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'acoustic-modem-signal.wav';
  link.click();
  URL.revokeObjectURL(link.href);
}

// --- RECEIVER ---
async function startListening() {
  const cfg = await getConfig();
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') await ctx.resume();

  document.getElementById('rxStatus').innerText = 'Status: Requesting microphone...';
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096; // High frequency resolution
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Float32Array(bufferLength);

  document.getElementById('rxStatus').innerText = 'Status: Listening...';

  let lastDetectedFreq = 0;
  let toneHoldCount = 0;

  function matchTone(freq) {
    const all = [...cfg.freqs, cfg.startTone, cfg.stopTone, cfg.syncTone];
    for (const f of all) {
      if (Math.abs(f - freq) < 45) return f; // 45 Hz tolerance window
    }
    return null;
  }

  function handleReceivedTone(freq) {
    if (freq === cfg.startTone) {
      detectedTones = [];
      rxDataStartTime = null;
      rxLastBitTime = null;
      document.getElementById('rxStatus').innerText = 'Status: Receiving Frame...';
    } else if (freq === cfg.stopTone) {
      document.getElementById('rxStatus').innerText = 'Status: Frame Received. Processing...';
      decodeFrame(detectedTones);
    } else if (freq === cfg.syncTone) {
      // Sync marker only — sent before every data tone so that two
      // consecutive identical symbols are always separated by a frequency
      // edge (otherwise they'd be indistinguishable from one long tone).
    } else {
      const octalVal = cfg.freqs.indexOf(freq);
      if (octalVal !== -1) {
        if (rxDataStartTime === null) rxDataStartTime = ctx.currentTime; // first data tone
        detectedTones.push(octalVal);
        rxLastBitTime = ctx.currentTime; // moment this data tone was confirmed
      }
    }
  }

  function processAudio() {
    analyser.getFloatFrequencyData(dataArray);

    // Find peak frequency bin
    let maxVal = -Infinity;
    let maxIndex = -1;
    for (let i = 0; i < bufferLength; i++) {
      if (dataArray[i] > maxVal) {
        maxVal = dataArray[i];
        maxIndex = i;
      }
    }

    const nyquist = ctx.sampleRate / 2;
    const peakFreq = maxIndex * (nyquist / bufferLength);

    // Detect valid tone threshold. Manual gain control can produce quieter
    // microphone input, especially when the speaker and receiver are apart.
    if (maxVal > -75) {
      const matchedFreq = matchTone(peakFreq);
      if (matchedFreq !== null) {
        if (matchedFreq === lastDetectedFreq) {
          toneHoldCount++;
          // Debounce check: ensure tone is held steady
          if (toneHoldCount === 4) {
            handleReceivedTone(matchedFreq);
          }
        } else {
          lastDetectedFreq = matchedFreq;
          toneHoldCount = 0;
        }
      } else {
        lastDetectedFreq = 0;
        toneHoldCount = 0;
      }
    } else {
      lastDetectedFreq = 0;
      toneHoldCount = 0;
    }
    requestAnimationFrame(processAudio);
  }
  processAudio();
}

async function decodeFrame(octalArray) {
  const res = await fetch('/api/receive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ octalArray })
  });
  const { decodedMessage, errorIndex } = await res.json();

  let outputHTML = '';
  for (let i = 0; i < decodedMessage.length; i++) {
    if (i === errorIndex) {
      outputHTML += `<span class="underlined">${decodedMessage[i]}</span>`;
    } else {
      outputHTML += decodedMessage[i];
    }
  }

  document.getElementById('rxOutput').innerHTML = `Decoded: ${outputHTML} (Err Bit: ${errorIndex})`;

  const throughputEl = document.getElementById('rxThroughput');
  if (throughputEl) {
    if (rxDataStartTime !== null && rxLastBitTime !== null && rxLastBitTime > rxDataStartTime) {
      const bitCount = octalArray.length * 3; // 3 bits per detected tone
      const seconds = rxLastBitTime - rxDataStartTime;
      const bps = bitCount / seconds;
      throughputEl.innerText = `Throughput: ${bitCount} bits / ${seconds.toFixed(3)}s = ${bps.toFixed(2)} bps`;
    } else {
      throughputEl.innerText = 'Throughput: unavailable (need at least 2 data tones)';
    }
  }
}

document.getElementById('txBtn').addEventListener('click', transmitMessage);
document.getElementById('downloadBtn').addEventListener('click', () => {
  downloadSignal().catch((error) => alert(error.message));
});
document.getElementById('rxBtn').addEventListener('click', () => {
  startListening().catch((error) => {
    console.error('Receiver could not start:', error);
    document.getElementById('rxStatus').innerText = `Status: Microphone error (${error.name || 'unknown'})`;
  });
});
