# Release Notes

Dnešní stav aplikace je uzavřený do pěti dokončených tasků:

- Task 1: metodika logging včetně `METHODOLOGY_LOG` a PDF sekce.
- Task 2: confidence scoring v UI i PDF.
- Task 3: fuzzy deduplikace entit v UI i PDF.
- Task 4: ruční validace entit v Case tabu včetně perzistence do `localStorage`.
- Task 5: nový PDF report se 7 sekcemi a vícestránkovým výstupem.

Ověření:

- PDF report byl testován na dotazu `test person`.
- Výstup měl 9 stran.
- V reportu byly přítomné všechny požadované sekce včetně titulní strany, metodiky, relevance, deduplikace, rizik, shrnutí a příloh.

Commity:

- `3f25b9d` Task 1
- `24fa892` Task 2
- `5351094` Task 3
- `1b16a61` Task 4
- `f5d3ace` Task 5

Poznámka:

- Pracovní strom obsahuje velké množství dalších staged změn mimo tyto tasky. Neprováděl jsem jejich úklid, aby nebyly dotčeny cizí nebo nesouvisející změny.
