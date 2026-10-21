---
'diffloupe': patch
---

Fix console windows flashing open and closed on Windows. The background server has no console, so each git or language tooling command it ran opened a new one; these now run hidden.
