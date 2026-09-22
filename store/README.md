# Publishing SlotHunter

Three things happen here: host the privacy policy, build the zip, submit. `LISTING.md` holds
every piece of text to paste.

---

## 1. Host the privacy policy

The Web Store will not accept a submission without a public policy URL. GitHub Pages is free
and takes about two minutes.

1. Create a **new public** repo named `slothunter-privacy`
2. Upload `store/privacy-policy.html` and rename it `index.html`
3. Settings → Pages → Source: `main`, folder `/root` → Save
4. Wait a minute, then confirm `https://<username>.github.io/slothunter-privacy/` loads

The page contains no client data and no secrets — it is safe to make public. Do **not** make
the extension repo itself public.

Paste that URL into `LISTING.md` where it says `<your-github-username>`.

---

## 2. Build the zip

From the repo root:

```bash
cd extension && zip -r ../slothunter-5.0.0.zip . -x '*.DS_Store' && cd ..
```

Check before uploading:

```bash
unzip -l slothunter-5.0.0.zip | grep -E 'manifest|content\.js' ; unzip -p slothunter-5.0.0.zip manifest.json | grep -E '"name"|checkvisaslots'
```

Expected: `manifest.json` present, **no** `content.js`, name is `SlotHunter` (not `SlotHunter TEST`),
and **no** checkvisaslots match.

Build from the **production** folder, never the test worktree — the test build has `TEST_MODE = true`,
a `TEST-` device prefix and a different extension name.

---

## 3. Submit

Go to the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) — $5 one-time
registration.

New item → upload the zip → fill in every field from `LISTING.md` → **Visibility: Unlisted** →
Submit.

Unlisted means installable by anyone with the link but absent from search. That is what you want
for a team of six.

Review is typically a few days. Extensions with broad host permissions get looked at harder, which
is why each permission justification names a specific feature rather than waving at "functionality".

---

## 4. After approval — do not skip this

Google assigns a permanent extension ID on publication. Google Sheets sign-in is tied to that ID
and **will fail silently until you register it**:

1. Copy the extension ID from the dashboard
2. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → Credentials
3. Open the OAuth client `245548528538-lsok9hd7ons1tt97v4e7ftlrpqnqgec1...`
4. Set the Application ID to the new extension ID → Save

Then send the install link to your staff. Updates from here on are: bump `version` in
`manifest.json`, rebuild the zip, upload a new package. Everyone updates automatically — no
reloading, no developer mode.

---

## If it is rejected

Rejections come with a specific policy reference. Most common for a tool like this:

- **Single purpose** — answer with the statement in `LISTING.md`; the extension does one thing
- **Permission not justified** — they want a named feature, not a category
- **Insufficient privacy disclosure** — check the policy page covers what the manifest requests

A rejection is a revise-and-resubmit, not a ban. Keep the unpacked install working for the team
until the listing is live.
