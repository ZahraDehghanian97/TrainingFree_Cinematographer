# Bundled model assets

## Ceramic Vase 01

- Artist: James Ray Cock, published by Poly Haven.
- Source: https://polyhaven.com/a/ceramic_vase_01
- License: CC0 1.0 Universal, https://polyhaven.com/license and https://creativecommons.org/publicdomain/zero/1.0/
- Downloaded: 2026-09-10, official 1K glTF distribution, unmodified.
- Files: `ceramic-vase/ceramic_vase_01_1k.gltf`, its `.bin` mesh, and three JPEG maps under `ceramic-vase/textures/` (base color, OpenGL normal, and packed occlusion/roughness/metalness).
- The visualizer uniformly fits the model to the existing vase bounds in example 03. Original geometry, textures, and entity tracks are retained.

These files are served locally; viewing the scene does not contact Poly Haven.

## Original procedural scene kit

The 22 `.glb` files in `generated/` are original geometric assets authored for
this repository by `scripts/generate-scene-assets.py` and `scripts/scene_layouts.py`. They were generated
locally from procedural geometry, not downloaded or inferred by an external
model. They are licensed under the repository's MIT license (see `/LICENSE`).
`generated/manifest.json` lists every model's dimensions, triangle count,
SHA-256 checksum, byte size, generation method, and license.

The kit consists of slatted-bench, planter-tree, streetlamp, warehouse-shelf,
crate-stack, forklift, rooftop-hvac, courtyard-fountain, briefcase, road-barrier,
lighting-truss, vending-machine, workbench, mezzanine, loading-bay-portal,
lounge-sofa, chair, side-table, floor-lamp, bookcase, keyboard, and
gym-equipment-rack.
The files are served locally and have no external buffers or texture requests.
The previously bundled ceramic vase and its attribution above are unchanged.
