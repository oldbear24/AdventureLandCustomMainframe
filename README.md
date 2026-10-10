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
- Společné uložené CODE sloty s prohlížečem: automatické načítání změn přibližně každých 30 sekund (včetně modulů načtených přes `require_code`/`load_code`) a ukládání z panelu do stejného herního slotu. Místní skripty slouží jako návrhy.
- Stav postav, HP/MP, level, mapa, gold, stav CODE a živé herní/CODE logy (nové záznamy přicházejí okamžitě přes WebSocket `/api/live`; při výpadku spojení se načítají s obnovou každých 5 sekund).
- Kontrola vlastnictví a online stavu před připojením. Automatické opakování při výpadku s prodlevou 10 sekund až 5 minut.
- Volitelný autostart uložených postav po restartu. Tlačítko Stop autostart dané postavy vypne.
- Přihlášení do panelu jménem a heslem; HttpOnly session cookie, omezení pokusů o přihlášení, kontrola Origin a validace vstupů.
- Přihlášení k Adventure Land e-mailem a heslem přímo z panelu; pro Steam účet také vložení herní cookie. Herní relace se ukládá šifrovaně, herní heslo se neukládá.
- Pouze HTTPS: při prvním startu si aplikace sama vygeneruje self-signed certifikát, nebo použije tvůj vlastní PEM certifikát a klíč. HTTP neobsluhuje vůbec.
- API token „Connect an AI“: výpis postav účtu, import postav a synchronizace CODE slotů. Pro spouštění přiřazeného CODE je token potřebný.
- **Samostatné stránky panelu**: Postavy (`/`), Mapa (`/map`), Inventáře (`/inventory`), CODE editor (`/editor`) a Logy (`/logs`). Každá stránka načítá jen svůj kód a jen data, která potřebuje (WebSocket otevírá jen mapa a logy), takže jedna stránka nezpomaluje ostatní. Adresa nese i výběr, např. `/map?follow=<id>`, `/inventory?name=<postava>`, `/editor?script=<id>` nebo `/logs?character=<id>`, lze ji tedy uložit do záložek nebo otevřít v další kartě. Společné jádro (přihlášení, navigace, dialog herního účtu, API a WebSocket) je v `public/js/core.js`, šablona stránek ve `views/`.
- **Živá mapa**: skutečné zdi, zóny monster, NPC a průchody každé mapy; pozice běžících postav i monster a hráčů v okolí se posílají v reálném čase přes WebSocket (`/api/live`, přibližně 4× za sekundu; při výpadku spojení panel spadne zpět na obnovu každých 5 sekund). Mapa se kreslí na canvas: statická vrstva (zdi, zóny, průchody, NPC) se vykreslí jednou pro danou polohu kamery, postavy a monstra se mezi aktualizacemi plynule posouvají a nic se nepřekresluje, když se nic nemění. Postavu lze sledovat kamerou, mapu přibližovat kolečkem (nebo klávesami +/−) a posouvat tažením či šipkami, kliknutím na průchod na mapě nebo v seznamu Průchody přejdeš na sousední mapu. S API tokenem vidíš i poslední uloženou pozici ostatních postav účtu.
- **Inventáře a banka**: vybavení, inventář a zlato každé postavy s herními ikonami předmětů a hledáním podle názvu. Běžící postava se čte živě, ostatní postavy a banka z uloženého stavu účtu přes API token (může být o něco starší). Pokud stojí běžící postava v bance, banka se čte živě. Najetím myší na předmět uvidíš jeho popisek a staty, kliknutím otevřeš detail: název včetně prefixu (např. Lucky) a úrovně, popis ze hry, typ, tier, grade (Vysoký/Vzácný/Legendární/Exaltovaný), spočtené staty, schopnost a její šanci, obnovu HP/MP, sadu a povolené třídy. Staty se počítají stejně jako ve hře (`calculate_item_properties`: základ, upgrade/compound úroveň, prefix, stat scroll), jen bez bonusů vázaných na třídu nebo mapu. Geometrie map, názvy a ikony předmětů se stahují z veřejného `https://adventure.land/data.js` (ukládají se do paměti na 6 hodin); obrázky ikon načítá server z Adventure Land a panelu je předává sám, prohlížeč se na herní server nepřipojuje.
- **Uložené hodnoty CODE**: tlačítko **Úložiště** na kartě běžící postavy ukáže všechno, co její CODE uložil funkcí `set(name, value)` (čte se přes `get(name)`): klíč, velikost a hodnotu jako formátovaný JSON, s hledáním a ručním obnovením. Hodnotu lze upravit (jako JSON, uloží se stejně jako `set()`), smazat jednotlivě nebo tlačítkem **Smazat vše** odstranit všechny hodnoty postavy; smazaná hodnota se pro `get()` chová jako `null`. Běžící CODE může upravenou hodnotu svým dalším `set()` přepsat. Hodnoty se čtou živě z `localStorage` herní stránky postavy (klíče `cstore_*`); ostatní data herního klientu se nezobrazují. Každá postava běží v samostatném profilu prohlížeče, takže hodnoty nejsou sdílené mezi postavami a nové spuštění nebo reconnect začíná s prázdným úložištěm.
- **Upozornění na problémy**: karta postavy se zvýrazní a panel ukáže toast, když postava umře, dlouho nic nedělá, opakovaně padá do reconnectu, dojdou jí lektvary nebo se pozastaví CODE. Počet postav s problémem je i v titulku záložky. Volitelně se upozornění posílají na Discord nebo Telegram.
- **XP a statistiky**: ukazatel XP do dalšího levelu, XP/h a gold/h za poslední hodinu, odhad času do dalšího levelu a malý graf. Historie se drží v paměti (vzorek jednou za minutu) a restartem serveru se vynuluje.
- **Efekty, zásoby a cooldowny**: aktivní buffy a debuffy, počet lektvarů HP/MP, volná místa v inventáři a odpočet cooldownů použitých skillů (rozbalovací část karty).
- **Party přehled**: kdo je v partě, na jakém serveru, na jaké mapě a jak daleko od leadera; vzdálenosti mezi postavami v panelu a varování, když běží na různých serverech.
- **Detekce zamrzlého CODE**: postava bez pohybu, útoku, skillu, XP i změny zlata po nastavenou dobu je označená jako nečinná; volitelně se jí CODE automaticky znovu načte (↻ CODE).
- **Dávkové akce**: Spustit vše, Zastavit vše, ↻ CODE vše (znovu načte CODE všech připojených postav), ⟳ Relog vše (běžící postavy se odhlásí a znovu přihlásí, autostart zůstává) a přesun vybraných postav na jiný server (běžící se zastaví, přesunou a znovu spustí).
- Ruční posílání zlata a předmětů z běžící postavy s náhledem, kontrolou inventáře a potvrzením výsledku od hry.
- Atomické ukládání postav a skriptů do Docker volume; logy zůstávají v paměti (nejvýše 200 záznamů, panel je posuvný).

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

