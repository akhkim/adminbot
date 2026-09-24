# AdminBot Offline Workspace for Chrome

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select this directory. Pin the extension, enter your HTTPS portal URL, and open it.
On the first online visit, wait for **Offline access · Ready on this device** and visit
records you want to read. Supported forms save manual drafts locally.

The extension is a launcher into the existing portal's offline application, not a second
copy of its database. It can open the portal without networking once the portal's service
worker has installed. It requests local settings storage only: no host permissions,
content scripts, record access, credentials, or remote code. Store publication is separate.

On phones, open the portal in the phone browser and install/add it to the Home Screen.
Prepare that installed app online before using it offline. Desktop browser storage does
not transfer to the phone: drafts transfer through authenticated server sync.
