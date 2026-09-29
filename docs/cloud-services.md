# Google Photos, Google Drive, Dropbox, OneDrive and Lightroom

Rembrandt talks to these services straight from your browser, with your own (free) developer keys.
No Rembrandt server is involved and nobody else sees your photos. A service without keys shows as
"Coming soon" in Import and isn't offered in Export.

Where to put the keys:

- **rembrandt-server**: in `~/.config/rembrandt/server.conf`, one per line, then restart the server:
  ```
  googleClientId = 1234-abc.apps.googleusercontent.com
  googleApiKey = AIza…
  googleAppId = 123456789012
  dropboxAppKey = abcd1234
  onedriveClientId = 00000000-0000-0000-0000-000000000000
  adobeClientId = …
  supportUrl = https://github.com/sponsors/you
  ```
- **Your own static hosting**: a script before the app, `<script>window.LUMEN_CONFIG = { googleClientId: '…' }</script>`.
- **Desktop builds**: set the repository variable `LUMEN_CONFIG_JS` to that same `window.LUMEN_CONFIG = {…}`
  script; `scripts/build-web.mjs` bakes it in.

Each service only accepts the addresses you register with it, so register the exact address you
open Rembrandt at (for example `http://localhost:8420` for rembrandt-server, or your HTTPS domain).
rembrandt-server always links to `http://localhost:<port>`, so keys registered for
`http://localhost:8420` work on every install that keeps the default port.
Browser sign-in pop-ups need a secure address: `localhost` counts as one; anything else needs HTTPS.

## Google Photos and Google Drive
1. In [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. Enable the **Google Photos Picker API** (and, for Drive, the **Google Picker API** and **Google Drive API**).
3. *Credentials → Create credentials → OAuth client ID → Web application.* Add your address under
   *Authorized JavaScript origins*. The client ID is `googleClientId`.
4. For Drive, also create an **API key** restricted to the Picker API (`googleApiKey`); the project
   number is `googleAppId`.
5. While the app is in *Testing*, add your Google account as a test user.

Google only lets apps see the photos you pick, so Google Photos works as “pick and link”: the
originals stay in Google Photos, and Rembrandt keeps your edits and a preview.

## Dropbox
Create an app at [dropbox.com/developers](https://www.dropbox.com/developers/apps) (*Scoped access →
App folder*). The app key is `dropboxAppKey`. Add your address under *Chooser / Saver / Embedder
domains* and `<address>/auth-callback.html` under *Redirect URIs*.

## OneDrive
Register an app in [Microsoft Entra](https://entra.microsoft.com/) → *App registrations*. Platform:
**Single-page application**, redirect URI `<address>/auth-callback.html`. The *Application (client)
ID* is `onedriveClientId`.

## Adobe Lightroom (cloud)
In the [Adobe Developer Console](https://developer.adobe.com/console), create a project, add the
**Lightroom API**, and choose **OAuth Single-Page App** with redirect URI `<address>/auth-callback.html`.
The client ID is `adobeClientId`. Lightroom Classic catalogs (`.lrcat`) import without any keys.
