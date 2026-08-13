# Community Workspace

Gedecentraliseerde, local-first community workspace: permanent split-screen
met links een Nostr-chatkanaal en rechts een "bureaublad" vol collaboratieve
BlockNote/Yjs-documenten en P2P-videobelgesprekken.

## Snel starten

```bash
npm install
npm run dev
```

Bezoek `http://localhost:5173/` — je wordt automatisch doorgestuurd naar een
nieuw, willekeurig gegenereerd kanaal (`/#<kanaal-id>`). Deel die URL met
anderen om samen te chatten en te werken. Er is geen backend, database of
signaling-server nodig — alles (chat, presence, documenten-/video-
oproepenlijst, kanaal- en gebruikersnaam, én de WebRTC-verbindingsopzet voor
de editor) loopt via publieke Nostr-relays, en elk document wordt daarnaast
lokaal in de browser bewaard (IndexedDB).

## Hosten op GitHub Pages

Deze app is 100% client-side (geen backend) en dus rechtstreeks te hosten
als statische site. `node_modules/` en `dist/` staan bewust niet in git
([.gitignore](.gitignore)) — GitHub Pages heeft die ook niet nodig, het
serveert alleen de **gebouwde** bestanden.

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) bouwt de app
automatisch (`npm ci && npm run build`) en publiceert `dist/` naar GitHub
Pages bij elke push naar `main`. Eenmalig instellen:

1. Push deze repo naar GitHub.
2. Ga naar **Settings → Pages** en zet **Source** op **GitHub Actions**.
3. Bij de volgende push naar `main` verschijnt de site op
   `https://<gebruiker>.github.io/<repo-naam>/`.

`vite.config.js` gebruikt bewust relatieve asset-paden (`base: './'`), dus
dit werkt ongeacht onder welk subpad de repo gehost wordt. De app routeert
via de URL-hash (`#<kanaal-id>`), niet via losse paden, dus er is geen
server-side rewrite nodig voor deep links — precies wat statische hosting
zoals GitHub Pages wél en een pad-gebaseerde SPA-router niet vanzelf heeft.

## Architectuurprincipe

Elke toestandsverandering die andere deelnemers moeten meekrijgen, gaat als
Nostr-event het kanaal in — er is geen los kanaal (websocket, aparte API)
voor "app-events". Zie de constanten bovenaan [src/App.jsx](src/App.jsx)
voor het overzicht van alle gebruikte event-kinds:

| kind | betekenis | type |
|---|---|---|
| 1 | chatbericht | regulier, blijft bewaard |
| 1977 | document aangemaakt | regulier, blijft bewaard — klikbare link in chat |
| 1978 | document geopend | regulier, blijft bewaard — klikbare link in chat |
| 1979 | document hernoemd | regulier, blijft bewaard — klikbare link in chat |
| 1980 | video-oproep gestart | regulier, blijft bewaard — klikbare link in chat |
| 20077 | gebruiker kwam binnen | ephemeral |
| 20078 | gebruiker hernoemd | ephemeral |
| 20090 | WebRTC-peer aanwezig (announce) | ephemeral |
| 20091 | WebRTC-signaal (SDP/ICE), NIP-04-versleuteld | ephemeral |
| 30078 | documentenlijst | NIP-33, vervangbaar |
| 30079 | kanaalnaam | NIP-33, vervangbaar |
| 30080 | video-oproepenlijst | NIP-33, vervangbaar |

Publiceren gaat altijd via de centrale `publishEvent()`-helper in
`Dashboard` (App.jsx), zodat sign/publish/foutafhandeling overal identiek
is. Eén gecombineerde Nostr-subscriptie per kanaal routeert elk
binnenkomend event op basis van zijn `kind` naar de juiste plek in de
UI-state.

## Versleuteling van de inhoud

Relay-operators en anderen zonder de kanaal-URL kunnen niet meelezen: de
`content` van élk event hierboven (chatberichten, document-/oproepnamen,
weergavenamen, kanaalnaam, ...) wordt lokaal versleuteld vóórdat het de
relay op gaat, met een sleutel die via HKDF wordt afgeleid uit het
kanaal-ID zelf (`deriveChannelKey()` in App.jsx). Iedereen met de
kanaal-URL (dus de `#<kanaal-id>` in de hash) kan zo lezen én schrijven;
relays en toevallige meelezers zien alleen AES-GCM-ciphertext (IV +
versleutelde bytes, base64). Alleen de tags die de relay zelf nodig heeft
om events te kunnen filteren/adresseren (`t`, `d`, `p`) blijven
onversleuteld.

