# OSINT Finder

OSINT Finder je lokalni webova aplikace ([index.html](index.html) + [app.js](app.js) + [style.css](style.css)), doplnena o backend pro foto vyhledavani v [server.js](server.js).

## Co aplikace umi

- textove OSINT hledani podle jmena, nicku, mesta a telefonu,
- vyhledavani podle fotografie z URL nebo pres lokalni backend,
- ukladani osoby i celeho pripadu,
- auditni stopu po kazdem hledani,
- pripadovy dashboard (entity, vazby, prilohy, timeline, posledni zmena),
- timeline udalosti, evidence priloh a checklist ukolu,
- pravidlove doporuceni vysetrovaciho asistenta,
- exporty CSV, TXT, PDF a JSON,
- zaverecny report, ktery oddeluje odkazy k overeni od auditnich zaznamu a rucnich poznamek.

Vsechna data zustavaji lokalne v localStorage (bez SQL migrace, bez cloud DB).

## Architektura (high-level)

Projekt je nyni strukturovany takto:

```text
/index.html
/app.js
/style.css
/server.js
/cli.js

/providers
   google.js
   bing.js
   yandex.js
   ...

/core
   engine.js
   aggregator.js
   scorer.js
   /sources
      index.js   (loader pluginu z providers/)
```

Pozn.: canonical vrstva zdroju je `providers/` (bez alias adresare `sources/`).

## Foto backend

Backend poskytuje endpoint:

- POST /api/reverse-image
- POST /api/username-search
- POST /api/email-osint
- POST /api/domain-intel
- POST /api/metadata-extract

Endpoint ocekava multipart/form-data s polem image a vraci JSON s kandidaty a odkazy, napr.:

{
"candidates": ["jmeno nebo popis"],
"results": [
{ "source": "Google Reverse Image", "url": "https://..." }
]
}

Dalsi API vstupy:

- `/api/username-search` s JSON `{ "username": "novak123" }`
- `/api/email-osint` s JSON `{ "email": "kontakt@example.com" }`
- `/api/domain-intel` s JSON `{ "domain": "example.com" }`
- `/api/metadata-extract` s multipart souborem `image` (vraci hashe + EXIF/GPS)

Kdyz je pole pro endpoint prazdne, frontend se pokusi doplnit vychozi adresu http://localhost:8787/api/reverse-image.

## Rezim pripadu a audit

Aplikace obsahuje lehky rezim pripadu pro dohledatelnost setreni:

- Case ID, nazev pripadu, operator a duvod setreni,
- Case ID, nazev pripadu a operator,
- auditni zaznam po kazdem hledani (Hledat vsude, Foto z URL, Foto OSINT),
- u foto API se uklada i SHA-256 hash nahraneho souboru, pokud je dostupne Web Crypto API,
- v detailu pripadu je dostupny dashboard KPI + Timeline + Evidence + Tasks,
- pravidlovy asistent navrhuje dalsi kroky podle dat pripadu,
- export spisoveho balicku pro aktualni pripad (JSON),
- export auditni stopy pripadu (TXT),
- zaverecny report (PDF/TXT) se shrnutim zjisteni, rizikovym skore, auditnimi zaznamy, timeline, tasks, evidenci, spojitostmi a odkazy k overeni.

Doporuceni: pred vyhledavanim vzdy nastavit pripad pres tlacitko Ulozit pripad.

## Spusteni

1. Nainstalujte zavislosti:

   npm install

2. Spustte backend:

   npm start

3. Ve frontendu pouzijte endpoint:

   http://localhost:3000/api/reverse-image

4. V aplikaci:
   - vyberte fotku,
   - kliknete na tlacitko Foto OSINT hledani,
   - ve Vysledcich uvidite reverse-image odkazy i automaticky vygenerovane odkazy do vybranych zdroju.

## Portable start (USB)

Projekt lze spustit i v portable rezimu primo z projektove slozky:

1. Dvojklik na [start-portable.bat](start-portable.bat) nebo [start.bat](start.bat).
2. Script pouzije lokalni [node-v24.16.0-win-x64](node-v24.16.0-win-x64), pripravi `data/`, `data/uploads/`, `data/exports/` a spusti server.
3. Po startu probehne kontrola `http://localhost:PORT/health` a automaticky se otevre frontend na `http://localhost:PORT/`.
4. Runtime logy a docasna data zustavaji uvnitr `data/`.

Vychozi konfigurace portable rezimu je v [\.env](.env):

- `PORT=3000`
- `DATA_PATH=./data`
- `SAFE_MODE=true`
- `USE_PROXY=false`

## Dokumentace a navody

Aktualizovane textove materialy jsou ulozene ve slozce [Návod](Návod):

- [NAVOD_PRO_OBSLUHU.txt](Návod/NAVOD_PRO_OBSLUHU.txt)
- [TAHAK_A4_RYCHLY_START.txt](Návod/TAHAK_A4_RYCHLY_START.txt)
- [TECHNICKA_SPECIFIKACE_APLIKACE.txt](Návod/TECHNICKA_SPECIFIKACE_APLIKACE.txt)
- [BEZPECNOSTNI_STITEK.txt](Návod/BEZPECNOSTNI_STITEK.txt)

## CLI rezim

Pro rychly reverzni lookup mimo prohlizec muzete spustit:

```bash
npm run cli -- image.jpg
```

CLI vrati strucny JSON souhrn na stdout a vyuziva stejny backendovy endpoint jako webovy dashboard.

## Poznamky

- Je potreba Node.js 18+.
- Vysledky jsou kandidati a odkazy k overeni, ne potvrzene udaje.
- Pokud Google zmeni chovani reverse image vyhledavani, backend muze prestat vracet URL a bude potreba uprava.
- Kandidati (candidates) jsou heuristika z reverse-image vysledku, ne 100% identifikace osoby.

## Sitova odolnost pro OSINT

Backend pouziva v `utils/request.js`:

- user-agent randomizer (rotuje UA mezi requesty),
- rotating headers (rotace vice browser-like header profilu),
- cookies jar (perzistence cookies mezi requesty),
- retry logiku s timeouty,
- HTTP proxy support s moznosti rotace proxy poolu.

Pokrocily stealth rezim (pro GET requests na anti-bot stranky):

- `OSINT_USE_PUPPETEER_STEALTH=1`
- interni wrapper pouzije `puppeteer-extra` + stealth plugin pro vybrane requesty.

Poznamka: Puppeteer byl instalovan s `--ignore-scripts`. Pokud chcete stealth skutecne spoustet, je potreba dodelat Chromium binary:

- `./node-v24.16.0-win-x64/npx.cmd puppeteer browsers install chrome`

Pro rotaci proxy nastavte seznam do prostredi:

- `OSINT_PROXY_LIST=http://proxy1:8080;http://proxy2:8080;http://proxy3:8080`

Wrapper potom automaticky vybere proxy a pri dalsim pokusu ji rotuje.

## Plugin system zdroju

Novy zdroj pridate tak, ze do slozky `providers/` vlozite novy soubor se strukturou:

```javascript
module.exports = {
  name: 'google',
  run: async (input) => {
    return { source: 'Google', url: 'https://...' };
  },
  parse: (data) => [data]
};
```

Loader v `core/sources/index.js` soubory najde automaticky, takze novy zdroj nevyzaduje zadne dalsi rucni registrace.
