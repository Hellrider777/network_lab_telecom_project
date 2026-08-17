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
  const cfg = await getConfig();
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') await ctx.resume();

  const bits = document.getElementById('txMsg').value.trim();
  const errIdx = parseInt(document.getElementById('txErr').value, 10);
  const delaySec = Math.max(0, parseInt(document.getElementById('txDelay').value, 10) || 0) / 1000;
  const legacy = document.getElementById('txLegacy').checked;

  const res = await fetch('/api/transmit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bits, errIdx, legacy })
  });

  if (!res.ok) {
    const err = await res.json();
    alert(err.error || 'Transmit failed');
    return;
  }

  const { sequence } = await res.json();

  // The receiver detects tones by their acoustic presence (frequency held
  // steady for a few frames) rather than by sampling a fixed clock, and the
  // differential tone encoding guarantees a frequency edge before every
  // symbol — so it never needs to be told this delay; any gap here just works.
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
    now += cfg.toneDur + delaySec;
  });
}

// --- RECEIVER ---
async function startListening() {
  const cfg = await getConfig();
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') await ctx.resume();

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096; // High frequency resolution
  source.connect(analyser);

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Float32Array(bufferLength);

  document.getElementById('rxStatus').innerText = 'Status: Listening...';

  let lastDetectedFreq = 0;
  let toneHoldCount = 0;

  function matchTone(freq) {
    const all = [...cfg.freqs, cfg.startTone, cfg.stopTone];
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
    } else {
      // Every non-start/stop tone is a data tone now — differential
      // encoding guarantees it always differs from the previous tone, so
      // there's no separate sync marker to filter out.
      const toneIdx = cfg.freqs.indexOf(freq);
      if (toneIdx !== -1) {
        if (rxDataStartTime === null) rxDataStartTime = ctx.currentTime; // first data tone
        detectedTones.push(toneIdx);
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

    // Detect valid tone threshold (-55dB)
    if (maxVal > -55) {
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
      }
    } else {
      // Silence (e.g. a configurable inter-tone delay on the sender) is
      // itself a symbol boundary — treat it as such rather than letting
      // stale hold state carry across the gap.
      lastDetectedFreq = 0;
      toneHoldCount = 0;
    }
    requestAnimationFrame(processAudio);
  }
  processAudio();
}

async function decodeFrame(toneIndices) {
  const legacy = document.getElementById('rxLegacy').checked;
  const res = await fetch('/api/receive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toneIndices, legacy })
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
      const bitCount = toneIndices.length * 3; // 3 bits per detected tone
      const seconds = rxLastBitTime - rxDataStartTime;
      const bps = bitCount / seconds;
      throughputEl.innerText = `Throughput: ${bitCount} bits / ${seconds.toFixed(3)}s = ${bps.toFixed(2)} bps`;
    } else {
      throughputEl.innerText = 'Throughput: unavailable (need at least 2 data tones)';
    }
  }
}

document.getElementById('txBtn').addEventListener('click', transmitMessage);
document.getElementById('rxBtn').addEventListener('click', startListening);