Belangrijk: die tags bevatten daarom bewust **niet** het kanaal-ID zelf,
maar een eenrichtings-hash ervan (`deriveChannelTag()` in App.jsx, SHA-256
met een eigen domein-string — losstaand van `deriveChannelKey()`, ook al is
de invoer gelijk). Zou de tag wél het kanaal-ID letterlijk bevatten (zoals
in een eerdere versie van deze app), dan kan iedereen die de relay
afluistert dat aflezen en met deze zelfde open-source code de
content-sleutel herberekenen — dan is de versleuteling alleen bescherming
tegen wie toevallig niet doorheeft dat het kanaal-ID in de tag verstopt
zit, niet tegen een relay-operator die het weet. Met de hash kan een
waarnemer events nog steeds filteren/matchen op kanaal, maar niet
terugrekenen naar het kanaal-ID (en dus niet naar de sleutel) — dat kan
alleen wie de kanaal-URL zelf heeft. Dezelfde pseudonimisering geldt voor
de WebRTC-documentsync-room-tag (`wsdoc-<hash>-<doc-id>`, zie
`useDocumentSync`); alleen de lokale IndexedDB-opslagnaam gebruikt nog het
rauwe kanaal-ID, want die verlaat de browser nooit.

Dit is aparte, symmetrische versleuteling naast de NIP-04-versleuteling die
al voor de WebRTC-signaling (SDP/ICE) werd gebruikt, die zit achter de
identity-sleutel van elke peer.

## Hoe het werkt

- **Kanaal-routing**: het kanaal-ID zit in de URL-hash. Geen hash → er wordt
  automatisch een cryptografisch willekeurige hex-ID gegenereerd
  (`useChannelId` in App.jsx).
- **Opgeslagen werkruimtes**: elk bezocht kanaal wordt met een naam in
  `localStorage` bewaard. Klik op de kanaalnaam linksboven om 'm te
  hernoemen (publiceert een kind-30079-event, zichtbaar voor iedereen in het
  kanaal); klik op het hamburger-icoon (☰) linksboven om naar een eerder
  kanaal te springen, een nieuw kanaal aan te maken (onderaan het lijstje),
  of een kanaal via het prullenbakje (met bevestiging, net als bij een
  document/video-oproep) uit dit lokale lijstje te verwijderen — dat is
  puur een bladwijzer weghalen, het kanaal zelf blijft gewoon bestaan en
  verschijnt vanzelf weer zodra je de link opnieuw bezoekt.
- **Achtergrond-notificaties voor andere kanalen**: naast het kanaal dat je
  nu open hebt, houdt `useChannelNotifications` (App.jsx) voor élk opgeslagen
  kanaal een lichte achtergrond-subscriptie bij — alleen de metadata-kinds
  (chatbericht, presence, document/oproep aangemaakt of geopend, video-oproep
  gestart of geopend), zónder de zware WebRTC-documentsync die alleen het
  actieve kanaal krijgt. Activiteit in een niet-geopend kanaal geeft een rood
  bolletje/teller op het "Opgeslagen werkruimtes"-menu-icoon, plus een
  tijdelijke (6s) toast-popup op precies dezelfde plek en in dezelfde stijl
  als het "Opgeslagen kanalen"-dropdownmenu zelf — met de daadwerkelijk
  ontsleutelde inhoud, in exact dezelfde formulering als de permanente
  pills/systeemberichten in de chat-tijdlijn (dus geen aparte, net-even-
  anders geformuleerde notificatietekst). Beide verdwijnen zodra je het
  kanaal echt opent. Eigen acties tellen bewust niet mee (gefilterd op eigen
  pubkey), en elk kanaal heeft een eigen since-cursor (pas actief vanaf het
  moment dat je het verlaat) — anders zou je bij het wisselen van kanaal
  steeds je eigen recente presence-join opnieuw als melding terugkrijgen.
