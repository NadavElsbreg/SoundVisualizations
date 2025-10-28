// app.js - Live audio visualization and recording for phone-oriented video export
(function () {
  const btnMic = document.getElementById('btn-mic');
  const btnRecord = document.getElementById('btn-record');
  const btnStop = document.getElementById('btn-stop');
  const preview = document.getElementById('preview');
  const downloadLink = document.getElementById('downloadLink');
  const preset = document.getElementById('preset');

  const canvas = document.getElementById('vis');
  const ctx = canvas.getContext('2d');
  const fileInput = document.getElementById('fileInput');
  const btnLoad = document.getElementById('btn-load');
  const filePlayer = document.getElementById('filePlayer');
  const widthSlider = document.getElementById('widthSlider');
  const lowColorEl = document.getElementById('lowColor');
  const midColorEl = document.getElementById('midColor');
  const highColorEl = document.getElementById('highColor');
  const filenameInput = document.getElementById('filenameInput');
  const btnConvertCli = document.getElementById('btn-convert-cli');
  const btnConvertBrowser = document.getElementById('btn-convert-browser');
  const convertStatusEl = document.getElementById('convertStatus');


  let audioCtx = null;
  let analyser = null;
  let micStream = null;
  let dataArray = null;
  let freqArray = null;
  let rafId = null;
  let currentSource = null; // AudioNode that's the current audio source (mic or media element)
  let sourceType = null; // 'mic' | 'file'
  let widthMultiplier = parseFloat(widthSlider ? widthSlider.value : 1);
  let bandFreqs = null; // array of {start, end, center}

  // scrolling parameters
  const secondsToShow = 6; // default show last N seconds
  const targetFps = 30;
  let shiftAcc = 0; // accumulator for fractional pixel shifts

  let mediaRecorder = null;
  let recordedChunks = [];

  function setCanvasSize(w, h) {
    canvas.width = w;
    canvas.height = h;
    // scale CSS to fit viewport while preserving aspect ratio
    canvas.style.width = '360px'; // small preview on desktop; user can scale
    canvas.style.height = (360 * h / w) + 'px';
  }

  function parsePreset(value) {
    const [w, h] = value.split('x').map(n => parseInt(n, 10));
    return { w, h };
  }

  preset.addEventListener('change', () => {
    const p = parsePreset(preset.value);
    setCanvasSize(p.w, p.h);
  });

  // default preset
  setCanvasSize(1080, 1920);

  btnMic.addEventListener('click', async () => {
    if (!micStream) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        alert('Could not access microphone: ' + err.message);
        return;
      }
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(micStream);
      setupAnalyserIfNeeded();
      // connect source -> analyser
      try { source.connect(analyser); } catch(e){}
      currentSource = source;
      sourceType = 'mic';

      draw();

      btnMic.textContent = 'Stop Mic';
      btnRecord.disabled = false;
    } else {
      stopSource();
      btnMic.textContent = 'Start Mic';
      btnRecord.disabled = true;
    }
  });

  btnLoad.addEventListener('click', async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) { alert('Choose an audio file first'); return; }
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    setupAnalyserIfNeeded();

    // set up media element
    filePlayer.src = URL.createObjectURL(f);
    filePlayer.play().catch(()=>{});

    // disconnect previous source if any
    try { if (currentSource) currentSource.disconnect(); } catch(e){}

    // create media element source
    try {
      const mediaSrc = audioCtx.createMediaElementSource(filePlayer);
      mediaSrc.connect(analyser);
      currentSource = mediaSrc;
      sourceType = 'file';
      btnRecord.disabled = false;
      draw();
    } catch (err) {
      console.warn('Could not create media element source:', err);
      alert('Loading file failed: ' + err.message);
    }
  });

  // UI listeners
  if (widthSlider) widthSlider.addEventListener('input', () => { widthMultiplier = parseFloat(widthSlider.value); });
  if (filenameInput) filenameInput.addEventListener('input', () => {
    const base = filenameInput.value.trim() || 'visualization';
    if (downloadLink) downloadLink.download = base + '.webm';
  });
  function hexToRgb(hex) {
    const v = hex.replace('#','');
    const bigint = parseInt(v, 16);
    return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
  }
  function mixRgb(a, b, t) {
    return { r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t) };
  }
  function rgbToCss(c, a) { return `rgba(${c.r},${c.g},${c.b},${a})`; }
  function formatHz(v) {
    if (v >= 1000) return (v/1000).toFixed(2) + ' kHz';
    return Math.round(v) + ' Hz';
  }

  function stopSource() {
    // stop playback or mic
    if (sourceType === 'file') {
      try { filePlayer.pause(); filePlayer.currentTime = 0; } catch(e){}
    }
    if (sourceType === 'mic') {
      if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    }
    try { if (currentSource) currentSource.disconnect(); } catch(e){}
    currentSource = null;
    sourceType = null;
    if (audioCtx) { try { audioCtx.suspend(); } catch(e){} }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    clearCanvas();
  }

  function setupAnalyserIfNeeded() {
    if (!analyser) {
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      const bufferLength = analyser.fftSize;
      dataArray = new Uint8Array(bufferLength);
      freqArray = new Uint8Array(analyser.frequencyBinCount);
      // compute band frequency ranges
      const bands = 10;
      const binCount = analyser.frequencyBinCount;
      const sampleRate = audioCtx.sampleRate || 44100;
      const freqPerBin = sampleRate / analyser.fftSize;
      bandFreqs = new Array(bands).fill(0).map((_, i) => {
        const startBin = Math.floor(i * binCount / bands);
        const endBin = Math.floor((i + 1) * binCount / bands) - 1;
        const startHz = Math.max(0, startBin * freqPerBin);
        const endHz = Math.max(0, endBin * freqPerBin);
        const center = (startHz + endHz) / 2;
        return { startHz, endHz, center };
      });
    }
  }

  function stopMic() {
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch(e){}
      audioCtx = null;
      analyser = null;
    }
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    clearCanvas();
  }

  function clearCanvas() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function draw() {
    if (!analyser) return;
    analyser.getByteTimeDomainData(dataArray);
    analyser.getByteFrequencyData(freqArray);

    const w = canvas.width;
    const h = canvas.height;

    // scrolling: compute how many pixels to shift this frame so we show 'secondsToShow'
    const dxPerFrame = w / (secondsToShow * targetFps);
    shiftAcc += dxPerFrame;
    let dx = Math.floor(shiftAcc);
    if (dx > 0) {
      shiftAcc -= dx;
      // shift canvas content left by dx
      ctx.drawImage(canvas, -dx, 0);
      // clear newly freed right area
      ctx.fillStyle = '#050510';
      ctx.fillRect(w - dx, 0, dx, h);
    }

    // draw vertical slices at the right edge showing current energy
    const x = w - 1; // draw at rightmost column
    const lines = 10;
    const midIdx = (lines - 1) / 2;
    // prepare theme colors
    const lowRgb = lowColorEl ? hexToRgb(lowColorEl.value) : {r:0,g:230,b:255};
    const midRgb = midColorEl ? hexToRgb(midColorEl.value) : {r:255,g:0,b:200};
    const highRgb = highColorEl ? hexToRgb(highColorEl.value) : {r:255,g:215,b:0};
    for (let line = 0; line < lines; line++) {
      const bandStart = Math.floor(line * freqArray.length / lines);
      const bandEnd = Math.floor((line + 1) * freqArray.length / lines);
      let bandSum = 0;
      for (let k = bandStart; k < bandEnd; k++) bandSum += freqArray[k];
      const bandAvg = bandSum / Math.max(1, (bandEnd - bandStart));
      const norm = bandAvg / 255;
      // color interpolation based on band position (low->mid->high)
      const tBand = line / (lines - 1);
      let colorRgb;
      if (tBand < 0.5) {
        const tt = tBand / 0.5;
        colorRgb = mixRgb(lowRgb, midRgb, tt);
      } else {
        const tt = (tBand - 0.5) / 0.5;
        colorRgb = mixRgb(midRgb, highRgb, tt);
      }
      const alpha = 0.9 * (0.25 + norm * 0.75);

      // vertical mapping: bass (line=0) -> bottom, highs -> top
      const t = line / (lines - 1);
      const baseY = h * (1 - t);

      // amplitude in pixels, scaled by widthMultiplier
      const midBoost = 1 + Math.max(0, 1 - Math.abs(line - midIdx) / midIdx) * 0.6;
      const ampPx = Math.max(4, Math.floor((h / 12) * (0.4 + norm * 2.2) * midBoost * widthMultiplier));

      // draw a filled vertical bar centered at baseY
      ctx.fillStyle = rgbToCss(colorRgb, alpha);
      const barW = Math.max(1, Math.floor((dx || 1) * Math.max(1, widthMultiplier)));
      ctx.fillRect(x - (barW-1), baseY - ampPx, barW, ampPx * 2);

      // draw frequency label to the left of the bar (small)
      if (bandFreqs && bandFreqs[line]) {
        const label = formatHz(bandFreqs[line].center);
        ctx.fillStyle = 'rgba(230,235,245,0.9)';
        const fontSize = Math.max(12, Math.floor(w / 72));
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, 8, baseY);
      }

      // add light thin highlight
      if (norm > 0.08) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(255,255,255,${0.01 + norm * 0.03})`;
        ctx.fillRect(x - (barW-1), baseY - Math.floor(ampPx/3), barW, Math.floor(ampPx/1.5));
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    rafId = requestAnimationFrame(draw);
  }

  btnRecord.addEventListener('click', async () => {
    if (!currentSource || !audioCtx) {
      alert('Start a source first (mic or file).');
      return;
    }

    // Prepare audio destination for capturing audio to a MediaStream
    const dest = audioCtx.createMediaStreamDestination();
    try { currentSource.connect(dest); } catch(e) { console.warn('Could not connect source to destination:', e); }

    // capture canvas video
    const fps = 30;
    const canvasStream = canvas.captureStream(fps);

    // combine streams
    const combined = new MediaStream();
    canvasStream.getVideoTracks().forEach(t => combined.addTrack(t));
    dest.stream.getAudioTracks().forEach(t => combined.addTrack(t));

    // setup MediaRecorder
    const options = { mimeType: 'video/webm;codecs=vp8,opus' };
    recordedChunks = [];
    try {
      mediaRecorder = new MediaRecorder(combined, options);
    } catch (err) {
      alert('MediaRecorder not supported or cannot use the chosen codecs: ' + err.message);
      return;
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      preview.src = url;
      preview.controls = true;
      preview.play().catch(()=>{});

      const baseName = (filenameInput && filenameInput.value) ? filenameInput.value.trim() : 'visualization';
      const safeBase = baseName === '' ? 'visualization' : baseName;
      downloadLink.href = url;
      downloadLink.style.display = 'inline-block';
      downloadLink.textContent = 'Download WebM';
      downloadLink.download = safeBase + '.webm';

      // show conversion options
      if (btnConvertCli) btnConvertCli.style.display = 'inline-block';
      if (btnConvertBrowser) { btnConvertBrowser.style.display = 'inline-block'; btnConvertBrowser.disabled = true; }
      if (convertStatusEl) convertStatusEl.textContent = '';

      // wire CLI button
      if (btnConvertCli) {
        btnConvertCli.onclick = () => {
          const webmName = downloadLink.download || (safeBase + '.webm');
          const mp4Name = safeBase + '.mp4';
          if (convertStatusEl) convertStatusEl.textContent = `ffmpeg -i ${webmName} -c:v libx264 -crf 18 -preset fast -c:a aac -b:a 160k ${mp4Name}`;
        };
      }

        // show conversion options
        document.getElementById('btn-convert-cli').style.display = 'inline-block';
        document.getElementById('btn-convert-browser').style.display = 'inline-block';
        document.getElementById('convertStatus').textContent = '';

      btnRecord.disabled = false;
      btnStop.disabled = true;
    };

    mediaRecorder.start(1000);
    btnRecord.disabled = true;
    btnStop.disabled = false;
  });

  btnStop.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  });

  // cleanup when leaving
  window.addEventListener('beforeunload', () => {
    stopMic();
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch(e){}
    }
  });

  // helpful keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'r') {
      if (!btnRecord.disabled) btnRecord.click();
    }
    if (e.key === 's') {
      if (!btnStop.disabled) btnStop.click();
    }
  });

})();
