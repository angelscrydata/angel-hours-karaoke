// Microphone passthrough: mic -> volume -> (dry + reverb + echo) -> limiter -> speakers.
// Runs in the control panel window. Uses the Web Audio API with low-latency settings.
(() => {
  const $ = (id) => document.getElementById(id);
  const KEY = 'karaoke-mic-v1';
  const prefs = { input: '', output: '', vol: 100, reverb: 30, echo: 10 };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
  const savePrefs = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {} };

  let ctx = null, stream = null, nodes = null, meterRaf = 0;

  // Synthetic room reverb: decaying stereo noise.
  function impulse(ctx, seconds = 2.2, decay = 3) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function applyLevels() {
    if (!nodes) return;
    const t = ctx.currentTime;
    nodes.input.gain.setTargetAtTime(prefs.vol / 100, t, 0.02);
    nodes.wet.gain.setTargetAtTime((prefs.reverb / 100) * 0.9, t, 0.05);
    nodes.echo.gain.setTargetAtTime((prefs.echo / 100) * 0.6, t, 0.05);
    nodes.feedback.gain.setTargetAtTime((prefs.echo / 100) * 0.45, t, 0.05);
  }

  async function start() {
    ctx = new AudioContext({ latencyHint: 0 });
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: prefs.input ? { exact: prefs.input } : undefined,
        // These "phone call" filters add latency and make singing sound bad.
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        latency: 0, channelCount: 1,
      },
    });
    const src = ctx.createMediaStreamSource(stream);
    const input = ctx.createGain();
    const master = ctx.createGain();
    const convolver = ctx.createConvolver();
    convolver.buffer = impulse(ctx);
    const wet = ctx.createGain();
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.28;
    const feedback = ctx.createGain();
    const echo = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6; limiter.ratio.value = 12; limiter.attack.value = 0.003; limiter.release.value = 0.15;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;

    src.connect(input);
    input.connect(analyser);
    input.connect(master);                                   // dry
    input.connect(convolver).connect(wet).connect(master);   // reverb
    input.connect(delay); delay.connect(feedback).connect(delay); delay.connect(echo).connect(master); // echo
    master.connect(limiter).connect(ctx.destination);

    nodes = { input, wet, echo, feedback, analyser };
    applyLevels();
    await setOutput(prefs.output);
    await ctx.resume();
    meter();
    await listDevices();
    const ms = Math.round(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000);
    const label = stream.getAudioTracks()[0]?.label || 'microphone';
    $('micInfo').textContent = `Using ${label}${ms ? ` · ~${ms} ms output latency` : ''}. Use headphones or a wired speaker; Bluetooth and AirPlay add delay.`;
    $('micToggle').textContent = 'turn mic OFF';
  }

  function stop() {
    cancelAnimationFrame(meterRaf);
    stream?.getTracks().forEach((t) => t.stop());
    ctx?.close();
    ctx = stream = nodes = null;
    setMeter(0);
    $('micToggle').textContent = 'turn mic ON';
    $('micInfo').textContent = '';
  }

  async function setOutput(id) {
    if (!ctx || typeof ctx.setSinkId !== 'function') return;
    try { await ctx.setSinkId(id || ''); } catch (e) { console.warn('setSinkId failed', e); }
  }

  // ASCII level meter: ||||||| lit bars, then dim ones.
  const METER = 24;
  function setMeter(peak) {
    const k = Math.round(Math.min(1, peak) * METER);
    $('micMeterOn').textContent = '|'.repeat(k);
    $('micMeterOn').classList.toggle('hot', peak > 0.9);
    $('micMeterOff').textContent = '|'.repeat(METER - k);
  }

  function meter() {
    const data = new Float32Array(nodes.analyser.fftSize);
    const tick = () => {
      if (!nodes) return;
      nodes.analyser.getFloatTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v));
      setMeter(peak);
      meterRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  async function listDevices() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, chosen, def) => {
      const list = devs.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications');
      sel.innerHTML = `<option value="">${def}</option>` +
        list.map((d) => `<option value="${d.deviceId}">${d.label || kind}</option>`).join('');
      sel.value = list.some((d) => d.deviceId === chosen) ? chosen : '';
    };
    fill($('micInput'), 'audioinput', prefs.input, 'Default microphone');
    fill($('micOutput'), 'audiooutput', prefs.output, 'Default output');
  }

  if (typeof AudioContext === 'undefined' || !('setSinkId' in AudioContext.prototype)) {
    $('outputField').style.display = 'none'; // browser can't pick an output; system default is used
  }

  $('micToggle').addEventListener('click', async () => {
    if (ctx) return stop();
    try { await start(); }
    catch (e) {
      stop();
      $('micInfo').textContent = `Couldn't open the microphone: ${e.message}. Check that the browser has microphone permission (System Settings → Privacy & Security → Microphone).`;
    }
  });
  $('micInput').addEventListener('change', async (e) => {
    prefs.input = e.target.value; savePrefs();
    if (ctx) { stop(); await start(); }
  });
  $('micOutput').addEventListener('change', (e) => {
    prefs.output = e.target.value; savePrefs(); setOutput(prefs.output);
  });
  for (const [id, key] of [['micVol', 'vol'], ['micReverb', 'reverb'], ['micEcho', 'echo']]) {
    $(id).value = prefs[key];
    $(id).addEventListener('input', (e) => { prefs[key] = +e.target.value; savePrefs(); applyLevels(); });
  }
  navigator.mediaDevices?.addEventListener?.('devicechange', () => ctx && listDevices());
})();
