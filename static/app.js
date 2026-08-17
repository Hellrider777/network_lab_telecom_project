// Thin audio glue only — all protocol logic (Hamming encode/decode,
// bitstream <-> tone mapping) lives server-side in app.py.

let audioCtx = null;
let CONFIG = null;
let detectedTones = [];

// Throughput measurement (shared audio clock — both tx and rx run on the
// same page/AudioContext, so ctx.currentTime is a valid common timeline).
let txDataStartTime = null; // when the first tone after START begins playing
let txDataBitCount = 0;     // bits carried in the data phase (excludes START/STOP)
let rxLastBitTime = null;   // when the last data tone was actually detected

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

  const res = await fetch('/api/transmit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bits, errIdx })
  });

  if (!res.ok) {
    const err = await res.json();
    alert(err.error || 'Transmit failed');
    return;
  }

  const { sequence, finalBitstream } = await res.json();

  const scheduleStart = ctx.currentTime;
  // Data phase = everything between START and STOP; that's the window
  // throughput is measured over, so START/STOP tone time is excluded.
  txDataStartTime = scheduleStart + cfg.toneDur;
  txDataBitCount = finalBitstream.length;

  let now = scheduleStart;
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
    now += cfg.toneDur;
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
    const all = [...cfg.freqs, cfg.startTone, cfg.stopTone, cfg.syncTone];
    for (const f of all) {
      if (Math.abs(f - freq) < 45) return f; // 45 Hz tolerance window
    }
    return null;
  }

  function handleReceivedTone(freq) {
    if (freq === cfg.startTone) {
      detectedTones = [];
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
    if (txDataStartTime !== null && rxLastBitTime !== null && rxLastBitTime > txDataStartTime) {
      const seconds = rxLastBitTime - txDataStartTime;
      const bps = txDataBitCount / seconds;
      throughputEl.innerText = `Throughput: ${txDataBitCount} bits / ${seconds.toFixed(3)}s = ${bps.toFixed(2)} bps`;
    } else {
      throughputEl.innerText = 'Throughput: unavailable (play tones in this tab before listening)';
    }
  }
}

document.getElementById('txBtn').addEventListener('click', transmitMessage);
document.getElementById('rxBtn').addEventListener('click', startListening);
