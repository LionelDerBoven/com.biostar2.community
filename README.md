# BioStar 2 Community

A [Homey Pro](https://homey.app) app that connects a **Suprema BioStar 2** access
control server to Homey over your local network, and exposes its events as native
Homey Flow cards.

Homey Pro talks to BioStar 2 directly over TLS — REST for login and lookups, a
WebSocket for the live event stream. There is no cloud service, no polling and no
bridge machine in between.

```
[ Readers ] → [ BioStar 2 Server ] ⇄ TLS REST + WebSocket ⇄ [ Homey Pro ]
                                                                  │
                                                            Flow triggers
```

---

## Requirements

- Homey Pro, firmware **12.4.0** or newer
- A BioStar 2 server reachable from Homey on the local network
- A BioStar 2 account for the app to log in with

The account needs **Monitoring** permission to receive events. If you want to use
the *Open door* action it also needs **Door control**. The app warns you in
Settings when the account it is using lacks the permissions it needs.

Give the app its own BioStar 2 account rather than reusing an administrator
login — it makes the access log readable and lets you revoke it independently.

## Installing

Homey CLI, from this folder:

```bash
npm install
homey app install     # install onto your Homey Pro
homey app run         # or run it live, with the log in your terminal
```

## Configuration

Everything is configured in the app's Settings screen in the Homey app.

### Connection

| Setting | Notes |
| --- | --- |
| **BioStar 2 Host URL** | e.g. `https://biostar.example.com` |
| **WebSocket URI** | Leave empty to derive it from the host URL |
| **API Username** | The BioStar 2 login id the app uses |
| **API Password** | Stored by Homey; leave the field untouched to keep the current one |
| **Verify SSL/TLS Certificate** | Uncheck if BioStar 2 uses a self-signed certificate |

**Test Connection** checks the credentials and reports what the account is
allowed to do. **Force Reconnect** tears the session down and builds a new one.

### Advanced

- **Event types seen** — every event name BioStar 2 has actually sent since the
  app started, most frequent first, with counts. Tick one to drop it before any
  processing, so you filter by picking from a list instead of typing exact names.
- **Ignored event names (contains)** — one fragment per line; any event whose
  name contains a fragment is dropped.
- **Show user names in the activity log** — on by default. Turn it off to keep
  identifiable access data out of the log view; entries then read
  `User: <hidden>`. This affects the log only — Flow tags always carry the real
  user. The log is in-memory and cleared when the app restarts.
- **Heartbeat interval** — how often the app pings BioStar 2. The connection is
  treated as dead after twice this long without a reply.
- **Reconnect delay, first attempt / maximum** — the delay grows by 50% after
  each failed attempt, up to the ceiling.

## Flow cards

### Triggers

| Card | Fires when |
| --- | --- |
| **Authentication succeeded** | BioStar 2 accepts a credential at a reader |
| **Access denied** | BioStar 2 refuses access — no permission for that door, or outside the access schedule |
| **Identification failed** | A credential was presented but nobody was recognised |
| **BioStar 2 event received** | Any event that survives the ignore lists — the catch-all |

Each trigger takes an optional **Reader** argument, so a Flow can respond to one
reader instead of all of them. Leaving it on *Any reader* matches everything. The
picker lists only devices that can actually authenticate, so slave I/O modules
stay out of the way.

Triggers carry these tags: `user`, `user_id`, `login_id`, `user_group`,
`department`, `email`, `telephone`, `device`, `event_name`, `event_type`,
`title`, `timestamp`. Where BioStar 2 did not recognise the person, the user tags
read `N/A`.

The timestamp is BioStar 2's own, not the moment Homey processed the event, and
events reach Flows in the order the server produced them.

### Conditions

| Card | True when |
| --- | --- |
| **BioStar 2 connection is online** | The app has a live session and is receiving events |
| **User is …** | The event's user matches |
| **User belongs to group …** | The event's user group matches |
| **User belongs to department …** | The event's department matches |
| **Device is …** | The event came from that reader |

### Actions

| Card | Does |
| --- | --- |
| **Open door** | Momentarily releases a door, the same as *Open Door* in the BioStar 2 console |
| **Force reconnect to BioStar 2** | Rebuilds the session — useful after a server restart |

## How it works

- **`lib/BiostarClient.js`** — logs in over REST to obtain a `bs-session-id`,
  opens the WebSocket, registers the session, subscribes with
  `POST /api/events/start`, then keeps the link alive with a heartbeat and
  reconnects with exponential backoff. Sockets and timers are torn down on every
  reconnect, so nothing leaks across a long uptime.
- **`lib/EventMapper.js`** — drops background noise (door lock/unlock, enrolment,
  time sync) before any lookup happens, then classifies what remains into the
  trigger categories above.
- **`app.js`** — owns the Flow cards, a bounded user cache so repeated events
  don't re-query the server, and the in-memory activity log shown in Settings.

Filtering happens before lookups, so ignored events cost almost nothing and the
app stays idle when nothing relevant is going on.

## Privacy

Access control data is sensitive. This app is built so it stays on your network:

- Events travel only between BioStar 2 and your Homey Pro, over your LAN.
- Nothing is sent to any third-party service, and the app requests no Homey
  permissions.
- The activity log lives in memory only and is cleared when the app restarts.
- User names can be hidden from that log with a single setting.

## Trademarks and affiliation

This is an unofficial community app. It is not affiliated with, authorised by,
endorsed by, or in any way officially connected with Suprema Inc.

"Suprema" and "BioStar" are trademarks of Suprema Inc. They are used here only to
describe which system this app interoperates with, which is nominative fair use.
No Suprema artwork, branding, logo, icon or other asset is included or reproduced
in this app.

All artwork in this app is original work created for it, generated from a script
kept with the project sources.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

[GPL-3.0](LICENSE) © LDB Technology
