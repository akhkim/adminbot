# IP geolocation

AdminBot geolocates the IP address of each successful sign-in, and again once a day on any
authenticated request, and stamps the result on the member record. The country is shown to the
member and to admins, and the city places the member on the lab member map for 7 days after the
latest reading, unless the member chose "My stated city only" or "Hidden" in Profile, or the
reading looks like a VPN (see "Daily reading" and "VPN check" below).
Only the place names are stored: the city, the region, the country, the continent and the time
zone. Coordinates are never stored or returned, and the map pins every member on the centroid of a
city or country from its own gazetteer.

## Providers

The service picks the first configured provider and logs the choice once at startup
(`AdminBot IP geolocation: ...`):

| Setting                    | Provider                    | Answers                                                          |
| -------------------------- | --------------------------- | ---------------------------------------------------------------- |
| `ADMINBOT_GEOIP_MMDB_PATH` | Local `.mmdb` city database | City, region, country, continent, zone                           |
| `IPINFO_TOKEN`             | IPinfo API                  | Country and continent on the free Lite tier; city on a paid plan |
| neither                    | Off                         | Nothing is stamped                                               |

The local database is the default choice. Lookups are made in process, so no member's IP address
leaves the host, nothing is rate-limited, and nothing is charged. The service reads
[DB-IP "IP to City Lite"](https://db-ip.com/db/download/ip-to-city-lite) (CC BY 4.0) and
MaxMind GeoLite2-City, because both use the same format. Private, loopback, link-local and CGNAT
(100.64.0.0/10) addresses are never looked up.

## Daily reading

A session lasts weeks, so a city read only at sign-in is weeks old for most members, and most
of the map ends up placed "from profile". Every authenticated member request therefore goes through `noteAccountUse` in
`extensions/adminbot/src/workflows/identity/auth.ts`, which takes a new reading:

- **Once per member per UTC day**, plus once more whenever the address or the browser's time zone
  changes during the day. The day is kept in memory and, after a restart, read back from the
  member's `last_ip_observed_at`, so a restart does not cost a second lookup.
- **Same pipeline as sign-in.** The same geolocator, the same `remoteIp()` and trusted-proxy rules,
  and the same append-only location history with `source: "login_ip"`. The history gets one row
  per day (or per change of country or VPN verdict), so it shows the member was still there.
- **Fire-and-forget.** The request never waits on it. Any error, including a geolocator that
  throws, is caught and logged (`adminbot: daily IP check failed: ...`, never with the address),
  and never reaches the request.
- **Skipped** for members whose map visibility is "stated" or "hidden", for impersonated ("view
  as") sessions, and for service tokens, which never resolve to a member session.

The time of the reading is `last_ip_observed_at`. `last_login_at` stays the time of the last
sign-in. The map ages the city by the reading and labels it "IP today", "IP yesterday" or "IP 3d
ago".

**Why 7 days** (`ADMINBOT_MAP_LOGIN_FRESH_DAYS`, previously 14). With daily readings an active
member's city is never more than a day old, so the window only decides how long a member who
stopped using AdminBot keeps their last IP city. A week covers a weekend, a conference trip or a
few days off without the pin flickering. Past that the member falls back to their check-in answer,
their stated city, then their device or Slack time zone, which says more than a two-week-old
network address.

## VPN check

An IP city is the location of the network exit, which for a VPN user is the VPN's city. The
Control UI therefore sends the browser's own clock with every AdminBot request:
`X-AdminBot-Device-TZ` (the IANA zone name from `Intl.DateTimeFormat().resolvedOptions().timeZone`)
and `X-AdminBot-Device-TZ-Offset` (minutes east of UTC). Only the zone name: no coordinates, and no
browser prompt. It is stored as `last_device_tz` / `last_device_tz_at` and appended to the location
history as `source: "device_timezone"` when it changes. `UTC` and `Etc/*` zones are ignored,
because privacy-hardened browsers report them whatever the real clock is.

Each reading compares the UTC offset of the IP city's zone with the device zone from the same
request (else the member's Slack zone), at that instant, through `Intl`, so daylight saving is
handled. If they are more than two hours apart, the reading is marked `suspected_vpn`:

- it is still logged in the history, with `suspected_vpn: true`, and audited as
  `auth.login_location_suspected_vpn`;
- it does **not** replace the member's stored city, is not attached to the sign-in event, and does
  not trigger meetup intros;
- the member record gets `last_ip_suspected_vpn: true`, and the map places them by the next source
  (check-in, stated city, device-zone city, Slack-zone city, country). The admin map adds "IP
  ignored (VPN?)" to that member's row;
- with no recent check-in answer, the one-tap check-in is shown with reason `ip_suspected_vpn` and
  a guess from the device zone, then the Slack zone ("Are you in Zürich?").

A reading taken before this check existed carries no flag. The map applies the same comparison to
it at render time, against the device zone, else the Slack zone. An unknown is not a conflict: with
neither zone available, the reading is trusted.

City and event meetup intros use the same rule (`ipReadingSetAside` in `member-map.ts`, read by
`signInPlace` in `meetups.ts`). A reading the map sets aside never puts anybody in a city for an
intro, whether the intro comes from the sign-in hook, the daily reading or the hourly sweep, so a
VPN exit in Toronto cannot produce "you're both in Toronto".

An ASN check (DB-IP ASN Lite, to recognise hosting and VPN providers by network) was considered and
left out. It would need a second database, its own refresh job and a maintained list of VPN ASNs,
and the clock comparison already catches the case that matters: a member whose IP city is in a
different part of the world from their laptop.

There is no separate daily job. A reading needs a request with an address, so a job could only
invent one; the map memo already rebuilds hourly, which keeps the "IP today" ages current.

## Production setup

### Installed by every Aurora deploy

Each Aurora deploy turns sign-in geolocation on by itself. `deploy/aurora/auto-deploy.sh` runs
`deploy/aurora/install-geoip.sh` after the new release has built and before the swap, so the restart
that follows picks up anything it changed. The script:

1. Finds the env file the `jinesis-adminbot` unit actually reads by asking systemd, instead of
   assuming a path.
2. Appends `ADMINBOT_TRUST_PROXY=1` if the file does not set it. The service listens only on
   loopback behind the Cloudflare tunnel, so without this every sign-in would come from
   `127.0.0.1`, which is never looked up.
3. Installs the database at `<deployment root>/geoip/dbip-city-lite.mmdb`, beside the releases, so
   every release reads the same file. It uses `scripts/adminbot-geoip-refresh.sh` (see below). A
   file younger than 32 days (`GEOIP_MAX_AGE_DAYS`) is kept, because the monthly cron job keeps it
   current.
4. Appends `ADMINBOT_GEOIP_MMDB_PATH` once the file exists, again only if the key is missing.

It only ever appends a key that is missing, under a dated `# Added by deploy/aurora/install-geoip.sh`
comment. An operator's own value is never rewritten, including an explicit
`ADMINBOT_TRUST_PROXY=0` or a different database path.

**A failure never blocks the deploy, but it is loud.** A failed download leaves the service exactly
as it was. Every failure is printed as a GitHub Actions `::warning title=IP geolocation::`
annotation, which appears on the run summary. The workflow's next step, "Check IP geolocation" in
`.github/workflows/deploy-aurora.yaml`, reads the service's own `AdminBot IP geolocation:` startup
line from the journal and warns again if it says `off`. When you see that warning, run the refresh
by hand (step 1 below) and restart.

Admins can also see the state without the logs. The admin member map ends with a status line,
"Sign-in geolocation is on (mmdb)." or "Sign-in geolocation is off: members are placed by what they
state and their time zone." It comes from the `ip_geolocation: { active, provider, trust_proxy }`
field of the admin `GET /member-map` response, where `provider` is `mmdb`, `ipinfo` or `off`. The
field never carries the database path or a token, and the public summary never carries it at all.

### By hand (other hosts, or to repair a failed install)

1. Install the database from the deployed `openclaw-adminbot` directory. Put it on a volume with
   room. The file is roughly 130 MB, and while it refreshes the compressed download sits beside it.
   Do not put it on `/w/406`, which is a 2.1 GB volume that has filled before (see
   [the Aurora deploy notes](../deploy/aurora-adminbot.md)). It is read-only data, so a network
   mount is fine for it, unlike SQLite:

   ```bash
   bash scripts/adminbot-geoip-refresh.sh <deployment root>/geoip/dbip-city-lite.mmdb
   ```

   The script downloads this month's file, or last month's when this month's is not published yet.
   It checks that the file gunzips and opens as a city database, then renames it into place. A
   failed run leaves the existing file untouched.

2. Set the path in the AdminBot env file (on Aurora, `/w/406/adminbot/secrets/adminbot.env`):

   ```bash
   ADMINBOT_GEOIP_MMDB_PATH=<deployment root>/geoip/dbip-city-lite.mmdb
   ```

   The cron wrappers read `~/.config/jinesis-adminbot/adminbot.env` first. If that is not the same
   file (or a link to it), set the variable there as well, so the monthly refresh knows where to
   write.

3. Restart the service, then check the startup line:

   ```bash
   scripts/aurora-adminbot-host.sh --user <cs-user> restart
   scripts/aurora-adminbot-host.sh --user <cs-user> logs adminbot | grep "IP geolocation"
   # AdminBot IP geolocation: local city database at /.../dbip-city-lite.mmdb (city-level)
   ```

4. Keep it current. `adminbot-geoip-refresh` is in `config/adminbot-cron.json` and runs at 04:25
   on the 3rd of each month. Register it with
   `bash scripts/adminbot-cron-sync.sh --only adminbot-geoip-refresh`. The service notices the
   replaced file by its modification time and reloads it on the next sign-in, so no restart is
   needed. Until `ADMINBOT_GEOIP_MMDB_PATH` is set, the job reports a skip and exits 0.

### Using MaxMind GeoLite2 instead

GeoLite2-City needs a free MaxMind account and licence key, and MaxMind's `geoipupdate` refreshes
it. The refresh script above only fetches DB-IP. Point `ADMINBOT_GEOIP_MMDB_PATH` at
`GeoLite2-City.mmdb`. The map then credits MaxMind instead of DB-IP, because the credit is chosen
by the file name.

## Attribution

DB-IP Lite is licensed CC BY 4.0, and the credit has to appear wherever its data is shown. The
service sends the credit with `GET /member-map` whenever a provider is configured, and the map
card shows it as a link: "IP geolocation by DB-IP" pointing to https://db-ip.com. The credit names
MaxMind for a GeoLite2 file and IPinfo for the IPinfo provider. Do not remove it.

## What to expect

- **Accuracy.** A city from an IP address is approximate. Mobile carriers and university networks
  often surface in a nearby or head-office city, and VPNs anywhere (see "VPN check"). The member map
  labels these places "IP today" (or yesterday, or N days ago) and uses them for 7 days after the
  latest reading. After that the member falls back to the city they stated. A member who prefers
  their stated city can choose "My stated city only" in Profile.
- **No backfill.** Sign-in events store no IP address, so past sign-ins cannot be located again.
  Cities fill in as each member next uses AdminBot. If a sign-in locates only a country, the stored
  city and region are cleared, so a stale city cannot outlive a newer sign-in.
- **Unknown cities.** The provider can name a city the gazetteer does not have. The member is then
  placed at the country, never at a guessed city. Add the city to `GAZETTEER` in
  `extensions/adminbot/src/workflows/members/member-map.ts` to place it.
- **Behind a proxy.** The service sees the proxy's address unless `ADMINBOT_TRUST_PROXY=1` is set.
  With it set, the client address is `CF-Connecting-IP` when present (Cloudflare writes it and
  overwrites any value a client sent), otherwise the right-most `X-Forwarded-For` entry, which is the
  one the nearest proxy appended. The left-most entry is never used, because a client can write it.
  See "Login location" in [AdminBot](adminbot.md).
- **Not the only signal.** A sign-in city is one of several. Members also confirm where they are in
  a one-tap check-in, and their Slack time zone is a cross-check. See "Member map" in
  [AdminBot](adminbot.md).
