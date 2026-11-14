# WebGL Fluid Lab

A fluid simulation that runs in the browser. Paint dye, draw walls for the flow to go around, heat the fluid so it rises, or let music push it around. It is a static page: WebGL2, no build step, no dependencies.

**Live demo:** [patschmittdev.github.io/webgl-fluid-lab](https://patschmittdev.github.io/webgl-fluid-lab/)

It started from the look of Pavel Dobryakov's 2017 WebGL fluid demo, which is still the default preset. The solver, shaders, presets and UI here are written for this repo.

## Run locally

```bash
npx --yes serve . -p 4173
```

Open `http://localhost:4173`. Opening `index.html` from disk will not work, because browsers do not load ES modules from `file://` URLs.

The page needs WebGL2 and the `EXT_color_buffer_float` extension. Without them it shows a message instead of the simulation.

## Presets

- **Pavel 2017**: the default. Rainbow dye with glow and light rays.
- **Smoke**: soft grey plumes.
- **Flame**: a flame from a nozzle at the bottom, coloured by its own heat, white at the base through yellow and orange, with grey smoke where it has cooled.
- **Ink**: ink on a light page. Thin strokes make a wash and overlapping inks darken.
- **Wind tunnel**: steady flow from left to right past a disc, with thin streams of dye to show the wake. Draw your own walls.
- **Plume**: warm smoke rising from the bottom on buoyancy alone.
- **Jupiter**: east and west jets by latitude, with a long-lived red storm held between two of them. The picture wraps around from one side of the screen to the other. Each latitude slowly re-supplies its own cloud colour, so the bands survive being stirred, and the colour you see is dye carried by the flow. The jet layout and colours are picked to look like the planet; this is not an atmosphere model.
- **Collide**: every splat is repeated around the centre, rotated and mirrored, inside the simulation. Mirrored pairs of streams run into each other and shoot outward. It is built for music.

## Controls

Hover over any control, or focus it with the keyboard, for a one-line description.

- **Paint, Wall, Erase**: drag on the canvas to add dye and push the fluid, draw solid walls, or rub walls out. Clear walls removes all of them, including a preset's own shapes. Reset brings those back.
- **View**: dye, speed, vorticity, pressure or temperature. Glow applies to the dye view only.
- **Pause, Splats, Screenshot, Reset**: Reset clears the fluid and restores the current preset's settings. Screenshot saves the current view as a PNG.
- **Colour, Glow, Paint, Physics, Simulation**: sliders and toggles, collapsed by default. Symmetry in Paint gives any preset Collide's repeated splats.
- **Share**: export or import settings as JSON, or copy a link that opens the lab with the same preset and settings. Drawn walls are not included.

Settings from a link or a JSON file are checked before use: unknown keys are dropped, numbers are clamped to the slider ranges, and colours must be `#rrggbb`. Only the splat count is kept between visits (in `localStorage`); every visit starts on Pavel 2017.

## Keys

- `Space`: random splats
- `P`: pause (you can still paint)
- `M`: start or stop the demo beat
- `J`: continuous jet
- `H`: hide or show the panel
- `D`, `W`, `E`: Paint, Wall, Erase
- `V`: next view

Keys pressed with Ctrl, Alt, Shift or Cmd are left to the browser.

## Music

Open Music and pick a source:

- **Use tab audio**: share a browser tab that is playing music and tick Share audio. This needs Chrome or Edge.
- **Demo beat**: a generated drum loop, for trying it out.
- **Choose a track**: an audio file from your computer. You can also drop one on the page.

The page measures bass, mid and treble, finds beats, and follows how loud and busy the track is. Each preset responds in its own way: Collide fires its central ring on beats and drifts softer wisps in from the edges between them, Flame burns harder with the bass, Jupiter kicks up a storm on each beat. Stopping the music puts everything back.

No audio is bundled, uploaded or recorded, and the microphone is never used. **Reduce flashing** limits beat bursts to two a second and stops music from changing the glow. It starts switched on when the device asks for reduced motion.

## Performance

Presets start at the highest resolution the sliders allow (simulation 512, dye 2048). If the first two seconds average under 30 frames a second, both are halved, and halved again if needed, down to 128 and 512. The status line says when this happens. Phones start with lower caps.

## How it works

Each frame the solver moves velocity and dye along the flow, strengthens small swirls, solves for pressure, and removes the part of the velocity that would compress the fluid. Optional passes add heat and buoyancy, solid walls, a left-to-right inlet and outlet, and the forcing behind the Jupiter preset.

```text
index.html
assets/
  app.js                  UI, state, share links
  help.js                 tooltip text
  config.js               settings validation and share-link encoding
  presets.js              presets, defaults and slider ranges
  audio.js                spectrum levels, beat detection and music mapping
  music.js                audio sources
  resolution-monitor.js   frame-rate check and resolution fallback
  styles.css
  engines/
    lab.js                solver and GPU resources
    lab/shaders.js        core simulation and display shaders
    lab/physics-shaders.js  walls, through-flow, heat, field views, Jupiter
tests/
```

## Tests

```bash
npm test
```

This needs Node.js and nothing else. The tests cover settings validation, the audio maths, and the order and inputs of the solver's passes against a stand-in for WebGL. They do not compile shaders or check what is drawn; that has to be done in a browser.

## Credits

Inspired by [Pavel Dobryakov's WebGL Fluid Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation) (MIT, 2017). The method is the well-known one described in [GPU Gems, chapter 38](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu), and nothing here claims to have invented it. See `NOTICE` for the original copyright notice.

Other projects looked at along the way:

- [WebGL Fluid Enhanced](https://github.com/michaelbrusegard/WebGL-Fluid-Enhanced)
- [mharrys/fluids-2d](https://github.com/mharrys/fluids-2d)
- [haxiomic/GPU-Fluid-Experiments](https://github.com/haxiomic/GPU-Fluid-Experiments)

## Licence

MIT. See `LICENSE`.
