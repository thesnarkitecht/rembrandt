# Rembrandt brand

The name and logo are trademarks of light.work; see `../TRADEMARKS.md`.

| Mark | File | Idea |
|---|---|---|
| Product mark | `r-mark.svg` (also `rembrandt.svg`) | the R: a bowl and leg in one stroke, with a cut triangle. |
| App icon | `app-icon.svg` → `/app-icon.png` → `npx tauri icon app-icon.png -o src-tauri/icons` | the R mark in gold on a near-black tile |

**Colours.** Bronze belongs to the logo only. The interface is neutral gray, so photos are the
only colour on screen.

| | Dark backgrounds | Light backgrounds |
|---|---|---|
| R mark gradient (top right → bottom left) | `#F4D292` → `#C98F4F` → `#8A5829` | `#D6A458` → `#A8712F` → `#6F4520` |
| Buttons | `#55555E`, white text | `#3D3D45`, white text |
| Accent (slider fill, focus, selection) | `#E4E4E8` | `#2B2B31` |

In the app these are the `--mark-1/2/3` and `--accent*` tokens in `styles.css`.

**Wordmark.** REMBRANDT in capitals with wide tracking (about 0.22em in the app, 0.34em in the intro), in Geist.

**Opening sequence** (`src/splash.js`). The two pieces of the R slide together along the leg's diagonal, a light passes over the gold, and REMBRANDT settles in letter by letter: about two seconds. Any key or click skips it, it plays once per launch, it respects reduced motion, and people can turn it off in Preferences.