Alternativně lze cookie nastavit přes `AL_AUTH_COOKIE` v `.env`. Uložená relace z panelu má přednost před touto proměnnou, včetně odhlášení. Pro výměnu použij dialog v panelu.

```bash
chmod 600 .env
docker compose up -d --build
docker compose logs -f --tail=100
```

Panel je záměrně dostupný na serveru pouze přes `127.0.0.1:3000`. Pro první otevření použij z počítače:

```bash
ssh -L 3000:127.0.0.1:3000 uzivatel@tvuj-server
```

Pak otevři **https://localhost:3000** a přihlas se jménem `ADMIN_USERNAME` a heslem `ADMIN_PASSWORD`. Prohlížeč nejdřív upozorní na nedůvěryhodný certifikát – viz další oddíl.

### HTTPS a automaticky generovaný certifikát

Panel běží **vždy a jen přes HTTPS** na portu `PORT` (výchozí 3000); HTTP požadavky nepřijímá a session cookie je vždy `Secure`. Pokud nenastavíš vlastní certifikát, aplikace při startu vytvoří self-signed certifikát (ECDSA P-256, platnost 1 rok) a uloží ho do datového adresáře:

```text
/app/data/tls/cert.pem   (v Dockeru, volume mainframe-data)
/app/data/tls/key.pem    (práva 600)
```

