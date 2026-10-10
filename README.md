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
- Přihlášení do panelu jménem a heslem; HttpOnly session cookie, omezení pokusů o přihlášení, kontrola Origin a validace vstupů.
- Přihlášení k Adventure Land e-mailem a heslem přímo z panelu; pro Steam účet také vložení herní cookie. Herní relace se ukládá šifrovaně, herní heslo se neukládá.
- Přímé HTTPS s vlastním PEM certifikátem a klíčem, nebo provoz za HTTPS proxy.
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
ADMIN_USERNAME=admin
```

`ADMIN_USERNAME` je přihlašovací jméno do panelu (výchozí `admin`). `ADMIN_PASSWORD` musí mít alespoň 16 znaků. Herní účet připojíš po přihlášení do panelu přes **Připojit účet** → e-mail a heslo Adventure Land. Přihlašovací požadavek jde pouze na `https://adventure.land/api/signup_or_login`, s `only_login=true`: nevytváří nový účet. Heslo se použije pro tento požadavek a neukládá se do souborů ani logů.

Pokud používáš Steam a nemáš samostatné herní heslo, otevři v dialogu **Steam účet nebo přihlášení pomocí cookie**. Cookie zjistíš po přihlášení na **https://adventure.land** v nástrojích pro vývojáře → Application / Storage → Cookies → `auth`. Vlož pouze její hodnotu, nikoli `auth=`. Pokud hra používá jiné jméno cookie, nastav `AL_COOKIE_NAME`. **Token z „Connect an AI“ / MCP neslouží k přihlášení herního klientu.**

Alternativně lze cookie nastavit přes `AL_AUTH_COOKIE` v `.env`. Uložená relace z panelu má přednost před touto proměnnou, včetně odhlášení. Pro výměnu použij dialog v panelu. Přihlašovací údaje přijímá herní dialog přes HTTPS nebo lokální spojení, například SSH tunel.

```bash
chmod 600 .env
docker compose up -d --build
docker compose logs -f --tail=100
```

Panel je záměrně dostupný na serveru pouze přes `127.0.0.1:3000`. Pro první otevření použij z počítače:

```bash
ssh -L 3000:127.0.0.1:3000 uzivatel@tvuj-server
```

Pak otevři **http://localhost:3000** a přihlas se jménem `ADMIN_USERNAME` a heslem `ADMIN_PASSWORD`. Pro SSH tunel ponech `TLS_ENABLED=false`, `COOKIE_SECURE=false` a `PUBLIC_ORIGIN` prázdné.

### Přímé HTTPS s vlastním SSL certifikátem

Aplikace může obsluhovat HTTPS sama, bez reverzní proxy. Potřebuješ PEM certifikát pro svou doménu (včetně řetězce) a odpovídající privátní klíč. Vlož je do adresáře `certs` pod názvy `fullchain.pem` a `privkey.pem`. Certifikáty a privátní klíče jsou vyloučené z Gitu i Docker build contextu; do kontejneru se připojují pouze pro čtení.

Kontejner běží jako UID 1000. Po zkopírování certifikátů zajisti, aby je tento uživatel mohl číst:

```bash
sudo chown -R 1000:1000 ./certs
sudo chmod 700 ./certs
sudo chmod 644 ./certs/fullchain.pem
sudo chmod 600 ./certs/privkey.pem
```

V `.env` nastav svou veřejnou adresu a případně heslo zašifrovaného klíče:

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=sem_dej_sve_dlouhe_nahodne_heslo
PUBLIC_ORIGIN=https://al.tvoje-domena.cz
TLS_CERTS_DIR=./certs
HTTPS_PORT=443
TLS_KEY_PASSPHRASE=
```

Potom spusť **samostatný** Compose soubor pro HTTPS:

```bash
docker compose -f compose.https.yaml pull
docker compose -f compose.https.yaml up -d
docker compose -f compose.https.yaml logs -f --tail=100
```

Otevři `https://al.tvoje-domena.cz`. Tento Compose soubor zapíná TLS a Secure cookies automaticky a publikuje pouze HTTPS port. `TLS_CERTS_DIR` může být i absolutní cesta k připravenému adresáři s certifikáty. Při změně portu například na `8443` nastav také `PUBLIC_ORIGIN=https://al.tvoje-domena.cz:8443`. Po obnovení certifikátu restartuj kontejner; certifikáty se načítají při startu. Certifikát musí odpovídat doméně a být platný, protože healthcheck ověřuje TLS včetně jména a důvěry certifikátu.

Pro spuštění přes Node.js nebo vlastní Docker konfiguraci nastav:

```dotenv
TLS_ENABLED=true
TLS_CERT_FILE=/cesta/fullchain.pem
TLS_KEY_FILE=/cesta/privkey.pem
PUBLIC_ORIGIN=https://al.tvoje-domena.cz
```

