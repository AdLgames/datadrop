# freightX

This repository was cleared on 2026-10-02 at the owner's request.

The full Harbour codebase up to that point is preserved in git history, on the branch
`pre-wipe-2026-10-02` (commit `b61ad53`, "Collect AIS in the background and answer every
request from the cache"). To restore it:

```sh
git checkout pre-wipe-2026-10-02
# or, to put it back on main:
git checkout main && git revert --no-edit HEAD && git push
```
