# Image Vault — Architecture Note

_Status: first slice built (not deployed) · Last updated: 2026-11-04_

The first feature being designed. This note captures locked decisions and the proposed
architecture so it's recorded before we move to the next feature.

---

## 1. What it is

Two features that share a screen but little else technically:

1. **Transfer / share** — the AirDrop replacement. Upload many files at once; share to a
   whole group (everyone) or to selected people.
2. **Auto-library** — a Google-Photos-style grid of every image the user has access to,
   with filters for **people**, **places**, and **other** categories.

Designed as two subsystems so the ML sorting work never blocks the simpler, high-value
sharing work.

---

## 2. Locked decisions

| # | Decision |
|---|----------|
| 1 | **"Everyone" = all members of a group.** Sharing targets are a group (all members) or a selected subset of people. |
| 2 | **Uploader controls visibility.** They choose who receives a photo. Non-recipients never see it in their vault. |
| 3 | **Face sorting ("people") ships at launch.** Accepting the biometric tradeoff for now (Google/Apple do it); removable later if it becomes a legal/privacy problem — see §7. |
| 4 | **Scale: hundreds of photos per user now**, scaling later. Clustering can run simply for now; a job queue comes with scale. |

**Sharing targets:** a photo can be shared to a whole **group** (all members) or to
**selected individuals** directly — no group required. Both are handled by `shares`
(`target_type 'group' | 'user'`).

