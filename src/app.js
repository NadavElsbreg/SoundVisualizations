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

  let audioCtx = null;
  let analyser = null;
  let micStream = null;
  let dataArray = null;
  let freqArray = null;
  let rafId = null;

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

      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048; // 2048 gives good freq/time resolution
      const bufferLength = analyser.fftSize;
      dataArray = new Uint8Array(bufferLength);
      freqArray = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);

      draw();

      btnMic.textContent = 'Stop Mic';
      btnRecord.disabled = false;
    } else {
      stopMic();
      btnMic.textContent = 'Start Mic';
      btnRecord.disabled = true;
    }
  });

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

    // background
    ctx.fillStyle = '#050510';
    ctx.fillRect(0, 0, w, h);

    // draw multiple lines representing different frequency bands
    const lines = 10;
    const timePoints = 512; // how many samples across the canvas to draw
    const slice = Math.floor(dataArray.length / timePoints);

    for (let line = 0; line < lines; line++) {
      // compute frequency band average for this line
      const bandStart = Math.floor(line * freqArray.length / lines);
      const bandEnd = Math.floor((line + 1) * freqArray.length / lines);
      let bandSum = 0;
      for (let k = bandStart; k < bandEnd; k++) bandSum += freqArray[k];
      const bandAvg = bandSum / Math.max(1, (bandEnd - bandStart)); // 0..255
      const norm = bandAvg / 255; // 0..1

      // map energy to color hue
      const hue = Math.floor((1 - norm) * 220 + norm * 40); // bluish -> yellowish
      const alpha = 0.6 * (0.3 + norm);

      ctx.beginPath();
      ctx.lineWidth = Math.max(1, Math.floor(w / (300 + line * 5)));
      ctx.strokeStyle = `hsla(${hue}, 90%, ${40 + norm * 30}%, ${alpha})`;

      // vertical offset for this line (stacked layers)
      const baseY = (h / (lines + 1)) * (line + 1);

      let x = 0;
      for (let i = 0; i < timePoints; i++) {
        const idx = i * slice;
        const v = (dataArray[idx] - 128) / 128.0; // -1..1 time domain
        // modulate amplitude by band energy and by line index to create variety
        const amp = (h / 6) * (0.3 + norm) * (1 - line / (lines * 1.4));
        const y = baseY + v * amp;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += w / timePoints;
      }
      ctx.stroke();

      // soft glow for lower lines
      if (line > lines - 4) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = `rgba(255,255,255,${0.02 + norm * 0.03})`;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    rafId = requestAnimationFrame(draw);
  }

  btnRecord.addEventListener('click', async () => {
    if (!micStream || !audioCtx) {
      alert('Start the mic first.');
      return;
    }

    // Prepare audio destination for capturing audio to a MediaStream
    const dest = audioCtx.createMediaStreamDestination();
    const source = audioCtx.createMediaStreamSource(micStream);
    source.connect(dest);

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

      downloadLink.href = url;
      downloadLink.style.display = 'inline-block';
      downloadLink.textContent = 'Download WebM';

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