Certifikát platí pro `localhost`, `127.0.0.1`, `::1`, hostitele z `PUBLIC_ORIGIN` a pro názvy z `TLS_HOSTNAMES` (čárkami oddělené DNS jména nebo IP adresy, např. `TLS_HOSTNAMES=192.168.1.20,nas.lan`). Při dalších startech se znovu použije. Nový se vytvoří, pokud chybí, nepatří k uloženému klíči, nepokrývá všechny požadované názvy nebo mu zbývá méně než 30 dní platnosti; běžící server to kontroluje každých 12 hodin a nový certifikát načte bez restartu.

Při vytvoření certifikátu vypíše log jeho otisk SHA-256 (`docker compose logs mainframe | grep SHA-256`). Porovnej ho s otiskem v prohlížeči a výjimku potvrď, nebo certifikát importuj jako důvěryhodný:

```bash
docker compose cp mainframe:/app/data/tls/cert.pem ./mainframe-cert.pem
```

Po změně `PUBLIC_ORIGIN` nebo `TLS_HOSTNAMES` se vytvoří nový certifikát a dříve importovaný přestane platit. Pro veřejnou doménu raději použij certifikát od důvěryhodné autority (následující oddíl).

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

Otevři `https://al.tvoje-domena.cz`. Tento Compose soubor publikuje HTTPS port veřejně a místo generovaného certifikátu používá připojené soubory. `TLS_CERTS_DIR` může být i absolutní cesta k připravenému adresáři s certifikáty. Při změně portu například na `8443` nastav také `PUBLIC_ORIGIN=https://al.tvoje-domena.cz:8443`. Obnovený certifikát (např. od Let's Encrypt) aplikace sama načte nejpozději do 12 hodin; pro okamžité použití restartuj kontejner. Certifikát musí odpovídat doméně a být platný, protože healthcheck ověřuje TLS včetně jména a důvěry certifikátu.

Pro spuštění přes Node.js nebo vlastní Docker konfiguraci nastav:

```dotenv
TLS_CERT_FILE=/cesta/fullchain.pem
TLS_KEY_FILE=/cesta/privkey.pem
PUBLIC_ORIGIN=https://al.tvoje-domena.cz
```

Použije se stávající `PORT` (výchozí 3000), tentokrát pro HTTPS. Při nečitelném nebo neplatném certifikátu aplikace nenastartuje; na generovaný certifikát ani na HTTP automaticky nepřejde. Vlastní privátní CA musí být součástí řetězce v `fullchain.pem`, aby ji interní healthcheck mohl ověřit. Pro veřejnou doménu použij certifikát od důvěryhodné certifikační autority; lokální testy používají vlastní krátkodobý certifikát.

### HTTPS přes reverzní proxy

Příklad pro Caddy na hostiteli je v `deploy/Caddyfile.example`. Proxy se k aplikaci připojuje také přes HTTPS (k generovanému certifikátu). Doménu změň na svou, nastav DNS, nakonfiguruj Caddy a v `.env` zadej:

```dotenv
PUBLIC_ORIGIN=https://al.tvoje-domena.cz
```

```bash
docker compose up -d --force-recreate
```

Živá mapa a logy používají WebSocket na `/api/live`. Caddy ho přeposílá automaticky; u jiné proxy (např. nginx) povol upgrade spojení (`proxy_http_version 1.1`, hlavičky `Upgrade` a `Connection: upgrade`) a zachovej hlavičku `Host`. Bez toho mapa i logy fungují dál, jen s obnovou každých 5 sekund.

Pokud proxy běží v jiném kontejneru, její `127.0.0.1` není hostitel: připoj ji do stejné Docker sítě, proxyuj na `https://mainframe:3000` a přidej `mainframe` do `TLS_HOSTNAMES`. Port 3000 nevyžaduje veřejné zpřístupnění. Panel je pro jednoho správce; CODE spouštěj pouze vlastní nebo důvěryhodný, protože má oprávnění tvého herního účtu.

## První postava

1. V prohlížeči Adventure Land ulož svůj CODE do herního slotu. V panelu připoj herní účet přes **Připojit účet** a API token **Connect an AI / MCP**.
2. V CODE editoru klikni na **Načíst herní sloty**, vyber stejný slot a zvol **Načíst a propojit slot**.
3. Přidej postavu přesným jménem. Nastav region, aktuální jméno serveru z výběru ve hře (například `EU` + `I`) a skript.
4. Pokud chceš obnovu po restartu serveru, zapni autostart. Přidání postavu okamžitě nespouští.
5. Odpoj ji z původního prohlížeče / herního Mainframu a stiskni **Start**.
6. Sleduj skutečný stav připojení na kartě a logy. Při nesprávné cookie, chybě serveru nebo výpadku uvidíš důvod a runtime pokus zopakuje.
7. Uložená změna slotu z prohlížeče se načte automaticky. Uložení propojeného skriptu v panelu zapíše herní slot a rovnou aktualizuje místní běh. **↻ CODE** vynutí nové načtení. Konfiguraci postavy měň po zastavení.

Bez přiřazeného skriptu se postava připojí a zůstane bez aktivního CODE. Projekt automaticky nevybírá strategii farmení.

**Odhlásit se** odhlásí pouze panel; postavy dál běží. **Odpojit účet a zastavit postavy** v dialogu herního účtu zastaví místní postavy, vypne jejich autostart a odstraní místní herní relaci. Nemění heslo ani neodhlašuje jiné herní klienty. Před změnou herního účtu zastav aktivní postavy.

## Společný CODE s prohlížečem

Zdrojem CODE je uložený slot tvého herního účtu. Panel uchovává jeho místní kopii, ale při startu, obnově spojení a **↻ CODE** čte aktuální obsah ze hry. Běžící postavy kontrolují své sloty za normálního spojení přibližně každých 30 sekund. Změna zdrojového kódu restartuje CODE všech místních postav přiřazených ke stejnému slotu; nezměněný zdroj se zbytečně nerestartuje. Pokud CODE načítá další sloty přes `require_code("99")` nebo `load_code(...)`, panel si zapamatuje jejich verze a při změně kteréhokoli z nich CODE postavy znovu načte, takže i hlavní slot, který jen volá `require_code`, vždy běží s poslední verzí modulů. Moduly se stahují přímo ze hry při každém spuštění CODE.

**Načíst a propojit slot** převezme herní obsah do editoru bez zápisu do hry. **Uložit herní slot** naopak zapíše změny do stejného slotu a hned je předá místním běžícím postavám. Editor kontroluje verzi před uložením: pokud byl slot mezitím změněn, žádá nové načtení a sloučení změn. Herní API neposkytuje atomickou podmínku verze pro zápis, proto se vyhni současnému ukládání ze dvou editorů.

V prohlížeči používej a spouštěj tentýž slot. Rozepsané, neuložené změny v prohlížeči nejsou přes API dostupné. Po uložení z panelu si v prohlížeči slot znovu načti a spusť; panel automaticky nepřepisuje CODE běžící v jiném klientu. Jednu postavu připojuj vždy jen v jednom klientu.

Při výpadku API nebo odstranění slotu runtime při další kontrole pozastaví CODE a zobrazí chybu. Pokud runner nejde zastavit, uzavře herní spojení. Po obnově API se načte aktuální herní obsah a běh pokračuje. Starší místní kopie se při výpadku nespouští.

Původní místní skripty zůstávají jako návrhy; před dalším spuštěním je propoj s herním slotem. Zastav postavu, vyber její stávající skript v editoru a načti do něj odpovídající herní slot. Přiřazení postavy se zachová, obsah návrhu se nahradí obsahem hry. **Odpojit slot z panelu** odstraní jen místní záznam; uložený CODE ve hře zůstává. Přiřazený skript nejdřív odeber z konfigurace postav.

## API token a seznam postav

V Adventure Land otevři Mainframe → **Connect an AI** → vytvoř nebo zobraz token. V našem panelu otevři **Herní účet** → **API token — Connect an AI / MCP** a vlož ho tam. Token neposílej do chatu ani do veřejného repozitáře. Při připojení ho server ověří přes oficiální JSON API a načte seznam postav. Tlačítko **Načíst seznam** obnovuje seznam ručně; nepoužívá rychlé opakované dotazování API.

U postavy zvol **Přidat do panelu**, nastav region, server a svůj skript. Načtení seznamu samo žádnou postavu nespouští. Token a herní přihlášení jsou nezávislé: token slouží pro výpis a společné CODE sloty, herní relace pro vlastní běh postav. Používej obojí ze stejného herního účtu. Vlastnictví se před spuštěním ověřuje také vůči herní relaci, takže token jiného účtu nedovolí spustit jeho postavu přes tuto relaci.

API token se ukládá šifrovaně do `api-token.enc.json` s klíčem `api-token.key` (práva 600). V API odpovědích, frontendovém stavu ani logu není jeho hodnota; panel ho po odeslání smaže z formuláře. Pro zálohu obnovuj oba soubory společně. **Odpojit API token** odstraní místní token a při další kontrole pozastaví propojený CODE; postavy mohou zůstat připojené. Token ve hře neodvolává. Odvolání proveď v Adventure Land. Používají se pouze `mainframe_list_characters`, `list_codes`, `get_code` a `save_code` na `https://adventure.land/mcp_api/`; integrace nevolá placené spuštění oficiálního Mainframu.

## Upozornění a hlídání postav

V **Nastavení** postavy nastavíš:

- **Upozornit na nečinnost po (min)** – výchozí 10. Nečinnost je stav bez pohybu, útoku, použitého skillu, XP a změny zlata. `0` kontrolu vypne (hodí se pro merchanta, který stojí ve městě).
- **Při nečinnosti automaticky znovu načíst CODE** – po uplynutí limitu se CODE načte znovu ze slotu, nejvýš jednou za každý další interval nečinnosti. Počet automatických restartů je vidět na kartě.
- **Upozornit pod počet lektvarů** – výchozí 10; hlídá HP i MP lektvary (`hpot*`, `mpot*`) v inventáři. `0` kontrolu vypne.

Smrt, opakovaný reconnect (dva neúspěšné pokusy za sebou) a pozastavený CODE se hlásí vždy. Každé nové upozornění se zapíše do logu, v panelu ukáže toast a zvýrazní kartu.

Pro posílání mimo panel doplň do `.env` Discord webhook nebo Telegram bota a restartuj kontejner:

```dotenv
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/…
TELEGRAM_BOT_TOKEN=123456789:AA…
TELEGRAM_CHAT_ID=123456789
```

Funkčnost ověříš v **Herní účet** → **Upozornění — Discord / Telegram** → **Poslat testovací upozornění**. Stejný typ upozornění se pro jednu postavu odešle nejvýš jednou za 15 minut a celkem nejvýš 30 zpráv za hodinu. Adresa webhooku ani token se nezobrazují v panelu ani v logu.

## Posílání zlata a předmětů

1. Spusť postavu s běžícím CODE. Na kartě zvol **Poslat**.
2. Vyplň přesné jméno příjemce. Musí být poblíž na stejné mapě a herním serveru. Panel postavy kvůli převodu automaticky nepřesouvá.
3. Zvol zlato a částku, nebo aktuální položku inventáře a počet. Zamčené, blokované a omezené předměty se nenabízejí.
4. Zvol **Připravit převod**. Zkontroluj odesílatele, příjemce, částku nebo předmět a počet, pak zvol **Potvrdit a odeslat**. Náhled platí 60 sekund a patří aktuálnímu přihlášení do panelu.

Příprava nic neodesílá. Před odesláním se znovu kontroluje herní spojení, zlato a přesná položka v inventáři; změna položky převod zastaví. Převod používá veřejné CODE funkce `send_gold` a `send_item` v místním herním klientu. Samotný API token pro převod nestačí. Výsledné množství zlata může hra snížit podle svých pravidel; panel zobrazuje částku potvrzenou serverem.

Opakované potvrzení stejného náhledu provede nejvýše jeden pokus během života procesu; záznam výsledku se drží nejméně deset minut. Po restartu staré náhledy přestanou platit. Při výpadku nebo chybějícím potvrzení panel označí výsledek jako **nepotvrzený** a převod automaticky neopakuje. Před novým převodem zkontroluj herní inventář a logy. Nepoužívej současně vlastní převodní smyčku bota a ruční převody: herní odpovědi pro tyto funkce sdílejí jednu frontu a herní server neumožňuje atomické porovnání položky s náhledem. Změny stavu ve hře se řídí jejími pravidly.

Podklady integrace: [oficiální JSON API a MCP](https://github.com/kaansoral/adventureland_mongodb/blob/master/mcp_api.js) a [veřejné CODE funkce](https://github.com/kaansoral/adventureland_mongodb/blob/master/js/runner_functions.js).

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

Na novém serveru vytvoř kontejner, zastav běžící aplikaci, obnov `state.json` do volume s vlastníkem UID 1000 a aplikaci znovu spusť. Herní relace se ukládá pomocí AES-256-GCM do `account.enc.json`; klíč je v `account.key` s právy 600. Pro obnovu přihlášení zálohuj a obnov **oba tyto soubory společně**. Šifrování chrání samostatný soubor relace; přístup k celému volume včetně klíče umožňuje relaci dešifrovat. Generovaný TLS certifikát je ve stejném volume v `tls/`; vlastní `.env` a certifikáty zálohuj zvlášť. Session cookie panelu zanikne při restartu; přihlásíš se znovu. Docker automaticky obnovuje ukončený kontejner, herní spojení obnovuje runtime. Samotný stav Docker healthchecku `unhealthy` automatický restart nezpůsobuje.

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

Testy ověřují přihlášení do panelu i herního účtu, šifrování relace a API tokenu, seznam a import postav, import a ukládání společných CODE slotů, synchronizaci více runnerů, odmítnutí staré verze editoru, pozastavení CODE při výpadku API i obnovu z aktuálního slotu, náhledy převodů, ochranu proti opakovanému odeslání, změnu inventáře, přístup k API, generování, opakované použití a obnovu self-signed certifikátu, skutečné HTTPS s generovaným i vlastním certifikátem, odmítnutí HTTP, Secure cookie, kontrolu jména certifikátu, ukládání, lifecycle runtime a obnovu po výpadku. Samostatný `npm run test:browser` ověřuje panel i browser bridge v reálném Chromium s lokální napodobeninou herního klientu včetně synchronizace CODE a převodu zlata a předmětů. GitHub Actions také ověřuje HTTPS s generovaným i vlastním certifikátem přímo v sestaveném Docker image. Bez tvých herních přihlašovacích údajů nebylo ověřeno živé přihlášení, API token ani skutečný herní převod.

Runtime načítá aktuální klient ze hry, takže změna jejích přihlašovacích nebo CODE funkcí může vyžadovat úpravu adaptéru `src/runtime.js`. Kontrola online stavu omezuje duplicitní spuštění, ale souběžné přihlášení z jiného klientu mezi kontrolou a připojením není možné z tohoto panelu atomicky zablokovat. Jedno Chromium sdílí proces browseru; postavy mají oddělené contexty, nikoli samostatné kontejnery. Logy se nedrží po restartu a nejde o systém pro provoz více nezávislých zákaznických účtů.

## Zdrojové reference

- [Oficiální zdroje herního klientu](https://github.com/kaansoral/adventureland_mongodb): `main.js`, `js/functions.js`, `js/game.js`, `htmls/runner.html`.
- [Adventure Land](https://adventure.land/) a [CODE dokumentace](https://adventure.land/docs).
- [Playwright: Docker a instalace browserů](https://playwright.dev/docs/docker).