Použije se stávající `PORT` (výchozí 3000), tentokrát pro HTTPS. Při nečitelném nebo neplatném certifikátu aplikace nenastartuje a nepřejde automaticky na HTTP. Vlastní privátní CA musí být součástí řetězce v `fullchain.pem`, aby ji interní healthcheck mohl ověřit. Pro veřejnou doménu použij certifikát od důvěryhodné certifikační autority; lokální testy používají vlastní krátkodobý certifikát.

### HTTPS přes reverzní proxy

Příklad pro Caddy na hostiteli je v `deploy/Caddyfile.example`. Doménu změň na svou, nastav DNS, nakonfiguruj Caddy a v `.env` zadej:

```dotenv
COOKIE_SECURE=true
PUBLIC_ORIGIN=https://al.tvoje-domena.cz
TLS_ENABLED=false
```

```bash
docker compose up -d --force-recreate
```

Pokud proxy běží v jiném kontejneru, její `127.0.0.1` není hostitel: připoj ji do stejné Docker sítě a proxyuj na `mainframe:3000`. Port 3000 nevyžaduje veřejné zpřístupnění. Panel je pro jednoho správce; CODE spouštěj pouze vlastní nebo důvěryhodný, protože má oprávnění tvého herního účtu.

## První postava

1. Připoj herní účet přes **Připojit účet**. Pak v CODE editoru vlož svůj funkční Adventure Land skript, pojmenuj ho a ulož.
2. Přidej postavu přesným jménem. Nastav region, aktuální jméno serveru z výběru ve hře (například `EU` + `I`) a skript.
3. Pokud chceš obnovu po restartu serveru, zapni autostart. Přidání postavu okamžitě nespouští.
4. Odpoj ji z původního prohlížeče / herního Mainframu a stiskni **Start**.
5. Sleduj skutečný stav připojení na kartě a logy. Při nesprávné cookie, chybě serveru nebo výpadku uvidíš důvod a runtime pokus zopakuje.
6. Úpravu CODE ulož a nasaď přes **↻ CODE**. Konfiguraci postavy měň po zastavení.

Bez přiřazeného skriptu se postava připojí a zůstane bez aktivního CODE. Projekt automaticky nevybírá strategii farmení.

**Odhlásit se** odhlásí pouze panel; postavy dál běží. **Odpojit účet a zastavit postavy** v dialogu herního účtu zastaví místní postavy, vypne jejich autostart a odstraní místní herní relaci. Nemění heslo ani neodhlašuje jiné herní klienty. Před změnou herního účtu zastav aktivní postavy.

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

Na novém serveru vytvoř kontejner, zastav běžící aplikaci, obnov `state.json` do volume s vlastníkem UID 1000 a aplikaci znovu spusť. Herní relace se ukládá pomocí AES-256-GCM do `account.enc.json`; klíč je v `account.key` s právy 600. Pro obnovu přihlášení zálohuj a obnov **oba tyto soubory společně**. Šifrování chrání samostatný soubor relace; přístup k celému volume včetně klíče umožňuje relaci dešifrovat. `.env` a certifikáty zálohuj zvlášť. Session cookie panelu zanikne při restartu; přihlásíš se znovu. Docker automaticky obnovuje ukončený kontejner, herní spojení obnovuje runtime. Samotný stav Docker healthchecku `unhealthy` automatický restart nezpůsobuje.

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

Na Linuxu mimo Docker může být potřeba `npx playwright install --with-deps chromium`. Testy HTTPS potřebují příkaz `openssl` (na GitHub runneru je dostupný). Panel a testy fungují bez skutečných herních přihlašovacích údajů; skutečné připojení postav vyžaduje připojený herní účet.

## Ověření a hranice

Testy ověřují přihlášení do panelu i herního účtu, šifrování relace, přístup k API, skutečné HTTPS s testovacím certifikátem, Secure cookie, kontrolu jména certifikátu, ukládání, lifecycle runtime a obnovu po výpadku. Samostatný `npm run test:browser` ověřuje panel i browser bridge v reálném Chromium s lokální napodobeninou herního klientu. GitHub Actions také ověřuje HTTP i HTTPS přímo v sestaveném Docker image. Bez tvých herních přihlašovacích údajů nebylo ověřeno živé přihlášení k Adventure Land.

Runtime načítá aktuální klient ze hry, takže změna jejích přihlašovacích nebo CODE funkcí může vyžadovat úpravu adaptéru `src/runtime.js`. Kontrola online stavu omezuje duplicitní spuštění, ale souběžné přihlášení z jiného klientu mezi kontrolou a připojením není možné z tohoto panelu atomicky zablokovat. Jedno Chromium sdílí proces browseru; postavy mají oddělené contexty, nikoli samostatné kontejnery. Logy se nedrží po restartu a nejde o systém pro provoz více nezávislých zákaznických účtů.

## Zdrojové reference

- [Oficiální zdroje herního klientu](https://github.com/kaansoral/adventureland_mongodb): `main.js`, `js/functions.js`, `js/game.js`, `htmls/runner.html`.
- [Adventure Land](https://adventure.land/) a [CODE dokumentace](https://adventure.land/docs).
- [Playwright: Docker a instalace browserů](https://playwright.dev/docs/docker).
