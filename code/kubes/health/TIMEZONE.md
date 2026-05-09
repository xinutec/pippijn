# Timezone handling

Two data sources with different timestamp semantics:

## PhoneTrack (Nextcloud)

- Stores **UTC unix timestamps** (seconds since epoch)
- `getTimestamp()` in PHP returns UTC
- Owntracks sends UTC unix timestamps
- **Display:** convert to user's browser timezone
- **Date boundaries:** "today" in user's timezone = UTC midnight ± offset

## Fitbit

- API returns times in the **user's Fitbit profile timezone**
- Stored in MariaDB as DATETIME without timezone info
- The mariadb driver may add a misleading "Z" suffix — ignore it
- **Display:** extract time components directly from the string,
  do NOT parse with `new Date()` (that would apply UTC interpretation)

## Frontend approach

- The frontend sends the browser's timezone offset with API requests
  that need date boundaries (via `Intl.DateTimeFormat().resolvedOptions().timeZone`
  or a simple `tz` query parameter)
- PhoneTrack data: backend converts UTC timestamps to the user's timezone
  before slicing by date
- Fitbit data: already in local time, no conversion needed
- The `time-utils.ts` `formatLocalTime()` function handles Fitbit's
  misleading "Z" suffix by extracting hours/minutes from the string directly
