# Wayfarer cookie sync

A Chrome extension that keeps Wayfarer's link reader signed in to the sites that hide posts
behind a login (Instagram, X, LinkedIn, TikTok, Facebook, Threads, YouTube). It sends those
sites' cookies to your Wayfarer server (`PUT /api/money/dev/cookies`) when they change, when
Chrome starts, every half hour, and when you press *Sync now*. A site is only sent once you're
signed in to it in that Chrome.

1. Open `chrome://extensions`, switch on **Developer mode**, choose **Load unpacked** and pick this folder.
2. In Wayfarer, open **Dev tools → Extension** and make a token.
3. Click the extension's icon, paste the token (the address defaults to the live site) and press **Save and sync**.

The cookies are a signed-in session for that account: use an account you're happy for the
Wayfarer server to browse with, and revoke the token in Dev tools if this Chrome is lost.
