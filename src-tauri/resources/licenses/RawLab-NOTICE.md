# RawLab attribution

Parts of this project's master recipe / film look feature are derived from RawLab:

- Source: https://github.com/Tri250/koudaixiangce
- License: GNU General Public License v3.0 only (full text in `RawLab-GPL-3.0.txt`)

Derived material:

- `resources/master_recipes/master-recipes.json` — master recipe catalogue (14 recipes, RawLab settings version 4 including tone/curve/grading/atmosphere).
- `resources/master_luts/大师·*.cube` — LUTs downsampled to a 33-point grid from RawLab's master recipe LUTs.
- `resources/film_luts/RL·*.cube` and `resources/film_luts/富士·EKTAR 100 Phuket 强（F-Log2）.cube` — RawLab BundledLooks film looks (65-point grids downsampled to 33 points where applicable).
- `src/utils/masterRecipes.ts` — recipe to adjustment mapping (exposure/tint unit conversion, HSL channel order, v4 tone/curve/grading/atmosphere mapping).
- `public/master-recipes/*.png` — recipe artwork.

RawLab is licensed under GPL-3.0-only. This project is distributed under AGPL-3.0, which is
compatible with GPL-3.0, and the complete corresponding source is published in this repository.
