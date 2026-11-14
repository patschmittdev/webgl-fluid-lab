import { createAudioAnalysis } from "./audio.js";

export function createMusicPlayer(audio, onChange, onStatus) {
  let source = null;
  let name = "Music stopped";
  let context;
  let analyser;
  let spectrum;
  let stream;
  let url;
  let timer;
  let generation = 0;
  let analysis = createAudioAnalysis();
  let lastTime;
  const nodes = new Set();
  const voices = new Set();

  function notify() {
    onChange({ source, name, playing: Boolean(context && (source !== "track" || !audio.paused)) });
  }

  function stop(message = "Music stopped") {
    generation += 1;
    clearInterval(timer);
    audio.onended = null;
    audio.onerror = null;
    audio.onpause = null;
    audio.onplay = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    for (const track of stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    stream = undefined;
    for (const voice of voices) {
      voice.onended = null;
      try {
        voice.stop();
      } catch {
        // A scheduled voice may already have ended.
      }
    }
    voices.clear();
    for (const node of nodes) {
      node.disconnect();
    }
    nodes.clear();
    if (context) {
      context.close().catch(() => {});
    }
    context = undefined;
    analyser = undefined;
    if (url) {
      URL.revokeObjectURL(url);
    }
    url = undefined;
    source = null;
    name = message;
    lastTime = undefined;
    analysis = createAudioAnalysis();
    notify();
    onStatus(message);
  }

  function node(value) {
    nodes.add(value);
    return value;
  }

  function openContext() {
    const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioContext) {
      throw new Error("Audio analysis is unavailable in this browser.");
    }
    context = new AudioContext();
    analyser = node(context.createAnalyser());
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    spectrum = new Uint8Array(analyser.frequencyBinCount);
    return context;
  }

  function fail(error, token) {
    if (token !== generation) {
      return;
    }
    const message = error?.name === "NotAllowedError" || error?.name === "AbortError"
      ? "Sharing was cancelled or permission was denied."
      : error?.name === "NotSupportedError"
        ? "This browser could not play that audio file."
        : "Could not start audio. Try another source or track.";
    stop(message);
  }

  function chooseTrack(file) {
    stop();
    if (!file || (!file.type.startsWith("audio/") && !/\.(mp3|wav|ogg|m4a|aac|flac|opus|webm)$/i.test(file.name))) {
      onStatus("Choose an audio file.");
      return;
    }
    source = "track";
    name = file.name;
    const replacement = audio.cloneNode(false);
    audio.replaceWith(replacement);
    audio = replacement;
    url = URL.createObjectURL(file);
    audio.src = url;
    const token = generation;
    audio.onerror = () => {
      if (token === generation) {
        stop("This browser could not play that audio file.");
      }
    };
    audio.onended = () => stop("Track ended");
    audio.onpause = notify;
    audio.onplay = notify;
    notify();
    onStatus("Track ready. Press Play.");
  }

  async function playTrack() {
    if (source !== "track") {
      return;
    }
    if (!audio.paused) {
      audio.pause();
      onStatus("Track paused");
      return;
    }
    const token = generation;
    try {
      if (!context) {
        openContext();
        node(context.createMediaElementSource(audio)).connect(analyser);
        analyser.connect(context.destination);
      }
      const activeContext = context;
      await activeContext.resume();
      if (token !== generation) {
        return;
      }
      await audio.play();
      if (token === generation) {
        notify();
        onStatus("Playing track");
      }
    } catch (error) {
      fail(error, token);
    }
  }

  async function useTab() {
    stop();
    const token = generation;
    try {
      const activeContext = openContext();
      const resumed = activeContext.resume().then(() => null, error => error);
      source = "tab";
      name = "Waiting for tab audio";
      notify();
      const capture = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (token !== generation) {
        capture.getTracks().forEach(track => track.stop());
        return;
      }
      stream = capture;
      capture.getVideoTracks().forEach(track => track.stop());
      const tracks = capture.getAudioTracks().filter(track => track.readyState === "live");
      if (tracks.length === 0) {
        stop("No audio was shared. Try again and tick Share audio for a tab.");
        return;
      }
      tracks.forEach(track => {
        track.onended = () => {
          if (token === generation) {
            stop("Tab audio sharing ended");
          }
        };
      });
      node(activeContext.createMediaStreamSource(new MediaStream(tracks))).connect(analyser);
      const resumeError = await resumed;
      if (token !== generation) {
        return;
      }
      if (resumeError) {
        throw resumeError;
      }
      source = "tab";
      name = "Tab audio";
      notify();
      onStatus("Listening to tab audio");
    } catch (error) {
      fail(error, token);
    }
  }

  function demoPattern() {
    const beat = 60 / 104;
    const master = node(context.createGain());
    master.gain.value = 0.45;
    master.connect(analyser);
    analyser.connect(context.destination);
    const noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    function voice(time, duration, volume, frequency, endFrequency, filterFrequency) {
      const sound = node(frequency ? context.createOscillator() : context.createBufferSource());
      const gain = node(context.createGain());
      const owned = [sound, gain];
      if (frequency) {
        sound.type = "sine";
        sound.frequency.setValueAtTime(frequency, time);
        sound.frequency.exponentialRampToValueAtTime(endFrequency, time + duration);
        sound.connect(gain);
      } else {
        sound.buffer = noise;
        const filter = node(context.createBiquadFilter());
        owned.push(filter);
        filter.type = "highpass";
        filter.frequency.value = filterFrequency;
        sound.connect(filter);
        filter.connect(gain);
      }
      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(volume, time + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.001, time + duration);
      gain.connect(master);
      voices.add(sound);
      sound.onended = () => {
        voices.delete(sound);
        for (const item of owned) {
          item.disconnect();
          nodes.delete(item);
        }
      };
      sound.start(time);
      sound.stop(time + duration + 0.01);
    }
    let next = context.currentTime + 0.05;
    let step = 0;
    function schedule() {
      if (next < context.currentTime) {
        next = context.currentTime + 0.05;
      }
      while (next < context.currentTime + 0.15) {
        if (step % 2 === 0) {
          voice(next, 0.2, 0.8, 140, 44);
          const bass = step % 16 < 8 ? 55 : 65.406;
          voice(next + 0.06, 0.3, 0.23, bass, bass);
        } else {
          voice(next, 0.06, 0.14, 0, 0, 7000);
        }
        if (step % 16 === 6 || step % 16 === 14) {
          for (let i = 0; i < 3; i += 1) {
            voice(next + i * 0.018, 0.08, 0.09, 0, 0, 1200);
          }
        }
        next += beat / 2;
        step += 1;
      }
    }
    schedule();
    timer = setInterval(schedule, 25);
  }

  async function demo() {
    if (source === "demo") {
      stop();
      return;
    }
    stop();
    const token = generation;
    try {
      const activeContext = openContext();
      source = "demo";
      name = "Demo beat";
      notify();
      await activeContext.resume();
      if (token !== generation) {
        return;
      }
      demoPattern();
      notify();
      onStatus("Playing demo beat");
    } catch (error) {
      fail(error, token);
    }
  }

  function read(time) {
    if (!source || !analyser || context.state !== "running" || (source === "track" && audio.paused)) {
      lastTime = undefined;
      analysis = createAudioAnalysis();
      return null;
    }
    const dt = lastTime === undefined ? 1 / 60 : Math.min(0.1, Math.max(0, time - lastTime));
    lastTime = time;
    analyser.getByteFrequencyData(spectrum);
    return analysis(spectrum, context.sampleRate, time, dt);
  }

  return { stop, chooseTrack, playTrack, useTab, demo, read, setLoop: value => { audio.loop = value; } };
}