- **Nostr-chat**: berichten zijn `kind 1`-events getagd met
  `t = wschat-<kanaal-id>`, gepubliceerd/opgehaald via `nostr-tools`
  (`SimplePool`) op `relay.damus.io`, `nos.lol` en `relay.nostr.band`. Zonder
  NIP-07-extensie (zoals Alby) wordt automatisch een ephemeral sleutelpaar
  gegenereerd en lokaal bewaard.
- **Presence**: bij binnenkomst en bij een naamswijziging (👤-knop
  onderaan de chat) verschijnt een systeembericht bij alle andere
  deelnemers.
- **Werkscherm-bureaublad**: het rechterpaneel start altijd op een
  "bureaublad" met iconen — "Nieuw document", "Nieuwe video-oproep", en
  daaronder elk al bestaand document/elke bestaande oproep. Een kanaal start
  bewust leeg; pas als iemand iets aanmaakt, gaat het bijbehorende event
  (documenten-/oproepenlijst + een klikbare "X heeft ... aangemaakt"-link in
  de chat) het kanaal in en verschijnt het icoon ook bij andere deelnemers.
  Een geopend document/oproep krijgt een eigen kop met ✕ om terug te gaan.
- **Klikbare activiteitenlinks in de chat**: aanmaken, openen en hernoemen
  van documenten, en het starten van een video-oproep, verschijnen als
  klikbare pills tussen de chatberichten (bv. "Johan heeft 'Notities'
  hernoemd naar 'Actiepunten'"). Klikken opent meteen het betreffende
  document of dezelfde video-oproep-kamer.
- **Collaboratieve editor**: BlockNoteJS + Yjs. Voor élk document in de
  workspace draait continu een achtergrond-syncsetje
  (`useDocumentSync` in App.jsx) — niet alleen voor het geopende document:
  - `IndexeddbPersistence` bewaart de inhoud lokaal in de browser, dus die
    overleeft een herlaad ook zonder dat er een andere peer online is.
  - een eigen `NostrWebrtcProvider` ([src/nostrWebrtc.js](src/nostrWebrtc.js))
    synchroniseert live P2P met andere online deelnemers.
  Zo blijft ieder document continu gesynchroniseerd tussen alle actieve
  peers, ook als niemand het er net open heeft staan.
- **Video-oproepen**: elke oproep krijgt een eigen, willekeurig ID (net als
  documenten) en dus een stabiele, altijd opnieuw te bereiken kamer bij
  `videobellen.pleio.nl/<kanaal-id>-<oproep-id>` — een zelfgehoste Jitsi
  Meet-instantie. De chat links blijft actief tijdens een gesprek.

## WebRTC-signaling via Nostr (geen aparte infra)

De collaboratieve editor gebruikt WebRTC om documentwijzigingen direct
tussen browsers te synchroniseren (peer-to-peer, geen server ziet de
inhoud). Om zo'n verbinding op te zetten moeten twee peers eerst een SDP-
offer/answer uitwisselen ("signaling") — normaal gesproken via een aparte
signaling-server. Deze app gebruikt daarvoor gewoon dezelfde Nostr-relays
als de rest van de app:

- `kind 20090` — "ik ben aanwezig in deze documentroom" (announce).
- `kind 20091` — het eigenlijke SDP/ICE-signaal, **NIP-04-versleuteld** en
  via een `p`-tag gericht aan één specifieke peer (SDP bevat lokale
  netwerk-IP's, die wil je niet in platte tekst op een publieke relay
  zetten).

Wie de verbinding initieert wordt deterministisch bepaald (laagste pubkey
initieert) zodat twee peers nooit gelijktijdig een offer sturen. Het
CRDT-sync- en awareness-protocol (cursors/selecties) is overgenomen van
`y-webrtc` (via de `y-protocols`-bibliotheek) — alleen de signaling-
transportlaag is vervangen. Zie de uitgebreide toelichting bovenin
[src/nostrWebrtc.js](src/nostrWebrtc.js).

## Techstack

React 18 (Vite) · Tailwind CSS · `nostr-tools` (incl. NIP-04) · `yjs` +
`y-indexeddb` (lokale persistentie) + `y-protocols` + `simple-peer` (eigen
Nostr-signaling, zie boven) · `@blocknote/core` + `@blocknote/react` +
`@blocknote/mantine` · Jitsi Meet (iframe naar `videobellen.pleio.nl`, geen
extra dependency nodig).
