import test from "node:test";
import assert from "node:assert/strict";
import { createMusicPlayer } from "../assets/music.js";

function fixture(t) {
  const contexts = [];
  const elements = [];
  const timers = new Set();
  const urls = new Set();
  const changes = [];
  const statuses = [];
  const connectedElements = new WeakSet();
  class Audio {
    constructor() {
      this.paused = true;
      this.loop = false;
      elements.push(this);
    }
    pause() {
      this.paused = true;
      this.onpause?.();
    }
    async play() {
      this.paused = false;
      this.onplay?.();
    }
    load() {
    }
    removeAttribute() {
      delete this.src;
    }
    cloneNode() {
      return new Audio();
    }
    replaceWith() {
    }
  }
  class Context {
    constructor() {
      this.state = "running";
      this.sampleRate = 48000;
      this.currentTime = 0;
      this.destination = {};
      this.nodes = [];
      contexts.push(this);
    }
    node(kind) {
      const node = {
        kind,
        connections: [],
        disconnected: false,
        connect(target) {
          this.connections.push(target);
        },
        disconnect() {
          this.disconnected = true;
        },
        start() {
          this.started = true;
        },
        stop() {
          this.stopped = true;
        },
      };
      const parameter = () => ({
        value: 0,
        setValueAtTime() {
        },
        linearRampToValueAtTime() {
        },
        exponentialRampToValueAtTime() {
        },
      });
      node.gain = parameter();
      node.frequency = parameter();
      this.nodes.push(node);
      return node;
    }
    createAnalyser() {
      const analyser = this.node("analyser");
      analyser.frequencyBinCount = 1024;
      analyser.getByteFrequencyData = data => data.fill(30);
      return analyser;
    }
    createMediaElementSource(element) {
      assert.equal(connectedElements.has(element), false, "an element is bound only once across contexts");
      connectedElements.add(element);
      return this.node("media");
    }
    createMediaStreamSource(stream) {
      assert.equal(stream.getVideoTracks().length, 0, "only audio is analysed");
      return this.node("capture");
    }
    createGain() {
      return this.node("gain");
    }
    createOscillator() {
      return this.node("oscillator");
    }
    createBufferSource() {
      return this.node("noise");
    }
    createBiquadFilter() {
      return this.node("filter");
    }
    createBuffer(channels, length) {
      return { getChannelData: () => new Float32Array(length) };
    }
    async resume() {
      this.state = "running";
    }
    async close() {
      this.state = "closed";
    }
  }
  class Stream {
    constructor(tracks) {
      this.tracks = tracks;
    }
    getTracks() {
      return this.tracks;
    }
    getVideoTracks() {
      return this.tracks.filter(track => track.kind === "video");
    }
    getAudioTracks() {
      return this.tracks.filter(track => track.kind === "audio");
    }
  }
  const device = { getDisplayMedia: async () => new Stream([]) };
  const replacements = {
    AudioContext: Context,
    MediaStream: Stream,
    navigator: { mediaDevices: device },
    setInterval: callback => {
      timers.add(callback);
      return callback;
    },
    clearInterval: timer => timers.delete(timer),
  };
  const originals = new Map();
  for (const [key, value] of Object.entries(replacements)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  let nextUrl = 0;
  t.mock.method(URL, "createObjectURL", () => {
    const url = "blob:test-" + nextUrl++;
    urls.add(url);
    return url;
  });
  t.mock.method(URL, "revokeObjectURL", url => assert.ok(urls.delete(url), "URL revoked once"));
  const player = createMusicPlayer(new Audio(), value => changes.push(value), message => statuses.push(message));
  t.after(() => {
    player.stop();
    assert.equal(urls.size, 0);
    assert.equal(timers.size, 0);
    for (const context of contexts) {
      assert.equal(context.state, "closed");
      assert.ok(context.nodes.every(node => node.disconnected));
    }
    for (const [key, descriptor] of originals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  });
  function track(kind) {
    return {
      kind,
      readyState: "live",
      stop() {
        this.readyState = "ended";
      },
    };
  }
  return { player, contexts, elements, changes, statuses, device, Stream, track, urls, timers };
}

test("choosing a track creates no context; playback, pause, replacement and stop release resources", async t => {
  const f = fixture(t);
  f.player.chooseTrack({ name: "<track>.mp3", type: "audio/mpeg" });
  assert.equal(f.contexts.length, 0);
  assert.equal(f.changes.at(-1).name, "<track>.mp3");
  assert.equal(f.urls.size, 1);
  f.player.setLoop(true);
  assert.equal(f.elements.at(-1).loop, true);
  await f.player.playTrack();
  assert.equal(f.contexts.length, 1);
  assert.ok(f.player.read(0));
  await f.player.playTrack();
  assert.equal(f.player.read(0.1), null);
  await f.player.playTrack();
  assert.equal(f.contexts.length, 1);
  f.player.chooseTrack({ name: "second.ogg", type: "audio/ogg" });
  assert.equal(f.contexts[0].state, "closed");
  assert.equal(f.urls.size, 1);
  await f.player.playTrack();
  assert.equal(f.contexts.length, 2);
  f.player.stop();
  assert.equal(f.player.read(1), null);
  assert.equal(f.urls.size, 0);
});

test("tab audio stops video immediately, never reaches speakers and handles ended sharing", async t => {
  const f = fixture(t);
  const video = f.track("video");
  const audio = f.track("audio");
  f.device.getDisplayMedia = async options => {
    assert.deepEqual(options, { video: true, audio: true });
    return new f.Stream([video, audio]);
  };
  await f.player.useTab();
  assert.equal(video.readyState, "ended");
  assert.equal(audio.readyState, "live");
  const context = f.contexts[0];
  assert.ok(context.nodes.every(node => !node.connections.includes(context.destination)));
  audio.onended();
  assert.equal(audio.readyState, "ended");
  assert.equal(context.state, "closed");
  assert.match(f.statuses.at(-1), /sharing ended/);
});

test("a late share result cannot replace a newer source or retain tracks", async t => {
  const f = fixture(t);
  let resolve;
  f.device.getDisplayMedia = () => new Promise(done => { resolve = done; });
  const pending = f.player.useTab();
  await f.player.demo();
  const tracks = [f.track("video"), f.track("audio")];
  resolve(new f.Stream(tracks));
  await pending;
  assert.ok(tracks.every(track => track.readyState === "ended"));
  assert.equal(f.changes.at(-1).source, "demo");
  assert.equal(f.contexts[0].state, "closed");
  assert.equal(f.timers.size, 1);
  await f.player.demo();
  assert.equal(f.timers.size, 0);
  assert.ok(f.contexts[1].nodes.filter(node => node.started).every(node => node.stopped));
});

test("missing shared audio, cancelled capture and unsupported files become status messages", async t => {
  const f = fixture(t);
  const video = f.track("video");
  f.device.getDisplayMedia = async () => new f.Stream([video]);
  await f.player.useTab();
  assert.match(f.statuses.at(-1), /No audio was shared/);
  assert.equal(video.readyState, "ended");
  f.device.getDisplayMedia = async () => { throw { name: "NotAllowedError" }; };
  await f.player.useTab();
  assert.match(f.statuses.at(-1), /cancelled or permission was denied/);
  f.player.chooseTrack({ name: "bad.mp3", type: "audio/mpeg" });
  f.elements.at(-1).onerror();
  assert.match(f.statuses.at(-1), /could not play/);
  assert.equal(f.urls.size, 0);
  f.player.chooseTrack({ name: "notes.txt", type: "text/plain" });
  assert.match(f.statuses.at(-1), /Choose an audio file/);
});

test("a track ending closes the context and revokes its URL", async t => {
  const f = fixture(t);
  f.player.chooseTrack({ name: "test.wav", type: "audio/wav" });
  await f.player.playTrack();
  f.elements.at(-1).onended();
  assert.equal(f.contexts[0].state, "closed");
  assert.equal(f.urls.size, 0);
  assert.equal(f.changes.at(-1).source, null);
});
