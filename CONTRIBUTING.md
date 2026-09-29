# Contributing

Thank you for helping. Bug reports, camera samples that don't open, translations and fixes are all
welcome.

## Before you open a pull request

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Run `npm run check` (syntax check of every module) and try your change in the browser
  (`npx http-server -c-1 .`) or the desktop app (`npm run tauri dev`).
- Keep the style of the surrounding code: plain ES modules, no build step, no new dependencies
  without a good reason.

## Licence

Rembrandt is free software under the GNU General Public License v3 or later. By contributing you
agree that your contribution is released under the same licence. Please sign off your commits
(`git commit -s`) to confirm you wrote the change or have the right to submit it
([Developer Certificate of Origin](https://developercertificate.org/)).
