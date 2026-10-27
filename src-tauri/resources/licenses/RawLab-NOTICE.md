# RawLab attribution

Parts of this project's master recipe / film look feature are derived from RawLab:

- Source: https://github.com/Tri250/koudaixiangce
- License: GNU General Public License v3.0 only (full text in `RawLab-GPL-3.0.txt`)

Derived material:

- `resources/master_recipes/master-recipes.json` — master recipe catalogue (14 recipes).
- `resources/film_luts/大师·*.cube` — LUTs downsampled to a 33-point grid from RawLab's master recipe LUTs.
- `src/utils/masterRecipes.ts` — recipe to adjustment mapping (exposure/tint unit conversion and HSL channel order).
- `public/master-recipes/*.png` — recipe artwork.

RawLab is licensed under GPL-3.0-only. This project is distributed under AGPL-3.0, which is
compatible with GPL-3.0, and the complete corresponding source is published in this repository.
