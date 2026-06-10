---
name: This app must deploy as Reserved VM (not autoscale)
description: Why the kot/api-server deployment must be an always-on VM, and that the agent cannot set deploymentTarget.
---

# Deploy this project as a Reserved VM (always-on), not autoscale

Transcription runs as an in-memory, fire-and-forget background job: the upload
route inserts a `processing` row, returns 201 immediately, then continues
`processTranscription` AFTER the response is sent. The client polls the row.

**Why autoscale breaks it:** an autoscale deployment only runs while serving a
request and freezes/scales the instance down once the response is sent — so the
post-response background work never finishes. The row stays stuck `processing`,
and on the next cold start `reconcileStaleTranscriptions()` flips it to `error`.
To the user the recording "uploads fine and then disappears after a while".
This is exactly the symptom that was reported; in dev it works only because the
dev workflow server stays up continuously.

**Fix:** deploy as a Reserved **VM** (always-on). Then the server process stays
alive between requests, so the background job completes and the user can upload,
close the tab, and come back to a finished transcript.

**The agent cannot change this programmatically.** There is no `deployConfig`
callback, and direct edits to `.replit` `[deployment] deploymentTarget` are
blocked by the platform. The deployment type is selected by the user in the
Publishing dialog (choose Reserved VM / always-on) at publish time. Guide the
user to pick it there; do not try to edit `.replit`.

**Residual fragility (acceptable, not yet fixed):** even on a VM, a server
restart mid-job loses the in-memory job (reconcile then marks it `error`). A
fully durable fix would need a real job queue / worker. Out of scope unless
asked.