**Recipients' libraries:** a photo shared to a user appears in that user's grid ("images the
user has access to") and is sorted into their people/places/other filters too.

---

## 3. Data model (Supabase / Postgres)

```
groups            id, name, owner, created_at
group_members     group_id, user_id, role
images            id, owner_id, storage_path, taken_at, gps_lat, gps_lng,
                  place_label, width, height, created_at
shares            image_id, target_type ('group' | 'user'), target_id
embeddings        image_id, clip_vector (pgvector)        -- theme/semantic search
faces             id, image_id, bbox, face_vector (pgvector), cluster_id
face_clusters     id, owner_id, label (nullable, user-named "person")
```

- The bucket holds bytes; Postgres is the index. All queries (grid, filters, search) hit
  Postgres, never the bucket directly.
- `place_label` is cached reverse-geocode output so we geocode once, not per view.

---

## 4. Storage & "best definition clarity"

- Supabase Storage bucket, **private by default**.
- Store the **original** for clarity; serve a **thumbnail / transformed** version in the grid
  (Supabase on-the-fly image transforms). Never ship full-res files into a scroll view.
- Upload via **signed direct-to-bucket URLs**, multiple in parallel — files do not proxy
  through our server.

---

## 5. Sorting pipeline (quick + cheap + accurate)

Not one model — four signals, cheapest accurate tool per category. Runs async after upload.

| Sort | Tool | Cost |
|------|------|------|
| **Places** | EXIF GPS → reverse geocode (cache to `place_label`) | ~free; most phone photos carry GPS |
| **Dates / timeline / events** | EXIF `DateTimeOriginal` + time+place clustering | free |
| **People** | Face-embedding model (InsightFace / ArcFace) → `faces.face_vector` → cluster into `face_clusters` | moderate, one-time per image |
| **Themes / semantic search** | CLIP / SigLIP image embedding → `embeddings.clip_vector` | cheap, one-time per image |

**Deliberately out of the hot path:** a multimodal VLM (e.g. Gemma) for a *conversational*
layer ("what did I eat in Rome?") — run **on demand** as RAG over the stored vectors, never
on every upload.

---

## 6. Sharing / access control

- Supabase **Row-Level Security** is the enforcement layer.
- A user can see an image if they are the owner, **or** a `shares` row grants it to them
  directly (`user`) or via a group they belong to (`group`).
- "Everyone" resolves to all current members of the target group at query time.

### Groups & roles

- Two roles in `group_members.role`: **admin** and **member**.
- **Admins** run the group: add/remove members, and **promote members to admin** (so admin
  load can be shared). The creator is the first admin.
- **Members** can see and post to the group but not manage it.

**Removing a member — admin chooses at removal time.** The removal flow prompts the admin:
- **Revoke access** — membership is dropped; live resolution immediately stops the person
  seeing any group photo.
- **Keep what they had** — before dropping membership, we materialize individual `shares`
  rows (`target_type 'user'`) for that person covering photos shared to the group up to that
  moment. They keep those, receive nothing new.

Both options stay available on every removal; the admin decides per case.

---

## 7. Privacy note — faces

Face embeddings are **biometric data** (GDPR Art. 9; laws like Illinois BIPA). We cluster
faces of *other people* in shared photos, not just the uploader. Minimum bar even while
shipping at launch:
- Explicit opt-in/opt-out for face grouping.
- Face vectors scoped per owner; cluster labels never leak across users.
- A kill-switch path so the whole "people" sort can be disabled/removed (decision #3).

---

## 8. UI

Google-Photos-like, two regions:

- **Main panel** — grid of every image the user has access to (own uploads + received),
  newest first, thumbnails.
- **Filter panel** — people (face clusters), places, and other sorts (date, type, etc.).
  Selecting a filter narrows the main grid.

---

## 9. Open / to confirm

- ~~Can you share to individuals outside any group, or is a group always required?~~
  **Resolved:** both allowed — group or ad-hoc individuals.
- ~~Group creation/management flow (who can add members, leave, etc.).~~
  **Resolved:** admin/member roles; admins manage membership and can promote other admins.
- ~~When a member is removed, do they lose access to photos already shared to the group?~~
  **Resolved:** admin chooses per removal — revoke, or keep (materialize per-user `shares`).
- Public web links ever needed, or is all access in-app only? (Current design: in-app only.)

---

## 10. Build status

**Slice 1 is built and tested locally (2026-11-04). It isn't deployed.** It covers:
multi-upload, sharing to a group or chosen people, the library grid, and filters by place,
month, group, and yours vs shared with you. The admin's revoke-or-keep choice on removal is
in, and so are owner edits (who sees it, place name, delete). How it works is in
[ARCHITECTURE.md → Photo vault](../ARCHITECTURE.md#photo-vault).

**Where the build differs from the design above, and why:**

| Design | Built | Why |
|---|---|---|
| New `groups` / `group_members` tables | Uses Wayfarer's trip groups (`money_groups`, `members`). The admin is the trip admin. | The app already has groups with members and an admin. A second set would duplicate them. |
| Admins can promote other admins | Not built. Each group still has one admin. | Shared trips rely on one writer: the admin's browser runs the planner and publishes the plan. A second admin needs that changed first. **Open question.** |
| Supabase RLS enforces access | The server enforces access. The tables have RLS on with no policies, like every other table. | Sign-in is the app's own email accounts, not Supabase Auth, so RLS has no user to check. |
| Supabase on-the-fly image transforms | The browser makes a 640px JPEG thumbnail at upload. | Transforms are a paid-plan feature. |
| `images.taken_at` timestamp | Text, the camera's clock as written | EXIF dates have no time zone. |

**Removal choice:** it applies when an admin removes someone. Leaving on your own or having
your seat released takes group photos away, with no question asked. Deleting a group drops
its shares, and uploaders keep their own photos.

**Before it can go live:**
1. Create a private bucket `vault` in the Supabase project `Wayfarer`, with a 30 MB file
   size limit.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the Railway service.
3. Try a real upload. The Supabase Storage code path (`server/vault/storage.ts`) hasn't run
   against a real bucket yet: dev and the tests use the disk store.

**Next slices:** face grouping (with the opt-in and kill switch from §7), CLIP embeddings
for themes and search, selecting many photos at once, HEIC files, and possibly stripping GPS
from the full-size files others download.
