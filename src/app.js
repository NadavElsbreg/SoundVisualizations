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
  const btnSaveNative = document.getElementById('btn-save-native');


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
  let bandBins = null; // array of {startBin, endBin}

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
      // ensure band editor reflects new analyser/sampleRate
      updateBandBins();
      renderBandEditor();
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
    // update band editor UI
    renderBandEditor();
  }

  function setupAnalyserIfNeeded() {
    if (!analyser) {
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      const bufferLength = analyser.fftSize;
      dataArray = new Uint8Array(bufferLength);
      freqArray = new Uint8Array(analyser.frequencyBinCount);
      // compute band frequency ranges
      // initialize equal bands
      setEqualBands(10);
    }
  }

  // Band editor UI
  const btnBandEditor = document.getElementById('btn-band-editor');
  const bandEditor = document.getElementById('bandEditor');
  const bandList = document.getElementById('bandList');
  const bandCountInput = document.getElementById('bandCount');
  const btnResetBands = document.getElementById('btn-reset-bands');
  const btnApplyBands = document.getElementById('btn-apply-bands');

  if (btnBandEditor) btnBandEditor.addEventListener('click', () => {
    if (!bandEditor) return;
    bandEditor.style.display = bandEditor.style.display === 'none' ? 'block' : 'none';
    renderBandEditor();
  });

  function renderBandEditor() {
    if (!bandList) return;
    bandList.innerHTML = '';
    if (!bandFreqs) return;
    bandFreqs.forEach((b, i) => {
      const row = document.createElement('div');
      row.className = 'band-row';
      const label = document.createElement('div');
      label.className = 'band-label';
      label.textContent = (i+1);
      const start = document.createElement('input');
      start.type = 'number'; start.min = 0; start.value = Math.round(b.startHz);
      const end = document.createElement('input');
      end.type = 'number'; end.min = 0; end.value = Math.max(1, Math.round(b.endHz));
      row.appendChild(label);
      row.appendChild(start);
      row.appendChild(end);
      bandList.appendChild(row);
    });
  }

  if (btnResetBands) btnResetBands.addEventListener('click', () => {
    const n = parseInt(bandCountInput ? bandCountInput.value : 10, 10) || 10;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    setupAnalyserIfNeeded();
    setEqualBands(n);
    renderBandEditor();
  });

  if (btnApplyBands) btnApplyBands.addEventListener('click', () => {
    if (!bandList || !bandFreqs) return;
    const rows = Array.from(bandList.children);
    rows.forEach((row, i) => {
      const inputs = row.querySelectorAll('input');
      const s = parseFloat(inputs[0].value) || 0;
      const e = parseFloat(inputs[1].value) || Math.max(1, s+1);
      bandFreqs[i].startHz = Math.max(0, s);
      bandFreqs[i].endHz = Math.max(bandFreqs[i].startHz + 1, e);
      bandFreqs[i].center = (bandFreqs[i].startHz + bandFreqs[i].endHz) / 2;
    });
    updateBandBins();
  });

  // set initial band editor state
  if (!bandFreqs && audioCtx) setupAnalyserIfNeeded();
  renderBandEditor();

  function setEqualBands(count) {
    const bands = Math.max(2, Math.min(64, Math.floor(count)));
    const sampleRate = audioCtx.sampleRate || 44100;
    const freqPerBin = sampleRate / analyser.fftSize;
    const binCount = analyser.frequencyBinCount;
    bandFreqs = new Array(bands).fill(0).map((_, i) => {
      const startBin = Math.floor(i * binCount / bands);
      const endBin = Math.floor((i + 1) * binCount / bands) - 1;
      const startHz = Math.max(0, startBin * freqPerBin);
      const endHz = Math.max(0, endBin * freqPerBin);
      const center = (startHz + endHz) / 2;
      return { startHz, endHz, center };
    });
    updateBandBins();
  }

  function updateBandBins() {
    if (!bandFreqs || !analyser) return;
    const sampleRate = audioCtx.sampleRate || 44100;
    const freqPerBin = sampleRate / analyser.fftSize;
    const binCount = analyser.frequencyBinCount;
    bandBins = bandFreqs.map(b => {
      const s = Math.max(0, Math.floor(b.startHz / freqPerBin));
      const e = Math.min(binCount - 1, Math.max(s, Math.floor(b.endHz / freqPerBin)));
      return { startBin: s, endBin: e };
    });
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
      // use bandBins if available (from editor), otherwise fallback to equal split
      let bandSum = 0;
      let bandStart = Math.floor(line * freqArray.length / lines);
      let bandEnd = Math.floor((line + 1) * freqArray.length / lines);
      if (bandBins && bandBins[line]) {
        bandStart = bandBins[line].startBin;
        bandEnd = bandBins[line].endBin + 1;
      }
      for (let k = bandStart; k < bandEnd; k++) bandSum += freqArray[k] || 0;
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

      // frequency labels are shown in the separate Band Editor panel (out of video frame)

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

      // Native save (Electron) - prefer native save if available
      if (btnSaveNative) {
        if (window && window.electronAPI) {
          btnSaveNative.style.display = 'inline-block';
          btnSaveNative.onclick = async () => {
            try {
              convertStatusEl.textContent = 'Preparing file...';
              const arrayBuffer = await blob.arrayBuffer();
              // ask main process to show save dialog and write file
              const result = await window.electronAPI.saveFile(safeBase + '.webm', arrayBuffer);
              if (result && result.success) convertStatusEl.textContent = 'Saved to: ' + result.path;
              else convertStatusEl.textContent = 'Save canceled or failed.';
            } catch (err) {
              console.error(err);
              convertStatusEl.textContent = 'Save failed: ' + err.message;
            }
          };
        } else {
          // not running in electron; hide native save
          btnSaveNative.style.display = 'none';
        }
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
