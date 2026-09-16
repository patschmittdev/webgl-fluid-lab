# WebGL Fluid Lab

A static WebGL2 fluid simulation playground. The solver, post-processing, input handling, presets, persistence, and UI are implemented in this repository.

**Live demo:** [patschmittdev.github.io/webgl-fluid-lab](https://patschmittdev.github.io/webgl-fluid-lab/)

The simulation uses a pressure-projection pipeline each frame: advect velocity, advect dye, calculate curl, apply vorticity confinement, calculate divergence, decay and solve pressure, subtract the pressure gradient, then render the dye. Bloom adds a soft-knee bright pass with a downsample and upsample pyramid. Sunrays use a radial transmittance pass derived from the dye mask.

The solver requires WebGL2 and `EXT_color_buffer_float`. If either is unavailable, the page shows a clear fallback message.

## Run locally

```bash
npx --yes serve . -p 4173
```

Open `http://localhost:4173`. A `file://` URL will not load the ES modules.

## Controls

- Click-drag on desktop, or swipe on a phone, to paint.
- Presets switch the complete visual configuration.
- Each load starts on **Classic** (sim 128, dye 1024). **High detail** and **Ultra** raise those buffers.
- Phones start with the panel hidden and cap expensive resolutions to keep heavier presets usable.
- Leave **Mouseover paint** off unless you want cursor motion to paint without a click.
- **Continuous jet** is a left-side dye stream. Same solver, not an engine model.
- Export or import JSON, or copy a share URL that contains the complete configuration.
- Splats count persists in `localStorage` under `webgl-labs.fluid.state.v4`. Visual settings reset to Classic on every load.

Config from storage, imported JSON, or a share URL is validated before use. Unknown keys are dropped, numbers are clamped to the control ranges, colors must be `#rrggbb`, and invalid palette entries are removed.

## Keys

- `Space`: random splats
- `P`: pause while keeping painting available
- `J`: toggle the continuous jet
- `H`: hide or show the panel

Modifier combinations are ignored, so browser shortcuts such as `Ctrl+J` and `Ctrl+P` remain available.

## Layout

```text
index.html
assets/
  app.js            UI, state, persistence, share links
  presets.js        presets, defaults, and authoritative slider ranges
  styles.css
  engines/
    lab.js          WebGL2 solver and GPU resource lifecycle
    lab/shaders.js  GLSL simulation and post-processing programs
```

## Credits

This implementation was inspired by Pavel Dobryakov's WebGL fluid simulation and the graphics literature it builds on. No third-party solver code is distributed in this repository.

- [WebGL Fluid Simulation CodePen](https://codepen.io/PavelDoGreat/pen/zdWzEL) by [@PavelDoGreat](https://codepen.io/PavelDoGreat)
- [PavelDoGreat/WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation), including its [live demo](https://paveldogreat.github.io/WebGL-Fluid-Simulation/)
- [WebGL Fluid Enhanced](https://github.com/michaelbrusegard/WebGL-Fluid-Enhanced), the ES-module fork previously used during comparison work
- [GPU Gems 3, chapter 38: Fast Fluid Dynamics Simulation on the GPU](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu)
- [mharrys/fluids-2d](https://github.com/mharrys/fluids-2d)
- [haxiomic/GPU-Fluid-Experiments](https://github.com/haxiomic/GPU-Fluid-Experiments)
