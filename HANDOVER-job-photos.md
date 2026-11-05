# Handover: job photos on Reverb job cards

**Goal:** opening a job card in Reverb (tap **details**) should show the job's
photos from switch-craft-booking, so it's clear what the job actually is.

## Status

| Repo | Branch | State |
|---|---|---|
| `reverb` | `ccr-5589bfce-rsak6n` | Done, pushed (commit `20e1d4c`). Not merged. |
| `switch-craft-booking` | none yet | **Not done.** Patch below; the earlier session had no push access. |

Until the booking app change is deployed, Reverb behaves as before: it shows
the "N photos" count and no thumbnails. The Reverb change handles a missing
`photos` field without errors.

## What Reverb now does (already pushed)

- `src/lib/tools.js`, `getSwitchcraftJobs()`: maps the feed's `j.photos` to
  `photos: [{ id, name }]` (keeps integer ids only).
- `server.js`, `collectGroundedItems()`: passes `photos` through onto job items.
- `server.js`: new `handleJobPhoto` + route `GET /api/job-photo/:id` (numeric
  id). It requires Reverb's PIN auth and fetches
  `${SWITCHCRAFT_BASE_URL}/api/photos/:id`, returning only `image/*` content.
  Cache header: `private, max-age=86400`.
- `src/components/ItemCard.jsx`: `JobPhoto` / `JobPhotos` components in the
  `Facts` (details) view, under the "notes · photos" line. Images are fetched
  as blobs with the bearer token, because `<img src>` can't carry the token,
  and only when the card is expanded. Tapping a thumbnail opens the existing
  `.lightbox`, portalled to `document.body` because deck cards sit inside a
  `transform`.
- `vite build` and `node --check server.js` pass. **Not tested against live
  data**, because the feed doesn't send ids yet.

## Remaining work

1. **switch-craft-booking:** apply this patch to `server.js`
   (`GET /api/reverb/jobs`), commit, push, and deploy:

   ```diff
   @@ -763,6 +763,11 @@ app.get('/api/reverb/jobs', async (req, res) => {
                COALESCE((SELECT json_agg(json_build_object('text', t.text, 'done', t.done) ORDER BY t.created_at)
                          FROM job_tasks t WHERE t.job_id = j.id), '[]') AS tasks,
                (SELECT COUNT(*) FROM job_photos p WHERE p.job_id = j.id)::int AS photo_count,
   +            -- Ids only, no bytes: Reverb fetches each image from /api/photos/:id
   +            -- when the card is opened, so the feed stays small.
   +            COALESCE((SELECT json_agg(json_build_object('id', p.id, 'original_name', p.original_name, 'task_id', p.task_id)
   +                                      ORDER BY p.uploaded_at)
   +                      FROM job_photos p WHERE p.job_id = j.id AND p.data IS NOT NULL), '[]') AS photos,
                (SELECT COUNT(*) FROM job_notes n WHERE n.job_id = j.id)::int AS note_count,
   ```

   `p.data IS NOT NULL` skips old rows from before photos were stored in
   Postgres, which `/api/photos/:id` would 404 on anyway.
2. **Merge/deploy reverb** branch `ccr-5589bfce-rsak6n`.
3. **Verify end to end:** regenerate the To-do report, then open job #28
   (Patrick Monaghan / Murphys, 3/164 Ryrie Street, 4 photos). Thumbnails
   should load, and tapping one should open it full screen.
   Note: the report is cached (it shows "last generated Xh ago"), so cards
   from before the deploy have no `photos` field until you **Regenerate now**.

## Worth considering (not done)

- **Booking app `/api/photos/:id` is public.** It needs no auth and uses
  sequential ids, so anyone can enumerate client photos. Reverb's proxy is
  PIN-guarded, but the upstream URL isn't. Options: require the feed key
  (`?key=CAL_FEED_KEY`) or an admin/client token on that route, and update the
  booking app's own `<img>` usages to match (they currently rely on it being
  open). If you add the key, Reverb's `handleJobPhoto` must append
  `?key=${process.env.SWITCHCRAFT_FEED_KEY}`.
- `task_id` is in the feed but unused by Reverb. You could group photos under
  the checklist line they belong to.
- Phone photos can be up to 10 MB each, and the proxy buffers them whole.
  That's fine at this scale. If it becomes slow, add a thumbnail size on the
  booking side.
