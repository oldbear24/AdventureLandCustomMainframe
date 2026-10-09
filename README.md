# Adventure Land Custom Mainframe

Vlastní webový panel a runtime pro nepřetržitý běh Adventure Land postav na Linux serveru s Dockerem. Node.js řídí headless Chromium, ve kterém běží skutečný herní klient a běžný JavaScript CODE. Tvůj počítač ani prohlížeč nemusí zůstat zapnutý.

[GitHub repozitář](https://github.com/oldbear24/AdventureLandCustomMainframe) · [Docker buildy](https://github.com/oldbear24/AdventureLandCustomMainframe/actions/workflows/docker.yml)

## Hotový Docker image a automatický build

Každý push na **`master`** spustí GitHub Actions: kontrolu JavaScriptu, backendové a browserové testy, Docker build pro **linux/amd64** a ověření aplikace i Chromium uvnitř kontejneru. Teprve po úspěchu se image publikuje do GitHub Container Registry:

```text
ghcr.io/oldbear24/adventurelandcustommainframe:latest
ghcr.io/oldbear24/adventurelandcustommainframe:sha-<plny-commit-sha>
```

Build lze spustit i ručně v Actions → **Test, build and publish Docker image** → **Run workflow** na větvi `master`. Pro samotný build nejsou potřeba herní přihlašovací údaje; testy používají lokální simulaci klientu. GHCR publikace používá automatický `GITHUB_TOKEN`, žádný vlastní token se neukládá do repozitáře.

Na serveru můžeš použít hotový image místo místního sestavování. Po vyplnění `.env` podle návodu níže:

```bash
docker compose -f compose.image.yaml pull
docker compose -f compose.image.yaml up -d
```

Při aktualizaci zopakuj oba příkazy. Pro konkrétní verzi nastav v `.env` `MAINFRAME_IMAGE=ghcr.io/oldbear24/adventurelandcustommainframe:sha-<plny-commit-sha>`. Pro příkazy jako `logs`, `restart` nebo `down` přidej také `-f compose.image.yaml`.

Viditelnost GHCR balíčku je samostatné nastavení GitHubu: nově publikovaný balíček může být privátní i u veřejného repozitáře. Pro anonymní `docker pull` změň viditelnost balíčku na **Public** v [nastavení balíčku](https://github.com/users/oldbear24/packages/container/adventurelandcustommainframe/settings). U privátního balíčku se na serveru přihlas do `ghcr.io` tokenem s `read:packages`; token zadávej přes `docker login ghcr.io -u oldbear24 --password-stdin`.

## Co umí

- Správa až 4 postav: region, server, přiřazený skript, start, stop, opětovné načtení CODE.
- Editor lokálních skriptů; uložením se běžící CODE nepřepisuje. Nasadíš ho přes **↻ CODE**.
- Stav postav, HP/MP, level, mapa, gold, stav CODE a živé herní/CODE logy.
- Kontrola vlastnictví a online stavu před připojením. Automatické opakování při výpadku s prodlevou 10 sekund až 5 minut.
- Volitelný autostart uložených postav po restartu. Tlačítko Stop autostart dané postavy vypne.
- Přihlášení do panelu, HttpOnly session cookie, omezení pokusů o přihlášení, kontrola Origin a validace vstupů.
- Atomické ukládání postav a skriptů do Docker volume; logy zůstávají v paměti (nejvýše 1 000 záznamů).

Tento projekt nepoužívá placené přiřazení herního Mainframu. Herní relace běží na tvém serveru. Stávající CODE může používat funkce hry jako v prohlížeči; další postavy spravuj přes panel. Pokud skript sám použije `start_character`, vzniknou podřízené herní rámce, které panel samostatně nepočítá. Limit hry stále platí. Projekt neposkytuje vlastní herní server ani další účty.

## Nasazení: Linux + Docker Compose

Potřebuješ Docker s příkazem `docker compose`, svůj herní účet a HTTPS adresu panelu nebo SSH tunel. Jako výchozí nastavení počítej s 2 CPU a 2 GB RAM; skutečnou spotřebu ovlivní CODE a počet postav. Chromium stahuje Docker při sestavení.

```bash
cp .env.example .env
```

Do `.env` nastav:

```dotenv
ADMIN_PASSWORD=sem_dej_sve_dlouhe_nahodne_heslo
AL_AUTH_COOKIE=sem_dej_hodnotu_herni_cookie
```

Cookie zjistíš po přihlášení na **https://adventure.land** v nástrojích pro vývojáře → Application / Storage → Cookies → `auth`. Zkopíruj pouze hodnotu cookie, nikoli `auth=`. Pokud hra používá jiné jméno cookie, nastav `AL_COOKIE_NAME`. Cookie je přihlašovací údaj účtu; nech ji v `.env` na svém serveru. **Token z „Connect an AI“ / MCP k tomuto přihlášení neslouží.** Při změně nebo vypršení cookie aktualizuj `.env` a vytvoř kontejner znovu.

```bash
chmod 600 .env
docker compose up -d --build
docker compose logs -f --tail=100
```

Panel je záměrně dostupný na serveru pouze přes `127.0.0.1:3000`. Pro první otevření použij z počítače:

```bash
ssh -L 3000:127.0.0.1:3000 uzivatel@tvuj-server
```

Pak otevři **http://localhost:3000** a přihlas se heslem `ADMIN_PASSWORD`. Pro SSH tunel ponech `COOKIE_SECURE=false` a `PUBLIC_ORIGIN` prázdné.

### HTTPS doména

Příklad pro Caddy na hostiteli je v `deploy/Caddyfile.example`. Doménu změň na svou, nastav DNS, nakonfiguruj Caddy a v `.env` zadej:

```dotenv
COOKIE_SECURE=true
PUBLIC_ORIGIN=https://al.tvoje-domena.cz
```

```bash
docker compose up -d --force-recreate
```

Pokud proxy běží v jiném kontejneru, její `127.0.0.1` není hostitel: připoj ji do stejné Docker sítě a proxyuj na `mainframe:3000`. Port 3000 nevyžaduje veřejné zpřístupnění. Panel je pro jednoho správce; CODE spouštěj pouze vlastní nebo důvěryhodný, protože má oprávnění tvého herního účtu.

## První postava

1. V CODE editoru vlož svůj funkční Adventure Land skript, pojmenuj ho a ulož.
2. Přidej postavu přesným jménem. Nastav region, aktuální jméno serveru z výběru ve hře (například `EU` + `I`) a skript.
3. Pokud chceš obnovu po restartu serveru, zapni autostart. Přidání postavu okamžitě nespouští.
4. Odpoj ji z původního prohlížeče / herního Mainframu a stiskni **Start**.
5. Sleduj skutečný stav připojení na kartě a logy. Při nesprávné cookie, chybě serveru nebo výpadku uvidíš důvod a runtime pokus zopakuje.
6. Úpravu CODE ulož a nasaď přes **↻ CODE**. Konfiguraci postavy měň po zastavení.

Bez přiřazeného skriptu se postava připojí a zůstane bez aktivního CODE. Projekt automaticky nevybírá strategii farmení.

## Provoz a záloha

```bash
docker compose ps
docker compose restart
docker compose down
```

`down` zachová data. `down -v` by je smazal. Nastavení a zdrojové kódy jsou ve volume `mainframe-data`, v souboru `/app/data/state.json`. Pro jednoduchou konzistentní zálohu ho zkopíruj:

```bash
docker compose cp mainframe:/app/data/state.json ./mainframe-backup.json
```

Na novém serveru vytvoř kontejner, zastav běžící aplikaci, obnov `state.json` do volume s vlastníkem UID 1000 a aplikaci znovu spusť. `.env` zálohuj zvlášť. Session cookie panelu zanikne při restartu; přihlásíš se znovu. Docker automaticky obnovuje ukončený kontejner, herní spojení obnovuje runtime. Samotný stav Docker healthchecku `unhealthy` automatický restart nezpůsobuje.

## Lokální vývoj (Node.js 22+)

```bash
npm ci
npm run browser:install
```

Zkopíruj `.env.example` na `.env`, vyplň heslo a spusť:

```bash
npm start
npm test
npm run check
```

Na Linuxu mimo Docker může být potřeba `npx playwright install --with-deps chromium`. Panel a testy backendu fungují i bez herní cookie; skutečné připojení postav ji vyžaduje.

## Ověření a hranice

Testy ověřují přístup k API, ochranu proti cizímu Origin, ukládání a validaci, lifecycle runtime a obnovu po výpadku s náhradním herním klientem. Samostatný `npm run test:browser` ověřuje panel i browser bridge v reálném Chromium s lokální napodobeninou herního klientu, bez připojení postav do hry. Bez tvé cookie nebylo ověřeno živé připojení herního účtu. Docker nasazení vyžaduje ověření sestavení na serveru s Dockerem.

Runtime načítá aktuální klient ze hry, takže změna jejích přihlašovacích nebo CODE funkcí může vyžadovat úpravu adaptéru `src/runtime.js`. Kontrola online stavu omezuje duplicitní spuštění, ale souběžné přihlášení z jiného klientu mezi kontrolou a připojením není možné z tohoto panelu atomicky zablokovat. Jedno Chromium sdílí proces browseru; postavy mají oddělené contexty, nikoli samostatné kontejnery. Logy se nedrží po restartu a nejde o systém pro provoz více nezávislých zákaznických účtů.

## Zdrojové reference

- [Oficiální zdroje herního klientu](https://github.com/kaansoral/adventureland_mongodb): `main.js`, `js/functions.js`, `js/game.js`, `htmls/runner.html`.
- [Adventure Land](https://adventure.land/) a [CODE dokumentace](https://adventure.land/docs).
- [Playwright: Docker a instalace browserů](https://playwright.dev/docs/docker).
