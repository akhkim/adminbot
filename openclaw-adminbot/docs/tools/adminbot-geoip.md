# IP geolocation

AdminBot geolocates the IP address of each successful sign-in and stamps the result on the member
record. The country is shown to the member and to admins, and the city helps place the member on
the admin member map for three days. Only the place names are stored: the city, the region, the
country, the continent and the time zone. Coordinates are never stored or returned, and the map
pins every member on the centroid of a city or country from its own gazetteer.

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

## Production setup

1. Install the database once, from the deployed `openclaw-adminbot` directory. Put it on a volume
   with room. The file is roughly 130 MB, and while it refreshes the compressed download sits
   beside it. Do not put it on `/w/406`, which is a 2.1 GB volume that has filled before (see
   [the Aurora deploy notes](../deploy/aurora-adminbot.md)). It is read-only data, so the network
   mount is fine for it, unlike SQLite:

   ```bash
   bash scripts/adminbot-geoip-refresh.sh /mfs1/u/<cs-user>/jinesis-adminbot/geoip/dbip-city-lite.mmdb
   ```

   The script downloads this month's file, or last month's when this month's is not published yet.
   It checks that the file gunzips and opens as a city database, then renames it into place. A
   failed run leaves the existing file untouched.

2. Set the path in the AdminBot env file, `/w/406/adminbot/secrets/adminbot.env`:

   ```bash
   ADMINBOT_GEOIP_MMDB_PATH=/mfs1/u/<cs-user>/jinesis-adminbot/geoip/dbip-city-lite.mmdb
   ```

   The cron wrappers read `~/.config/jinesis-adminbot/adminbot.env` first. If that is not the same
   file (or a link to it), set the variable there as well, so the monthly refresh knows where to
   write.

3. Restart the service, then check the startup line:

   ```bash
   scripts/aurora-adminbot-host.sh --user <cs-user> restart
   scripts/aurora-adminbot-host.sh --user <cs-user> logs adminbot | grep "IP geolocation"
   # AdminBot IP geolocation: local city database at /mfs1/.../dbip-city-lite.mmdb (city-level)
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

- **Accuracy.** A city from an IP address is approximate. Mobile carriers, VPNs and university
  networks often surface in a nearby or head-office city. The member map labels these pins "city ·
  from last sign-in (approx.)", ranks them below any city the member stated, and uses them for three
  days after the sign-in.
- **No backfill.** Sign-in events store no IP address, so past sign-ins cannot be located again.
  Cities fill in as each member next signs in. If a sign-in locates only a country, the stored
  city and region are cleared, so a stale city cannot outlive a newer sign-in.
- **Unknown cities.** The provider can name a city the gazetteer does not have. The member is then
  placed at the country, never at a guessed city. Add the city to `GAZETTEER` in
  `extensions/adminbot/src/workflows/members/member-map.ts` to place it.
- **Behind a proxy.** The service sees the proxy's address unless `ADMINBOT_TRUST_PROXY=1` is set.
  See "Login location" in [AdminBot](adminbot.md).
