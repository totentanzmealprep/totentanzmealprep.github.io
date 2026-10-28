# Totentanz Meal Prep

Meal planning site for two cookbooks, live at https://totentanzmealprep.github.io.

Recipe text and photos are published only as encrypted files (`data.bin`, `photos/*.bin`); the passcode unlocks them in the browser. Household picks, shopping checkmarks, notes and ratings sync through Supabase (`tools/supabase-setup.sql`). `.github/workflows/supabase-keepalive.yml` reads from the database every 2 days so the free project doesn't pause.

To rebuild after changing the source page (run from the repo root):

```
python3 tools/build_meals.py <source page .html> <photos dir> . <passcode> --supabase-url <url> --supabase-key <publishable key> --demo
```
