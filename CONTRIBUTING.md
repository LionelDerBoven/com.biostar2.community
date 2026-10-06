# Contributing

Thank you for taking the time to contribute.

This is a community app for Homey Pro that connects to Suprema BioStar 2. It is
not affiliated with Suprema Inc., and it is not an Athom project either — please
do not raise BioStar 2 app issues with Athom or with Suprema support. Open them
on this repository.

## Before submitting a bug or feature request

- Have you read the error message in the app's **Live Logs** tab?
- Have you searched for a similar issue?
- Have you updated Homey, this app, and the Homey CLI?
- Have you checked whether BioStar 2 itself reports the same problem in its own
  event log? If the event never reaches BioStar 2, it cannot reach Homey.
- Have you confirmed the BioStar 2 account has the permissions the app needs
  (Monitoring, at Edit level for the *Open door* card)? **Test Connection**
  reports what the account can actually do.

## A great bug report contains

- What you were trying to achieve.
- Detailed steps to reproduce from scratch.
- The relevant part of the Live Logs, and the BioStar 2 event name involved.
- Your BioStar 2 version and Homey Pro firmware version.
- Any theory you have about the cause.

**Please redact before posting.** Logs and event data from an access control
system identify real people and real doors. Remove user names, user IDs, email
addresses, telephone numbers, door names, hostnames and IP addresses. Turning
off *Show user names in the activity log* in the Advanced tab before reproducing
is the easiest way to get a shareable log.

## A great feature request contains

- The current situation, and why it is a problem.
- A use case: who needs this and why.
- Any caveats you can think of.

## A great pull request contains

- Minimal changes, relevant to one issue only.
- Code matching the existing conventions. `npm run lint` must pass.
- `homey app validate --level publish` passing.
- No real host names, addresses, credentials or personal data — not in code,
  not in comments, not in test fixtures, not in commit messages.
- User-facing strings added to `locales/en.json`, `nl.json` and `fr.json`, and
  to every language block in `.homeycompose/`. Run `homey app build` to
  regenerate `app.json`; do not edit `app.json` by hand.
- Relevant documentation updates.
