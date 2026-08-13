import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/mantine/style.css';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import * as nip19 from 'nostr-tools/nip19';
import * as nip04 from 'nostr-tools/nip04';
import { NostrWebrtcProvider } from './nostrWebrtc.js';

/* ------------------------------------------------------------------ */
/*  Constanten                                                         */
/* ------------------------------------------------------------------ */

// Publieke Nostr-relays. Voeg er gerust meer toe voor betere dekking.
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'];

const LOCAL_SK_KEY = 'workspace_nostr_local_sk';

// -------------------------------------------------------------------
// Architectuurprincipe: ELKE toestandsverandering die andere peers moeten
// meekrijgen, gaat als Nostr-event het kanaal in — er is geen los kanaal
// (websocket, aparte API, ...) voor "app-events". Eén gecombineerde
// subscriptie in Dashboard (hieronder) luistert naar alle onderstaande
// kinds, gescoped met dezelfde 't'-tag (chatTag) per kanaal, en routeert
// per kind naar de juiste state. Publiceren gaat altijd via de
// `publishEvent()`-helper in Dashboard, zodat elk event dezelfde
// sign/publish/foutafhandeling deelt.
//
// De `content` van elk event hieronder is versleuteld met een uit het
// kanaal-ID afgeleide sleutel (zie deriveChannelKey/encryptContent
// verderop) — inclusief de weergavenaam van wie de actie deed, die dus
// niet meer als losse leesbare tag meegaat. Alleen 't'/'d'/'p'-tags (nodig
// voor relay-filtering/-adressering) blijven onversleuteld.
//
//   kind 1      chatbericht                (regulier, blijft bewaard)
//   kind 1977   document aangemaakt        (regulier, blijft bewaard — klikbare link in chat)
//   kind 1978   document geopend           (regulier, blijft bewaard — klikbare link in chat)
//   kind 1979   document hernoemd          (regulier, blijft bewaard — klikbare link in chat)
//   kind 1980   video-oproep gestart       (regulier, blijft bewaard — klikbare link in chat)
//   kind 1981   video-oproep hernoemd      (regulier, blijft bewaard — klikbare link in chat)
//   kind 1982   document verwijderd        (regulier, blijft bewaard — systeembericht in chat)
//   kind 1983   video-oproep verwijderd    (regulier, blijft bewaard — systeembericht in chat)
//   kind 1984   video-oproep geopend       (regulier, blijft bewaard — klikbare link in chat)
//   kind 20077  gebruiker kwam binnen       (ephemeral, niet bewaard)
//   kind 20078  gebruiker hernoemd          (ephemeral, niet bewaard)
//   kind 30078  documentenlijst             (NIP-33, vervangbaar per 'd'-tag)
//   kind 30079  kanaalnaam                  (NIP-33, vervangbaar per 'd'-tag)
//   kind 30080  video-oproepenlijst         (NIP-33, vervangbaar per 'd'-tag)
// -------------------------------------------------------------------

// We scopen chatberichten met een 't'-tag (hashtag) i.p.v. het formele
// NIP-28 kind 42 kanaal-model (dat een aparte kind-40 "kanaal aanmaken"-event
// vereist). Dat houdt het robuust op algemene relays terwijl het nog steeds
// binnen de "Kind 42 of Kind 1"-eis valt: we gebruiken hier kind 1.
const CHAT_KIND = 1;

// Reguliere (blijvend bewaarde) events voor de klikbare "X heeft document Y
// aangemaakt/geopend/hernoemd" / "X heeft video-oproep Y gestart"-links in
// de chat. Bewust géén ephemeral events: dit moeten net als chatberichten
// in de geschiedenis blijven staan, zodat je later nog kunt terugscrollen
// en op zo'n link kunt klikken om het document/de video-oproep te openen.
const DOC_CREATED_KIND = 1977;
const DOC_OPENED_KIND = 1978;
const DOC_RENAMED_KIND = 1979;
const CALL_STARTED_KIND = 1980;
const CALL_RENAMED_KIND = 1981;
const DOC_DELETED_KIND = 1982;
const CALL_DELETED_KIND = 1983;
const CALL_OPENED_KIND = 1984;

// Ephemeral events (NIP-01: kind 20000-29999) — relays hoeven deze niet te
// bewaren, ze worden alleen doorgestuurd naar wie op dat moment is
// geabonneerd. Precies wat je wilt voor "X is binnengekomen" / "X heet nu
// Y" — geen geschiedenis, geen opgeblazen relay-opslag.
const PRESENCE_JOIN_KIND = 20077;
const PRESENCE_RENAME_KIND = 20078;

// Parameteriseerbare, vervangbare events (NIP-33: kind 30000-39999) — een
// relay bewaart per (kind, pubkey, 'd'-tag) alleen de laatste versie. Ideaal
// voor "duurzame" kanaalstoestand zoals de documenten-/video-oproepenlijst
// en de kanaalnaam: nieuwe peers krijgen bij binnenkomst meteen de actuele
// stand, zonder dat alle tussenliggende wijzigingen bewaard hoeven blijven.
const DOCLIST_KIND = 30078;
const CHANNEL_META_KIND = 30079;
const CALLLIST_KIND = 30080;

const SAVED_CHANNELS_KEY = 'workspace_saved_channels';
const DISPLAY_NAME_KEY = 'workspace_display_name';

/* ------------------------------------------------------------------ */
/*  Kleine hulpfuncties                                                */
/* ------------------------------------------------------------------ */

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// Genereert een willekeurige, Nostr-compatibele hex-string die dienst doet
// als kanaal-ID (gebruikt als URL-hash en als scoping-tag, niet als echte
// event-ID).
function generateChannelId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function generateDefaultDisplayName() {
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  return `Gast-${bytesToHex(bytes)}`;
}

function colorFromString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 50%)`;
}

function loadSavedChannels() {
  try {
    const raw = localStorage.getItem(SAVED_CHANNELS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistSavedChannels(list) {
  localStorage.setItem(SAVED_CHANNELS_KEY, JSON.stringify(list));
}

// Een nieuw kanaal start bewust zonder documenten of video-oproepen — pas
// als iemand op "Nieuw document"/"Nieuwe video-oproep" klikt, ontstaat er
// één (en gaat het bijbehorende Nostr-event het kanaal in, zichtbaar voor
// alle andere deelnemers). Generiek voor beide lijst-soorten.
function loadLocalList(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* corrupte data negeren */
  }
  return [];
}

function persistLocalList(storageKey, list) {
  localStorage.setItem(storageKey, JSON.stringify(list));
}

function mergeDocs(local, remote) {
  const map = new Map();
  local.forEach((d) => map.set(d.id, d));
  remote.forEach((d) => map.set(d.id, d));
  return Array.from(map.values());
}

// -------------------------------------------------------------------
// Content-encryptie: de `content` van élk Nostr-event (chatbericht,
// document-/video-oproepnamen, kanaalnaam, wie welke actie deed, ...)
// wordt versleuteld met een sleutel die uit het kanaal-ID zelf wordt
// afgeleid — Web Crypto API (HKDF → AES-GCM), geen extra dependency nodig.
// Iedereen met de kanaal-URL kan dus nog gewoon meelezen/schrijven (zelfde
// vertrouwensmodel als "wie de link heeft"), maar relay-operators en
// iedereen zonder die URL zien alleen ciphertext. De 't'/'d'/'p'-tags
// blijven bewust onversleuteld: die heeft de relay nodig om events te
// kunnen filteren/adresseren (versleutel je die ook, dan werkt de hele
// subscriptie/NIP-33-addressering niet meer). De weergavenaam van de
// afzender ('name'-tag in eerdere versies) zit daarom ook niet meer los
// als tag, maar in de versleutelde content.
//
// Cruciaal hierbij: die 't'/'d'-tags mogen zelf NOOIT het kanaal-ID
// letterlijk bevatten. Zouden ze dat wel doen (zoals in een eerdere versie
// — `t = wschat-<channelId>`), dan kan iedereen die de relay afluistert de
// tag aflezen, het vaste prefix wegstrippen, en met deze zelfde (publieke,
// open-source) code de sleutel herberekenen — dan "beschermt" de
// versleuteling alleen tegen wie toevallig niet doorheeft dat het
// kanaal-ID gewoon in de tag verstopt zit. Daarom wordt hier een apart,
// eenrichtings-afgeleid pseudoniem (SHA-256-hash) van het kanaal-ID
// gebruikt voor alle publieke tags/adressering — dat verraadt niets over
// het kanaal-ID zelf, terwijl de sleutel wél nog van het échte kanaal-ID
// wordt afgeleid. Zie deriveChannelTag() hieronder.
async function deriveChannelKey(channelId) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(channelId), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('community-workspace'), info: encoder.encode('channel-content-v1') },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Eenrichtings-pseudoniem van het kanaal-ID, gebruikt voor alles wat
// publiek als tag over de relay gaat (chat-tag, NIP-33 'd'-tags, WebRTC-
// signaling-room-tag). Een waarnemer ziet alleen deze hash, en kan daar
// niet het kanaal-ID (en dus niet de content-sleutel) uit terugrekenen.
// Los gehouden van deriveChannelKey (andere 'info'-string) zodat het
// evident twee onafhankelijke afgeleiden zijn, ook al is de invoer gelijk.
async function deriveChannelTag(channelId) {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`community-workspace-tag-v1:${channelId}`));
  return bytesToHex(new Uint8Array(digest)).slice(0, 32);
}

function bytesToBase64(bytes) {
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function encryptContent(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(combined);
}

async function decryptContent(key, encoded) {
  const combined = base64ToBytes(encoded);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plainBuf);
}

/* ------------------------------------------------------------------ */
/*  Nostr-identiteit                                                   */
/* ------------------------------------------------------------------ */

// Gebruikt een NIP-07 extensie (zoals Alby) indien aanwezig, anders wordt
// er automatisch een ephemeral sleutelpaar gegenereerd en lokaal bewaard
// zodat de identiteit binnen deze browser/sessie behouden blijft.
function useNostrIdentity() {
  const [identity, setIdentity] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      if (typeof window.nostr !== 'undefined') {
        try {
          const pubkey = await window.nostr.getPublicKey();
          if (!cancelled) {
            setIdentity({
              pubkey,
              npub: nip19.npubEncode(pubkey),
              type: 'extension',
              signEvent: (template) => window.nostr.signEvent(template),
              // NIP-04 is optioneel in NIP-07 — niet elke extensie
              // implementeert het. Gebruikt voor het versleutelen van
              // WebRTC-signaleringsdata (zie nostrWebrtc.js).
              encrypt: window.nostr.nip04 ? (pubkey_, text) => window.nostr.nip04.encrypt(pubkey_, text) : undefined,
              decrypt: window.nostr.nip04 ? (pubkey_, data) => window.nostr.nip04.decrypt(pubkey_, data) : undefined,
            });
          }
          return;
        } catch (err) {
          console.warn('NIP-07 extensie geweigerd of mislukt, val terug op lokale sleutel.', err);
        }
      }

      let skHex = localStorage.getItem(LOCAL_SK_KEY);
      let sk;
      if (skHex) {
        sk = hexToBytes(skHex);
      } else {
        sk = generateSecretKey();
        skHex = bytesToHex(sk);
        localStorage.setItem(LOCAL_SK_KEY, skHex);
      }
      const pubkey = getPublicKey(sk);
      if (!cancelled) {
        setIdentity({
          pubkey,
          npub: nip19.npubEncode(pubkey),
          type: 'local',
          signEvent: async (template) => finalizeEvent(template, sk),
          // Voor het versleutelen van WebRTC-signaleringsdata (zie
          // nostrWebrtc.js).
          encrypt: async (theirPubkey, text) => nip04.encrypt(sk, theirPubkey, text),
          decrypt: async (theirPubkey, data) => nip04.decrypt(sk, theirPubkey, data),
        });
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  return identity;
}

// Weergavenaam van de gebruiker: los van de Nostr-identiteit (die blijft
// een technisch npub), globaal bewaard in localStorage zodat 'm in elk
// kanaal hetzelfde is. Wordt gebruikt in presence-events ("X kwam binnen",
// "X heet nu Y") en om berichten van anderen mee te labelen.
function useDisplayName() {
  const [displayName, setDisplayNameState] = useState(() => {
    const stored = localStorage.getItem(DISPLAY_NAME_KEY);
    if (stored) return stored;
    const fresh = generateDefaultDisplayName();
    localStorage.setItem(DISPLAY_NAME_KEY, fresh);
    return fresh;
  });

  function setDisplayName(name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    localStorage.setItem(DISPLAY_NAME_KEY, trimmed);
    setDisplayNameState(trimmed);
  }

  return [displayName, setDisplayName];
}

// Houdt voor ÉLK document in de workspace een achtergrond-syncsetje bij
// (Y.Doc + lokale IndexedDB-persistentie + NostrWebrtcProvider) — niet
// alleen voor het document dat op dit moment open staat. Zo blijft elk
// document continu gesynchroniseerd tussen alle online deelnemers, ook als
// niemand het net open heeft staan; wie het later opent, krijgt meteen de
// actuele stand in plaats van te moeten wachten tot er toevallig iemand
// anders tegelijk inlogt. Kost meer achtergrondverbindingen naarmate een
// kanaal meer documenten heeft — een bewuste afweging.
function useDocumentSync(pool, identity, channelId, docs) {
  const instancesRef = useRef(new Map()); // docId -> { ydoc, idbPersistence, provider }
  const [, forceRender] = useState(0);
  // Eenrichtings-pseudoniem van channelId (zie deriveChannelTag) — gebruikt
  // voor de WebRTC-signaling-'t'-tag, die net als chatTag/docsDTag publiek
  // over de relay gaat en dus nooit het rauwe channelId mag prijsgeven.
  const [channelTag, setChannelTag] = useState(null);

  useEffect(() => {
    let cancelled = false;
    deriveChannelTag(channelId).then((tag) => {
      if (!cancelled) setChannelTag(tag);
    });
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  useEffect(() => {
    if (!pool || !identity || !channelTag) return;
    let changed = false;
    const currentIds = new Set(docs.map((d) => d.id));

    docs.forEach((doc) => {
      if (instancesRef.current.has(doc.id)) return;
      // Lokale IndexedDB-naam: blijft gewoon het rauwe channelId, want die
      // komt nooit over het netwerk — puur een lokale opslagsleutel.
      const localName = `wsdoc-${channelId}-${doc.id}`;
      // Publieke Nostr-'t'-tag voor de WebRTC-signaling: het pseudoniem,
      // niet het rauwe channelId (zie deriveChannelTag hierboven).
      const roomTag = `wsdoc-${channelTag}-${doc.id}`;
      const ydoc = new Y.Doc();
      const idbPersistence = new IndexeddbPersistence(localName, ydoc);
      const provider = new NostrWebrtcProvider(roomTag, ydoc, { pool, relays: RELAYS, identity });
      instancesRef.current.set(doc.id, { ydoc, idbPersistence, provider });
      changed = true;
    });

    // Een document dat niet meer in de lijst staat, is verwijderd: sync
    // stoppen én de lokale IndexedDB-kopie wissen (clearData(), niet alleen
    // destroy()) zodat er geen vergeten kopie achterblijft.
    instancesRef.current.forEach(({ provider, idbPersistence, ydoc }, id) => {
      if (currentIds.has(id)) return;
      provider.destroy();
      idbPersistence.clearData();
      ydoc.destroy();
      instancesRef.current.delete(id);
      changed = true;
    });

    if (changed) forceRender((n) => n + 1);
  }, [pool, identity, channelId, channelTag, docs]);

  // Volledige opruiming bij het verlaten van dit kanaal (Dashboard
  // remount). Effect zonder deps + lege cleanup-registratie: draait maar
  // één keer, ongeacht hoe vaak het bovenstaande effect opnieuw vuurt.
  useEffect(() => {
    return () => {
      instancesRef.current.forEach(({ provider, idbPersistence, ydoc }) => {
        provider.destroy();
        idbPersistence.destroy();
        ydoc.destroy();
      });
      instancesRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return instancesRef.current;
}

/* ------------------------------------------------------------------ */
/*  URL-hash routing                                                    */
/* ------------------------------------------------------------------ */

function useChannelId() {
  const [channelId, setChannelId] = useState(null);

  useEffect(() => {
    function resolve() {
      const hash = window.location.hash.replace(/^#/, '');
      if (!hash) {
        // Geen kanaal in de URL: genereer er één en herschrijf de hash.
        // Dit triggert een 'hashchange'-event dat resolve() opnieuw aanroept.
        window.location.hash = generateChannelId();
      } else {
        setChannelId(hash);
      }
    }

    resolve();
    window.addEventListener('hashchange', resolve);
    return () => window.removeEventListener('hashchange', resolve);
  }, []);

  return channelId;
}

/* ------------------------------------------------------------------ */
/*  Achtergrond-notificaties voor niet-actieve opgeslagen kanalen       */
/* ------------------------------------------------------------------ */

// Welke event-kinds een achtergrondmelding waard zijn, en onder welke
// categorie ze in de badge meetellen. Bewust een kleine, vaste
// deelverzameling: geen documentsync (useDocumentSync draait WebRTC per
// document — te duur om voor élk opgeslagen kanaal tegelijk te laten
// lopen) en geen content-decryptie (niet nodig voor een telling, en
// scheelt AES-GCM-werk voor kanalen die je toch niet actief volgt — de
// kind zelf zit altijd onversleuteld in het event, alleen de content niet).
const NOTIFICATION_KIND_CATEGORY = {
  [CHAT_KIND]: 'message',
  [PRESENCE_JOIN_KIND]: 'presence',
  [DOC_CREATED_KIND]: 'doc',
  [DOC_OPENED_KIND]: 'doc',
  [CALL_STARTED_KIND]: 'call',
  [CALL_OPENED_KIND]: 'call',
};

// Houdt voor elk opgeslagen kanaal — behalve het kanaal dat nu actief open
// staat, dat krijgt al de volledige live behandeling via Dashboard — een
// lichte achtergrond-subscriptie bij. Eén gecombineerde subscriptie voor
// alle gevolgde kanalen tegelijk (één '#t'-filter met alle tags erin), dus
// dit blijft ook met tientallen opgeslagen kanalen licht.
// Zet een gedecodeerd notificatie-event om naar een leesbare regel + wie
// 'm deed, voor de toast-popup. Bewust letterlijk dezelfde formulering als
// de permanente pills/systeemberichten in de chat-tijdlijn zelf (zie de
// 'doclink'/'calllink'-rendering en de PRESENCE_JOIN_KIND-case verderop in
// Dashboards eigen switch-statement) — dit is hetzelfde event, dus geen
// aparte, net-even-anders geformuleerde notificatietekst.
function describeNotificationEvent(kind, decrypted) {
  if (kind === CHAT_KIND) {
    return { authorName: null, line: decrypted };
  }
  let parsed;
  try {
    parsed = JSON.parse(decrypted);
  } catch {
    return null;
  }
  const authorName = parsed.name ?? 'Iemand';
  if (kind === PRESENCE_JOIN_KIND) return { authorName, line: 'is de chat binnengekomen' };
  if (kind === DOC_CREATED_KIND) return { authorName, line: `heeft "${parsed.docName}" aangemaakt` };
  if (kind === DOC_OPENED_KIND) return { authorName, line: `heeft "${parsed.docName}" geopend` };
  if (kind === CALL_STARTED_KIND) return { authorName, line: `heeft video-oproep "${parsed.callName}" gestart` };
  if (kind === CALL_OPENED_KIND) return { authorName, line: `heeft video-oproep "${parsed.callName}" geopend` };
  return null;
}

// Hoe lang een toast-popup zichtbaar blijft voordat 'm vanzelf verdwijnt.
const TOAST_DURATION_MS = 6000;

function useChannelNotifications(pool, savedChannels, activeChannelId, myPubkey) {
  const [notifications, setNotifications] = useState({});
  const [toasts, setToasts] = useState([]);
  const toastTimersRef = useRef(new Map());
  // channelId -> channelTag (het eenrichtings-pseudoniem, zie deriveChannelTag)
  const tagByChannelRef = useRef(new Map());
  // channelId -> AES-sleutel (zie deriveChannelKey) — nodig om de content
  // van een binnenkomend event te kunnen ontsleutelen voor de toast-tekst.
  const channelKeyByIdRef = useRef(new Map());
  // volledige 't'-tagwaarde -> channelId, om bij een binnenkomend event
  // (dat alleen de tag draagt, niet het channelId zelf) de bron terug te
  // vinden.
  const channelByTagRef = useRef(new Map());
  const subRef = useRef(null);
  // channelId -> vanaf welk moment (unix-seconden) events voor dát kanaal
  // meetellen. Bewust per kanaal i.p.v. één globale "since": zonder dit zou
  // een kanaal dat je zojuist hebt verlaten in één klap zijn hele
  // geschiedenis-sinds-het-opstarten-van-de-app "herontdekken" zodra de
  // subscriptie 'm weer meeneemt — inclusief bijvoorbeeld je eigen
  // presence-join-event van toen je het net opende. Wordt gezet zodra een
  // kanaal voor het eerst in de watchlist verschijnt, én opnieuw
  // opgeschoven naar "nu" door clearChannel() zodra je het weer opent.
  const channelSinceRef = useRef(new Map());
  // Dezelfde relay levert hetzelfde event maar via meerdere relays tegelijk
  // af (elke relay-verbinding roept onevent apart aan) — zonder dedup op
  // event-id telt één bericht dus 2-3x mee. Zelfde patroon als seenRef in
  // Dashboard.
  const seenRef = useRef(new Set());

  // activeChannelId is bij de allereerste render nog even null (vóórdat
  // useChannelId de URL-hash heeft uitgelezen) — behandel dat expliciet als
  // "nog niets volgen" i.p.v. per ongeluk ook het straks-actieve kanaal in
  // de watchlist te zetten. Zonder deze guard kan er in dat korte venster
  // een subscriptie ontstaan die het eigen kanaal meetelt, met een badge op
  // je eigen open kanaal tot gevolg.
  const watchIds = activeChannelId
    ? savedChannels.map((c) => c.id).filter((id) => id !== activeChannelId)
    : [];
  // Stabiele string-key zodat het effect hieronder alleen opnieuw draait
  // als de sét te volgen kanalen echt verandert, niet bij elke render.
  const watchKey = watchIds.slice().sort().join(',');

  useEffect(() => {
    if (!pool || watchIds.length === 0) return;
    let cancelled = false;

    (async () => {
      const tags = [];
      let minSince = null;
      for (const id of watchIds) {
        let tag = tagByChannelRef.current.get(id);
        if (!tag) {
          tag = await deriveChannelTag(id);
          if (cancelled) return;
          tagByChannelRef.current.set(id, tag);
          channelByTagRef.current.set(`wschat-${tag}`, id);
        }
        if (!channelKeyByIdRef.current.has(id)) {
          const key = await deriveChannelKey(id);
          if (cancelled) return;
          channelKeyByIdRef.current.set(id, key);
        }
        if (!channelSinceRef.current.has(id)) {
          channelSinceRef.current.set(id, Math.floor(Date.now() / 1000));
        }
        const since = channelSinceRef.current.get(id);
        if (minSince === null || since < minSince) minSince = since;
        tags.push(`wschat-${tag}`);
      }
      if (cancelled || tags.length === 0) return;

      // since hierin is bewust de ruimste (vroegste) grens over alle
      // gevolgde kanalen — een veilige ondergrens richting de relay. De
      // exacte, per-kanaal grens wordt hieronder in onevent() gehandhaafd.
      subRef.current = pool.subscribeMany(
        RELAYS,
        {
          kinds: Object.keys(NOTIFICATION_KIND_CATEGORY).map(Number),
          '#t': tags,
          since: minSince,
        },
        {
          async onevent(event) {
            if (seenRef.current.has(event.id)) return;
            seenRef.current.add(event.id);
            const tTag = event.tags.find((t) => t[0] === 't')?.[1];
            const sourceChannelId = tTag && channelByTagRef.current.get(tTag);
            const category = NOTIFICATION_KIND_CATEGORY[event.kind];
            if (!sourceChannelId || !category) return;
            if (event.pubkey === myPubkey) return;
            const watchedSince = channelSinceRef.current.get(sourceChannelId);
            if (watchedSince != null && event.created_at < watchedSince) return;
            setNotifications((prev) => {
              const current = prev[sourceChannelId] ?? { message: 0, doc: 0, call: 0, presence: 0 };
              return { ...prev, [sourceChannelId]: { ...current, [category]: current[category] + 1 } };
            });

            // Toast-popup met de daadwerkelijke (ontsleutelde) inhoud — puur
            // best-effort: lukt ontsleutelen/parsen niet (corrupte payload,
            // sleutel nog niet klaar), dan telt de badge hierboven al mee en
            // slaan we gewoon de toast over.
            const key = channelKeyByIdRef.current.get(sourceChannelId);
            if (!key) return;
            let decrypted;
            try {
              decrypted = await decryptContent(key, event.content);
            } catch {
              return;
            }
            const described = describeNotificationEvent(event.kind, decrypted);
            if (!described || !described.line) return;
            const channelName =
              savedChannels.find((c) => c.id === sourceChannelId)?.name ?? `Kanaal ${sourceChannelId.slice(0, 6)}`;
            const toastId = event.id;
            setToasts((prev) => [...prev, { id: toastId, channelId: sourceChannelId, channelName, ...described }]);
            const timer = setTimeout(() => {
              setToasts((prev) => prev.filter((t) => t.id !== toastId));
              toastTimersRef.current.delete(toastId);
            }, TOAST_DURATION_MS);
            toastTimersRef.current.set(toastId, timer);
          },
        }
      );
    })();

    return () => {
      cancelled = true;
      subRef.current?.close();
      subRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, watchKey, myPubkey]);

  // Alle lopende auto-dismiss-timers opruimen bij unmount (App leeft de
  // hele sessie, dus dit is puur voor de volledigheid).
  useEffect(() => {
    return () => {
      toastTimersRef.current.forEach((timer) => clearTimeout(timer));
      toastTimersRef.current.clear();
    };
  }, []);

  function clearChannel(id) {
    // Schuift de since-cursor van dit kanaal op naar nu: verlaat je het
    // straks weer, dan telt alleen wat er ná dit moment gebeurt nog mee —
    // niet alles wat al (opnieuw) geleerd was vóór je het nu opende.
    channelSinceRef.current.set(id, Math.floor(Date.now() / 1000));
    setNotifications((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    // Toasts van dit kanaal zijn achterhaald zodra je het opent.
    setToasts((prev) => prev.filter((t) => t.channelId !== id));
  }

  function dismissToast(id) {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  return { notifications, clearChannel, toasts, dismissToast };
}

/* ------------------------------------------------------------------ */
/*  App root                                                            */
/* ------------------------------------------------------------------ */

export default function App() {
  const channelId = useChannelId();
  const poolRef = useRef(null);
  if (!poolRef.current) poolRef.current = new SimplePool();
  // Ook hier (naast in Dashboard) opgevraagd: dezelfde, localStorage-
  // gebaseerde identiteit (of NIP-07-extensie), puur om straks eigen
  // events te kunnen herkennen en uitsluiten van notificaties — zie
  // useChannelNotifications hieronder.
  const identity = useNostrIdentity();

  // savedChannels leeft hier (in App), niet in Dashboard: Dashboard wordt
  // via key={channelId} volledig opnieuw opgebouwd bij elke kanaalwissel,
  // maar de achtergrond-notificatie-subscriptie hieronder moet juist over
  // zo'n wissel heen blijven bestaan.
  const [savedChannels, setSavedChannels] = useState(loadSavedChannels);
  const { notifications, clearChannel, toasts, dismissToast } = useChannelNotifications(
    poolRef.current,
    savedChannels,
    channelId,
    identity?.pubkey
  );

  // Zodra je een kanaal echt opent, is de achtergrondmelding daarvoor
  // achterhaald (je ziet het nu toch al live in Dashboard) — badge wissen.
  useEffect(() => {
    if (channelId) clearChannel(channelId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  useEffect(() => {
    return () => {
      poolRef.current?.close(RELAYS);
    };
  }, []);

  if (!channelId) {
    return (
      <div className="h-dvh w-screen flex items-center justify-center bg-slate-100 text-slate-400 text-sm">
        Kanaal wordt geladen…
      </div>
    );
  }

  // key={channelId} laat de volledige dashboard (incl. alle Nostr/Yjs
  // abonnementen) schoon opnieuw opbouwen wanneer je van kanaal wisselt.
  // toasts/dismissToast gaan mee tot in ChatPanel: die toont ze op precies
  // dezelfde plek als het "Opgeslagen kanalen"-dropdownmenu (zie daar) —
  // ze horen inhoudelijk bij elkaar, dus bewust geen apart, los zwevend
  // toast-vlak elders in beeld.
  return (
    <Dashboard
      key={channelId}
      channelId={channelId}
      pool={poolRef.current}
      savedChannels={savedChannels}
      setSavedChannels={setSavedChannels}
      notifications={notifications}
      toasts={toasts}
      dismissToast={dismissToast}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Dashboard: bevat het volledige split-screen                        */
/* ------------------------------------------------------------------ */

function Dashboard({ channelId, pool, savedChannels, setSavedChannels, notifications, toasts, dismissToast }) {
  const identity = useNostrIdentity();
  const [displayName, setDisplayNameLocal] = useDisplayName();
  const [menuOpen, setMenuOpen] = useState(false);
  const [docs, setDocs] = useState(() => loadLocalList(`wsdocs:${channelId}`));
  const [calls, setCalls] = useState(() => loadLocalList(`wscalls:${channelId}`));
  // Bewust altijd null bij het (opnieuw) openen van een kanaal: de
  // workspace start altijd op het bureaublad, ook als er al documenten of
  // video-oproepen bestaan — die open je bewust via een icoon of een link
  // in de chat. { type: 'doc' | 'call', id } of null (= bureaublad).
  const [activeItem, setActiveItem] = useState(null);
  // Op smalle schermen (< Tailwind's md-breakpoint) is er geen ruimte voor
  // chat én werkruimte naast elkaar — dan toont ChatPanel/WorkspacePanel er
  // maar één tegelijk (fullscreen), omgeschakeld via de tabbalk onderin
  // (zie MobileViewSwitcher). Op md+ genegeerd: daar staan beide altijd
  // gewoon naast elkaar, zoals al het geval was.
  const [mobileView, setMobileView] = useState('chat');
  // Een "gedockte" video-oproep: puur lokale UI-state (niet gesynchroniseerd
  // via Nostr — of jij een call minimaliseert is jouw eigen zaak), losgekoppeld
  // van activeItem zodat de Jitsi-iframe blijft draaien terwijl je ergens
  // anders naartoe navigeert. { id, name } of null.
  const [dockedCall, setDockedCall] = useState(null);
  const [entries, setEntries] = useState([]);
  const [peerNames, setPeerNames] = useState({});
  // Achtergrond-syncsetje (Y.Doc + IndexedDB + WebRTC) per document —
  // altijd actief voor de hele documentenlijst, niet alleen het geopende
  // document. Zie useDocumentSync hierboven voor het waarom.
  const docSyncInstances = useDocumentSync(pool, identity, channelId, docs);

  // channelTag: het eenrichtings-pseudoniem van channelId (zie
  // deriveChannelTag), ná gebruikt voor élke publieke tag/adressering.
  // Vóór het laden is dit nog null — de tags hieronder verwijzen dan
  // tijdelijk naar 'wschat-null' e.d., maar dat is onschadelijk: elke
  // plek die deze tags gebruikt om te publiceren/abonneren wacht al op
  // channelKey (zie channelKeyRef-check in publishEvent en de guard in de
  // subscriptie-effect hieronder), die pas tegelijk met channelTag klaar is.
  const [channelTag, setChannelTag] = useState(null);
  const chatTag = `wschat-${channelTag}`;
  const docsDTag = `wsdocs-${channelTag}`;
  const callsDTag = `wscalls-${channelTag}`;
  const channelMetaDTag = `wschannel-${channelTag}`;

  const seenRef = useRef(new Set());
  const joinedRef = useRef(false);
  const displayNameRef = useRef(displayName);
  displayNameRef.current = displayName;
  // De subscriptie-effect hieronder heeft [identity] als dependency en
  // krijgt dus een verse closure zodra de identiteit laadt — maar vlak vóór
  // die overgang kan de oude (identity=null) subscriptie nog heel even een
  // binnenkomend eigen event verwerken. Door altijd via deze ref te lezen
  // i.p.v. de closure-variabele, is "is dit mijn eigen event?" nooit
  // afhankelijk van wélke render de closure is aangemaakt.
  const identityRef = useRef(identity);
  identityRef.current = identity;
  // De sleutel waarmee alle content in dit kanaal wordt versleuteld/
  // ontsleuteld — afgeleid van het kanaal-ID (zie deriveChannelKey). State
  // om effects erop te laten wachten, ref om 'm binnen de onevent-closure
  // altijd actueel te kunnen lezen (zelfde reden als identityRef).
  const [channelKey, setChannelKey] = useState(null);
  const channelKeyRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    // Beide afgeleiden van hetzelfde channelId, maar met een eigen
    // 'info'/domein-string (zie deriveChannelKey/deriveChannelTag) — de
    // publieke tag (channelTag) mag nooit gebruikt kunnen worden om de
    // geheime content-sleutel (channelKey) te reconstrueren.
    Promise.all([deriveChannelKey(channelId), deriveChannelTag(channelId)]).then(([key, tag]) => {
      if (cancelled) return;
      channelKeyRef.current = key;
      setChannelKey(key);
      setChannelTag(tag);
    });
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  // Bewaart het created_at van het laatst toegepaste kanaalnaam-/
  // documentenlijst-/video-oproepenlijst-event. Zonder deze guard kan een
  // ouder event dat via een tragere relay laat aankomt (bv. het originele
  // "aangemaakt"-event dat de rename-event inhaalt) een net doorgevoerde
  // hernoeming alsnog terugdraaien.
  const channelMetaAtRef = useRef(0);
  const docsAtRef = useRef(0);
  const callsAtRef = useRef(0);
  // Onthoudt wat er in de workspace te zien was vlak vóórdat een video-
  // oproep fullscreen ging, zodat "docken" (minimaliseren) je daar weer
  // naartoe terugbrengt in plaats van altijd naar het bureaublad.
  const preCallItemRef = useRef(null);

  // Zorg dat het huidige kanaal in het lokale geheugen ("OpenDiensten"-
  // concept) staat zodra je het bezoekt.
  useEffect(() => {
    setSavedChannels((prev) => {
      if (prev.some((c) => c.id === channelId)) return prev;
      const entry = {
        id: channelId,
        name: `Kanaal ${channelId.slice(0, 6)}`,
        url: `${window.location.origin}${window.location.pathname}#${channelId}`,
        createdAt: Date.now(),
      };
      const next = [entry, ...prev];
      persistSavedChannels(next);
      return next;
    });
  }, [channelId]);

  // Centrale publicatie-helper: ELK app-event (chatbericht, kanaal
  // hernoemen, gebruiker hernoemen, documentenlijst, video-call-start, ...)
  // gaat hierdoorheen, zodat sign/publish/foutafhandeling overal identiek
  // is — dit is het architectuurprincipe: alle toestand die andere peers
  // moeten meekrijgen, gaat als Nostr-event het kanaal in.
  async function publishEvent(kind, tags, content = '') {
    if (!identity || !pool || !channelKeyRef.current) return null;
    const encryptedContent = content ? await encryptContent(channelKeyRef.current, content) : '';
    const template = { kind, created_at: Math.floor(Date.now() / 1000), tags, content: encryptedContent };
    try {
      const signed = await identity.signEvent(template);
      // pool.publish geeft per relay een eigen Promise terug; zonder .catch
      // hierop zou een relay-afwijzing (bv. rate-limit) stil verdwijnen.
      pool.publish(RELAYS, signed).forEach((p) => p.catch((err) => console.warn(`Relay wees event (kind ${kind}) af.`, err)));
      return signed;
    } catch (err) {
      console.error(`Kon event (kind ${kind}) niet publiceren.`, err);
      return null;
    }
  }

  // Eén gecombineerde subscriptie voor alles wat bij dit kanaal hoort: zie
  // het architectuur-overzicht bovenaan het bestand voor welke kinds dat
  // zijn en waarom. Elk event wordt op basis van zijn kind naar de juiste
  // state gerouteerd.
  useEffect(() => {
    if (!pool || !channelKey) return;
    seenRef.current = new Set();
    setEntries([]);
    setPeerNames({});
    // Let op: subscribeMany verwacht in nostr-tools v2 één los filter-object
    // (geen array van filters), anders wordt de REQ naar de relay ongeldig.
    const sub = pool.subscribeMany(
      RELAYS,
      {
        kinds: [
          CHAT_KIND,
          DOC_CREATED_KIND,
          DOC_OPENED_KIND,
          DOC_RENAMED_KIND,
          CALL_STARTED_KIND,
          CALL_OPENED_KIND,
          CALL_RENAMED_KIND,
          DOC_DELETED_KIND,
          CALL_DELETED_KIND,
          PRESENCE_JOIN_KIND,
          PRESENCE_RENAME_KIND,
          DOCLIST_KIND,
          CHANNEL_META_KIND,
          CALLLIST_KIND,
        ],
        '#t': [chatTag],
        limit: 300,
      },
      {
        async onevent(event) {
          if (seenRef.current.has(event.id)) return;
          seenRef.current.add(event.id);

          // Content ontsleutelen vóórdat we 'm ergens op routeren. Voor
          // CHAT_KIND is dat de rauwe berichttekst zelf; voor de rest een
          // JSON-payload (die ook de weergavenaam van de afzender bevat,
          // zie het architectuur-commentaar bovenaan het bestand).
          let decrypted = '';
          try {
            decrypted = event.content ? await decryptContent(channelKeyRef.current, event.content) : '';
          } catch {
            // Verkeerde/nog niet beschikbare sleutel, of event van vóór
            // deze versleuteling — negeren i.p.v. laten crashen.
            return;
          }

          const isSelf = Boolean(identityRef.current && event.pubkey === identityRef.current.pubkey);
          // Niet elke relay respecteert de NIP-01-richtlijn om ephemeral
          // events (kind 20000-29999) niet te bewaren; sommige relays sturen
          // ze bij een nieuwe subscriptie toch als "geschiedenis" terug. We
          // tonen een systeembericht daarom alleen als het event vers is
          // (< 60s oud) — de bijbehorende state (peerNames/docs/kanaalnaam)
          // werkt wél altijd bij, ook met oudere events.
          const isRecent = Math.abs(Math.floor(Date.now() / 1000) - event.created_at) < 60;

          function addSystemEntry(text) {
            if (isSelf || !isRecent) return;
            setEntries((prev) =>
              [...prev, { type: 'system', id: event.id, created_at: event.created_at, text }].sort((a, b) => entryTime(a) - entryTime(b))
            );
          }

          switch (event.kind) {
            case CHAT_KIND: {
              setEntries((prev) => {
                if (prev.some((e) => e.id === event.id)) return prev;
                return [...prev, { type: 'chat', id: event.id, event: { ...event, content: decrypted } }].sort(
                  (a, b) => entryTime(a) - entryTime(b)
                );
              });
              break;
            }
            case DOC_CREATED_KIND:
            case DOC_OPENED_KIND: {
              // Dit zijn geen tijdelijke presence-meldingen maar blijvende,
              // klikbare log-regels — ook je eigen acties blijven zichtbaar
              // (handig als geheugensteun om later terug te klikken), dus
              // géén isSelf/isRecent-filtering zoals bij de ephemeral events.
              let name, docId, docName;
              try {
                ({ name, docId, docName } = JSON.parse(decrypted));
              } catch {
                break;
              }
              if (!docId) break;
              const action = event.kind === DOC_CREATED_KIND ? 'created' : 'opened';
              setEntries((prev) => {
                if (prev.some((e) => e.id === event.id)) return prev;
                return [
                  ...prev,
                  { type: 'doclink', id: event.id, created_at: event.created_at, action, docId, docName, authorName: name ?? 'Iemand' },
                ].sort((a, b) => entryTime(a) - entryTime(b));
              });
              break;
            }
            case DOC_RENAMED_KIND: {
              let name, docId, oldName, newName;
              try {
                ({ name, docId, oldName, newName } = JSON.parse(decrypted));
              } catch {
                break;
              }
              if (!docId || !newName) break;
              setEntries((prev) => {
                if (prev.some((e) => e.id === event.id)) return prev;
                return [
                  ...prev,
                  {
                    type: 'doclink',
                    id: event.id,
                    created_at: event.created_at,
                    action: 'renamed',
                    docId,
                    docName: newName,
                    oldName,
                    authorName: name ?? 'Iemand',
                  },
                ].sort((a, b) => entryTime(a) - entryTime(b));
              });
              break;
            }
            case PRESENCE_JOIN_KIND: {
              let name;
              try {
                ({ name } = JSON.parse(decrypted));
              } catch {
                break;
              }
              if (!name) break;
              setPeerNames((prev) => ({ ...prev, [event.pubkey]: name }));
              addSystemEntry(`${name} is de chat binnengekomen`);
              break;
            }
            case PRESENCE_RENAME_KIND: {
              let name, oldname;
              try {
                ({ name, oldname } = JSON.parse(decrypted));
              } catch {
                break;
              }
              if (!name) break;
              setPeerNames((prev) => ({ ...prev, [event.pubkey]: name }));
              addSystemEntry(`${oldname ?? 'Iemand'} heet nu ${name}`);
              break;
            }
            case CALL_STARTED_KIND:
            case CALL_OPENED_KIND: {
              // Zelfde opzet als DOC_CREATED_KIND/DOC_OPENED_KIND: blijvend
              // bewaard, klikbare link, ook je eigen acties blijven zichtbaar.
              let name, callId, callName;
              try {
                ({ name, callId, callName } = JSON.parse(decrypted));
              } catch {
                break;
              }
              if (!callId) break;
              const action = event.kind === CALL_STARTED_KIND ? 'started' : 'opened';
              setEntries((prev) => {
                if (prev.some((e) => e.id === event.id)) return prev;
                return [
                  ...prev,
                  { type: 'calllink', id: event.id, created_at: event.created_at, action, callId, callName, authorName: name ?? 'Iemand' },
                ].sort((a, b) => entryTime(a) - entryTime(b));
              });
              break;
            }
            case CALL_RENAMED_KIND: {
              let name, callId, oldName, newName;
              try {
                ({ name, callId, oldName, newName } = JSON.parse(decrypted));
              } catch {
                break;
              }
              if (!callId || !newName) break;
              setEntries((prev) => {
                if (prev.some((e) => e.id === event.id)) return prev;
                return [
                  ...prev,
                  {
                    type: 'calllink',
                    id: event.id,
                    created_at: event.created_at,
                    action: 'renamed',
                    callId,
                    callName: newName,
                    oldName,
                    authorName: name ?? 'Iemand',
                  },
                ].sort((a, b) => entryTime(a) - entryTime(b));
              });
              break;
            }
            case DOC_DELETED_KIND: {
              let name, docId, docName;
              try {
                ({ name, docId, docName } = JSON.parse(decrypted));
              } catch {
                break;
              }
              if (!docId) break;
              setDocs((prev) => prev.filter((d) => d.id !== docId));
              setActiveItem((prev) => (prev?.type === 'doc' && prev.id === docId ? null : prev));
              setEntries((prev) => {
                if (prev.some((e) => e.id === event.id)) return prev;
                return [
                  ...prev,
                  {
                    type: 'system',
                    id: event.id,
                    created_at: event.created_at,
                    text: `${name ?? 'Iemand'} heeft "${docName ?? 'een document'}" verwijderd`,
                  },
                ].sort((a, b) => entryTime(a) - entryTime(b));
              });
              break;
            }
            case CALL_DELETED_KIND: {
              let name, callId, callName;
              try {
                ({ name, callId, callName } = JSON.parse(decrypted));
              } catch {
                break;
              }
              if (!callId) break;
              setCalls((prev) => prev.filter((c) => c.id !== callId));
              setActiveItem((prev) => (prev?.type === 'call' && prev.id === callId ? null : prev));
              setEntries((prev) => {
                if (prev.some((e) => e.id === event.id)) return prev;
                return [
                  ...prev,
                  {
                    type: 'system',
                    id: event.id,
                    created_at: event.created_at,
                    text: `${name ?? 'Iemand'} heeft video-oproep "${callName ?? 'een video-oproep'}" verwijderd`,
                  },
                ].sort((a, b) => entryTime(a) - entryTime(b));
              });
              break;
            }
            case DOCLIST_KIND: {
              // Freshness-guard: zonder deze check kan een ouder event (bv.
              // het oorspronkelijke "aangemaakt"-event) via een tragere
              // relay na een net doorgevoerde hernoeming binnenkomen en die
              // stilletjes terugdraaien.
              if (event.created_at < docsAtRef.current) break;
              try {
                const remoteDocs = JSON.parse(decrypted);
                if (Array.isArray(remoteDocs) && remoteDocs.length) {
                  docsAtRef.current = event.created_at;
                  setDocs((prev) => mergeDocs(prev, remoteDocs));
                }
              } catch {
                /* corrupte payload negeren */
              }
              break;
            }
            case CALLLIST_KIND: {
              if (event.created_at < callsAtRef.current) break;
              try {
                const remoteCalls = JSON.parse(decrypted);
                if (Array.isArray(remoteCalls) && remoteCalls.length) {
                  callsAtRef.current = event.created_at;
                  setCalls((prev) => mergeDocs(prev, remoteCalls));
                }
              } catch {
                /* corrupte payload negeren */
              }
              break;
            }
            case CHANNEL_META_KIND: {
              // NIP-33: pas alleen toe als dit event niet ouder is dan wat we
              // al hebben verwerkt.
              if (event.created_at < channelMetaAtRef.current) break;
              channelMetaAtRef.current = event.created_at;
              try {
                const { name, authorName } = JSON.parse(decrypted);
                if (name) {
                  setSavedChannels((prev) => {
                    const next = prev.some((c) => c.id === channelId)
                      ? prev.map((c) => (c.id === channelId ? { ...c, name } : c))
                      : [
                          {
                            id: channelId,
                            name,
                            url: `${window.location.origin}${window.location.pathname}#${channelId}`,
                            createdAt: Date.now(),
                          },
                          ...prev,
                        ];
                    persistSavedChannels(next);
                    return next;
                  });
                  addSystemEntry(`${authorName ?? 'Iemand'} heeft het kanaal hernoemd naar "${name}"`);
                }
              } catch {
                /* corrupte payload negeren */
              }
              break;
            }
            default:
              break;
          }
        },
      }
    );
    return () => sub.close();
  }, [pool, chatTag, channelId, identity, channelKey]);

  // Kondig één keer per sessie/kanaal aan dat je de chat binnenkomt, zodra
  // je identiteit bekend is. De joinedRef-guard voorkomt een dubbele
  // aankondiging door React 18 StrictMode's dubbele effect-uitvoering in
  // development.
  useEffect(() => {
    if (!pool || !identity || !channelKey || joinedRef.current) return;
    joinedRef.current = true;
    publishEvent(PRESENCE_JOIN_KIND, [['t', chatTag]], JSON.stringify({ name: displayNameRef.current }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, identity, chatTag, channelKey]);

  useEffect(() => {
    persistLocalList(`wsdocs:${channelId}`, docs);
  }, [channelId, docs]);

  useEffect(() => {
    persistLocalList(`wscalls:${channelId}`, calls);
  }, [channelId, calls]);

  async function sendMessage(text) {
    const trimmed = text.trim();
    if (!trimmed || !identity) return;
    const signed = await publishEvent(CHAT_KIND, [['t', chatTag]], trimmed);
    if (signed) {
      seenRef.current.add(signed.id);
      // signed.content is de versleutelde ciphertext die daadwerkelijk de
      // deur uit ging; voor de eigen (optimistische) weergave tonen we
      // gewoon de leesbare tekst die we al hadden, i.p.v. 'm eerst weer te
      // moeten ontsleutelen.
      const displayEvent = { ...signed, content: trimmed };
      setEntries((prev) =>
        prev.some((e) => e.id === signed.id)
          ? prev
          : [...prev, { type: 'chat', id: signed.id, event: displayEvent }].sort((a, b) => entryTime(a) - entryTime(b))
      );
    }
  }

  function renameDisplayName(newName) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === displayName) return;
    const oldName = displayName;
    setDisplayNameLocal(trimmed);
    publishEvent(PRESENCE_RENAME_KIND, [['t', chatTag]], JSON.stringify({ name: trimmed, oldname: oldName }));
  }

  function renameChannel(name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    channelMetaAtRef.current = Math.floor(Date.now() / 1000);
    setSavedChannels((prev) => {
      const next = prev.map((c) => (c.id === channelId ? { ...c, name: trimmed } : c));
      persistSavedChannels(next);
      return next;
    });
    publishEvent(
      CHANNEL_META_KIND,
      [['t', chatTag], ['d', channelMetaDTag]],
      JSON.stringify({ name: trimmed, authorName: displayName })
    );
  }

  function createNewChannel() {
    window.location.hash = generateChannelId();
    setMenuOpen(false);
  }

  function goToChannel(id) {
    window.location.hash = id;
    setMenuOpen(false);
  }

  // Puur lokaal (localStorage) — haalt een kanaal uit je eigen bladwijzer-
  // lijst, verandert niets aan het kanaal zelf of voor andere deelnemers.
  // Bezoek je het later via een link/URL opnieuw, dan verschijnt het
  // vanzelf weer (zie het 'kanaal bezocht'-effect hierboven).
  function removeSavedChannel(id) {
    setSavedChannels((prev) => {
      const next = prev.filter((c) => c.id !== id);
      persistSavedChannels(next);
      return next;
    });
  }

  // Net als bij een nieuw kanaal: geen naam-prompt, gewoon een korte
  // willekeurige standaardnaam die je daarna kunt hernoemen (zelfde inline-
  // bewerk-logica als de kanaalnaam).
  function createDocument() {
    const id = generateChannelId().slice(0, 8);
    const name = `Document ${id.slice(0, 6)}`;
    const nextDocs = [...docs, { id, name }];
    docsAtRef.current = Math.floor(Date.now() / 1000);
    setDocs(nextDocs);
    setActiveItem({ type: 'doc', id });
    setMobileView('desktop'); // op mobiel meteen naar de werkruimte, anders zie je 'm niet
    publishEvent(DOCLIST_KIND, [['t', chatTag], ['d', docsDTag]], JSON.stringify(nextDocs));
    publishEvent(DOC_CREATED_KIND, [['t', chatTag]], JSON.stringify({ name: displayName, docId: id, docName: name }));
  }

  function renameDocument(docId, newName) {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const oldDoc = docs.find((d) => d.id === docId);
    if (!oldDoc || oldDoc.name === trimmed) return;
    const next = docs.map((d) => (d.id === docId ? { ...d, name: trimmed } : d));
    docsAtRef.current = Math.floor(Date.now() / 1000);
    setDocs(next);
    publishEvent(DOCLIST_KIND, [['t', chatTag], ['d', docsDTag]], JSON.stringify(next));
    publishEvent(
      DOC_RENAMED_KIND,
      [['t', chatTag]],
      JSON.stringify({ name: displayName, docId, oldName: oldDoc.name, newName: trimmed })
    );
  }

  // Document openen (vanaf een bureaublad-icoon of een link in de chat):
  // navigeert erheen én publiceert een "geopend"-event, zodat iedereen een
  // klikbare "X heeft Y geopend"-regel in de chat krijgt.
  function openDocument(docId, docName) {
    // Dit document is al de actieve view (bv. dubbelklik, of herhaald op
    // dezelfde chatlink klikken): geen nieuw "geopend"-event, dat zou alleen
    // onnodig relay-verkeer (en rate-limit-risico) opleveren voor iets dat
    // al zichtbaar is.
    setMobileView('desktop'); // op mobiel meteen naar de werkruimte, anders zie je 'm niet
    if (activeItem?.type === 'doc' && activeItem.id === docId) return;
    setActiveItem({ type: 'doc', id: docId });
    // Zelfherstellend: als dit document lokaal nog niet bekend is (bv. de
    // documentenlijst-sync was nog niet binnen), toch meteen openbaar
    // maken zodat het icoon/de editor direct werkt.
    setDocs((prev) => (prev.some((d) => d.id === docId) ? prev : [...prev, { id: docId, name: docName || 'Document' }]));
    publishEvent(DOC_OPENED_KIND, [['t', chatTag]], JSON.stringify({ name: displayName, docId, docName }));
  }

  // Video-oproep aanmaken: net als een document krijgt de oproep een eigen
  // id (en dus een eigen, stabiele Jitsi-kamer die je later via hetzelfde
  // icoon of dezelfde chatlink weer kunt binnengaan) en een korte
  // willekeurige naam.
  function createCall() {
    const id = generateChannelId().slice(0, 8);
    const name = `Video-oproep ${id.slice(0, 6)}`;
    const nextCalls = [...calls, { id, name }];
    callsAtRef.current = Math.floor(Date.now() / 1000);
    setCalls(nextCalls);
    if (activeItem?.type !== 'call') preCallItemRef.current = activeItem;
    setActiveItem({ type: 'call', id });
    // Op mobiel naar de werkruimte: de video zelf verschijnt weliswaar
    // sowieso als losstaande overlay (zie DockableVideoCall), maar de
    // dock-/sluitknop ervoor zit in WorkspaceHeader — die is onbereikbaar
    // als WorkspacePanel op mobiel nog `hidden` staat (je op Chat zit).
    setMobileView('desktop');
    publishEvent(CALLLIST_KIND, [['t', chatTag], ['d', callsDTag]], JSON.stringify(nextCalls));
    publishEvent(CALL_STARTED_KIND, [['t', chatTag]], JSON.stringify({ name: displayName, callId: id, callName: name }));
  }

  // Een bestaande video-oproep (weer) binnengaan — vanaf een bureaublad-
  // icoon of een link in de chat. Net als bij documenten: publiceert een
  // "geopend"-event, zodat iedereen een klikbare "X heeft Y geopend"-regel
  // in de chat krijgt.
  function openCall(callId, callName) {
    // Op mobiel naar de werkruimte — zie createCall hierboven voor het
    // waarom (dock-/sluitknop zit in WorkspaceHeader, niet in de overlay
    // zelf). Ook bij een al-actieve of al-gedockte call: je klikte 'm net
    // vanuit de chat, dus je wil de bedieningsknoppen meteen kunnen zien.
    setMobileView('desktop');
    // Deze call is al de actieve fullscreen-view: geen nieuw event nodig.
    if (activeItem?.type === 'call' && activeItem.id === callId) return;
    // Is deze call al gedockt (draait dus al op de achtergrond)? Dan gewoon
    // weer fullscreen tonen — geen nieuwe iframe, geen extra "geopend"-
    // event/chat-spam voor iets dat al liep.
    if (dockedCall?.id === callId) {
      if (activeItem?.type !== 'call') preCallItemRef.current = activeItem;
      setActiveItem({ type: 'call', id: callId });
      setDockedCall(null);
      return;
    }
    if (activeItem?.type !== 'call') preCallItemRef.current = activeItem;
    setActiveItem({ type: 'call', id: callId });
    setDockedCall(null); // een eventuele andere gedockte call laten varen
    setCalls((prev) => (prev.some((c) => c.id === callId) ? prev : [...prev, { id: callId, name: callName || 'Video-oproep' }]));
    publishEvent(CALL_OPENED_KIND, [['t', chatTag]], JSON.stringify({ name: displayName, callId, callName }));
  }

  // Minimaliseren: de call blijft (audio/verbinding) op de achtergrond
  // draaien als bolletje rechtsonder, terwijl je elders in de workspace
  // verder kunt (bv. een document bewerken).
  function dockCall() {
    if (activeItem?.type !== 'call') return;
    const call = calls.find((c) => c.id === activeItem.id);
    setDockedCall({ id: activeItem.id, name: call?.name ?? 'Video-oproep' });
    setActiveItem(preCallItemRef.current);
    preCallItemRef.current = null;
  }

  function undockCall() {
    if (!dockedCall) return;
    if (activeItem?.type !== 'call') preCallItemRef.current = activeItem;
    setActiveItem({ type: 'call', id: dockedCall.id });
    setDockedCall(null);
  }

  // Écht de call verlaten (i.p.v. minimaliseren): iframe verdwijnt volledig.
  function endCall() {
    setDockedCall(null);
    preCallItemRef.current = null;
    setActiveItem((prev) => (prev?.type === 'call' ? null : prev));
  }

  function renameCall(callId, newName) {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const oldCall = calls.find((c) => c.id === callId);
    if (!oldCall || oldCall.name === trimmed) return;
    const next = calls.map((c) => (c.id === callId ? { ...c, name: trimmed } : c));
    callsAtRef.current = Math.floor(Date.now() / 1000);
    setCalls(next);
    publishEvent(CALLLIST_KIND, [['t', chatTag], ['d', callsDTag]], JSON.stringify(next));
    publishEvent(
      CALL_RENAMED_KIND,
      [['t', chatTag]],
      JSON.stringify({ name: displayName, callId, oldName: oldCall.name, newName: trimmed })
    );
  }

  function deleteDocument(docId) {
    const doc = docs.find((d) => d.id === docId);
    const next = docs.filter((d) => d.id !== docId);
    docsAtRef.current = Math.floor(Date.now() / 1000);
    setDocs(next);
    setActiveItem((prev) => (prev?.type === 'doc' && prev.id === docId ? null : prev));
    publishEvent(DOCLIST_KIND, [['t', chatTag], ['d', docsDTag]], JSON.stringify(next));
    publishEvent(DOC_DELETED_KIND, [['t', chatTag]], JSON.stringify({ name: displayName, docId, docName: doc?.name }));
  }

  function deleteCall(callId) {
    const call = calls.find((c) => c.id === callId);
    const next = calls.filter((c) => c.id !== callId);
    callsAtRef.current = Math.floor(Date.now() / 1000);
    setCalls(next);
    setActiveItem((prev) => (prev?.type === 'call' && prev.id === callId ? null : prev));
    publishEvent(CALLLIST_KIND, [['t', chatTag], ['d', callsDTag]], JSON.stringify(next));
    publishEvent(CALL_DELETED_KIND, [['t', chatTag]], JSON.stringify({ name: displayName, callId, callName: call?.name }));
  }

  function goToDesktop() {
    setActiveItem(null);
  }

  const currentChannel = savedChannels.find((c) => c.id === channelId);
  const channelName = currentChannel?.name ?? `Kanaal ${channelId.slice(0, 6)}`;
  // Eén keer berekend hier (i.p.v. dubbel in ChatPanel én WorkspaceHeader):
  // beide tonen op mobiel elk hun eigen kanalenmenu-knopje met dezelfde
  // badge, zie SavedChannelsOverlay hieronder voor het gedeelde menu zelf.
  const totalUnread = Object.values(notifications).reduce(
    (sum, n) => sum + n.message + n.doc + n.call + n.presence,
    0
  );

  return (
    // h-dvh (dynamic viewport height) i.p.v. h-screen (100vh): mobiele
    // browsers rekenen hun eigen, inklapbare adresbalk/chrome mee in 100vh,
    // waardoor de onderste tabbalk (MobileViewSwitcher) net buiten beeld
    // kon vallen. dvh past zich aan het daadwerkelijk zichtbare vlak aan.
    <div className="h-dvh w-screen overflow-hidden flex flex-col md:flex-row bg-slate-100">
      <ChatPanel
        channelId={channelId}
        identity={identity}
        entries={entries}
        peerNames={peerNames}
        onSend={sendMessage}
        onOpenDoc={openDocument}
        onOpenCall={openCall}
        displayName={displayName}
        onRenameDisplayName={renameDisplayName}
        channelName={channelName}
        onRenameChannel={renameChannel}
        onToggleMenu={() => setMenuOpen((v) => !v)}
        totalUnread={totalUnread}
        mobileView={mobileView}
      />
      <WorkspacePanel
        channelId={channelId}
        docs={docs}
        calls={calls}
        docSyncInstances={docSyncInstances}
        activeItem={activeItem}
        onOpenDoc={openDocument}
        onOpenCall={openCall}
        onCreateDoc={createDocument}
        onCreateCall={createCall}
        onRenameDoc={renameDocument}
        onRenameCall={renameCall}
        onDeleteDoc={deleteDocument}
        onDeleteCall={deleteCall}
        onGoToDesktop={goToDesktop}
        onDockCall={dockCall}
        onEndCall={endCall}
        identity={identity}
        displayName={displayName}
        mobileView={mobileView}
        onToggleMenu={() => setMenuOpen((v) => !v)}
        totalUnread={totalUnread}
      />
      <MobileViewSwitcher mobileView={mobileView} onChange={setMobileView} />
      <DockableVideoCall
        channelId={channelId}
        calls={calls}
        activeItem={activeItem}
        dockedCall={dockedCall}
        displayName={displayName}
        onUndock={undockCall}
        onEnd={endCall}
      />
      <SavedChannelsOverlay
        menuOpen={menuOpen}
        onCloseMenu={() => setMenuOpen(false)}
        savedChannels={savedChannels}
        notifications={notifications}
        channelId={channelId}
        onSelectChannel={goToChannel}
        onCreateChannel={createNewChannel}
        onRemoveChannel={removeSavedChannel}
        toasts={toasts}
        onDismissToast={dismissToast}
      />
    </div>
  );
}

// Tabbalk onderin, uitsluitend zichtbaar op smalle schermen (md:hidden) —
// op zo'n scherm is er geen ruimte voor chat én werkruimte naast elkaar,
// dus toont ChatPanel/WorkspacePanel er maar één tegelijk (fullscreen),
// omgeschakeld door hierop te tikken. Op md+ altijd verborgen: daar staan
// beide panelen toch al gewoon naast elkaar.
function MobileViewSwitcher({ mobileView, onChange }) {
  return (
    <div className="md:hidden shrink-0 flex border-t border-slate-200 bg-white">
      <button
        onClick={() => onChange('chat')}
        className={`flex-1 py-2 flex flex-col items-center gap-0.5 text-xs font-medium ${
          mobileView === 'chat' ? 'text-indigo-600' : 'text-slate-400'
        }`}
      >
        <span className="text-lg leading-none">💬</span>
        Chat
      </button>
      <button
        onClick={() => onChange('desktop')}
        className={`flex-1 py-2 flex flex-col items-center gap-0.5 text-xs font-medium ${
          mobileView === 'desktop' ? 'text-indigo-600' : 'text-slate-400'
        }`}
      >
        <span className="text-lg leading-none">🖥️</span>
        Werkruimte
      </button>
    </div>
  );
}

// Houdt de Jitsi-iframe op één stabiele plek in de React-boom (dus zonder
// remount) en positioneert 'm met CSS: precies over het werkscherm-vlak
// wanneer fullscreen, of als klein bolletje rechtsonder wanneer gedockt.
// Zo blijft de verbinding (en het geluid) intact tijdens het dokken.
function DockableVideoCall({ channelId, calls, activeItem, dockedCall, displayName, onUndock, onEnd }) {
  const isFullscreen = activeItem?.type === 'call';
  const liveCallId = isFullscreen ? activeItem.id : dockedCall?.id;
  if (!liveCallId) return null;

  const liveCallName = isFullscreen ? calls.find((c) => c.id === liveCallId)?.name : dockedCall?.name;
  const roomId = `${channelId}-${liveCallId}`;

  // Let op: de wrapper-structuur (buitenste div > binnenste div > VideoCall)
  // blijft in beide standen exact hetzelfde — alleen classNames/style
  // veranderen. Zou je hier conditioneel een extra <div> toevoegen/weglaten,
  // dan ziet React dat als een andere boomvorm en remount 'm de iframe
  // (verbinding weg). Bij gedockt renderen we de iframe op een groter
  // virtueel canvas (260×260) en tonen via overflow-hidden alleen het
  // midden daarvan — zo blijft de onderste knoppenbalk van Jitsi (die anders
  // in het bolletje zou piepen) buiten beeld.
  return (
    <div
      className={
        isFullscreen
          ? 'fixed top-14 right-0 w-full md:w-1/2 h-[calc(100%-3.5rem)] z-30 bg-black'
          : 'fixed bottom-4 right-4 w-16 h-16 rounded-full overflow-hidden shadow-lg z-40'
      }
    >
      <div
        className="absolute"
        style={
          isFullscreen
            ? { inset: 0 }
            : { width: 260, height: 260, left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }
        }
      >
        <VideoCall key={roomId} roomId={roomId} displayName={displayName} />
      </div>
      {!isFullscreen && (
        <>
          <button
            onClick={onUndock}
            className="absolute inset-0 flex items-center justify-center bg-black/50 hover:bg-black/60 text-white text-2xl"
            title={`Terug naar video-oproep "${liveCallName ?? ''}"`}
          >
            📹
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEnd();
            }}
            className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center text-white shadow"
            title="Oproep verlaten"
          >
            <span className="text-[9px] leading-none">✕</span>
          </button>
        </>
      )}
    </div>
  );
}

// Kanalenmenu + toast-popups + verwijder-bevestiging voor opgeslagen
// kanalen — één keer gerenderd op Dashboard-niveau (niet genest in
// ChatPanel), zodat het ook werkt als ChatPanel zelf op mobiel net
// `hidden` is (je op de Werkruimte-tab zit). Zowel ChatPanel als
// WorkspaceHeader hebben elk hun eigen hamburger-triggerknopje dat
// dezelfde gedeelde `menuOpen`-state in Dashboard omschakelt — zie
// data-savedchannels-trigger/-panel hieronder voor hoe buiten-klikken dat
// correct sluit ongeacht welke knop 'm opende.
function SavedChannelsOverlay({
  menuOpen,
  onCloseMenu,
  savedChannels,
  notifications,
  channelId,
  onSelectChannel,
  onCreateChannel,
  onRemoveChannel,
  toasts,
  onDismissToast,
}) {
  const [pendingDeleteChannel, setPendingDeleteChannel] = useState(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e) {
      if (!e.target.closest('[data-savedchannels-trigger], [data-savedchannels-panel]')) onCloseMenu();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen, onCloseMenu]);

  return (
    <>
      {menuOpen && (
        // Op mobiel (< md) fullscreen met een expliciete sluitknop — een
        // kleine, ergens-anders-op-tikken-om-te-sluiten dropdown werkt niet
        // lekker op een smal scherm. Op md+ een klein anker-paneeltje
        // linksboven (vaste positie i.p.v. relatief aan een specifieke
        // knop, want er zijn er nu twee — zie hierboven).
        <div
          data-savedchannels-panel
          className="fixed inset-0 z-30 flex flex-col bg-white md:inset-auto md:left-4 md:top-16 md:z-20 md:w-72 md:max-h-80 md:rounded-lg md:border md:border-slate-200 md:shadow-lg"
        >
          <div className="px-3 py-2 flex items-center justify-between border-b border-slate-100 shrink-0">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
              Opgeslagen kanalen
            </span>
            <button
              onClick={onCloseMenu}
              className="text-slate-400 hover:text-slate-600 text-sm leading-none p-1 -m-1"
              title="Sluiten"
            >
              ✕
            </button>
          </div>
          <div className="overflow-y-auto flex-1 md:flex-none">
            {savedChannels.length === 0 && (
              <div className="p-3 text-xs text-slate-400">Nog geen opgeslagen kanalen.</div>
            )}
            {savedChannels.map((c) => {
              const n = notifications[c.id];
              const unread = n ? n.message + n.doc + n.call + n.presence : 0;
              const parts = [];
              if (n?.message) parts.push(`${n.message} bericht${n.message > 1 ? 'en' : ''}`);
              if (n?.doc) parts.push(`${n.doc} document${n.doc > 1 ? 'actie' : ''}`);
              if (n?.call) parts.push(`${n.call} video-oproep${n.call > 1 ? 'en' : ''}`);
              if (n?.presence) parts.push(`${n.presence}x iemand online gekomen`);
              return (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectChannel(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') onSelectChannel(c.id);
                  }}
                  className={`group w-full text-left px-3 py-2 text-xs hover:bg-slate-50 border-b border-slate-100 last:border-0 flex items-center justify-between gap-2 cursor-pointer ${
                    c.id === channelId ? 'bg-indigo-50 font-medium' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div className="truncate">{c.name}</div>
                    <div className="truncate text-[10px] text-slate-400">{c.id}</div>
                  </div>
                  <div className="shrink-0 flex items-center gap-1.5">
                    {unread > 0 && (
                      <span
                        className="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold"
                        title={parts.join(', ')}
                      >
                        {unread > 9 ? '9+' : unread}
                      </span>
                    )}
                    {/* Puur een lokale bladwijzer verwijderen — de chat/
                        documenten van het kanaal zelf blijven gewoon
                        bestaan. Bezoek je het later opnieuw via een link,
                        dan verschijnt het vanzelf weer in dit lijstje.
                        Altijd zichtbaar op mobiel (geen hover op touch),
                        pas bij hover op md+. */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingDeleteChannel({ id: c.id, name: c.name });
                      }}
                      className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-slate-300 hover:text-red-500 leading-none transition-opacity"
                      title={`"${c.name}" uit opgeslagen kanalen verwijderen`}
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              );
            })}
            <button
              onClick={onCreateChannel}
              className="w-full text-left px-3 py-2 text-xs text-indigo-600 hover:bg-indigo-50 flex items-center gap-1.5 border-t border-slate-100"
            >
              <span className="text-sm leading-none">＋</span>
              Nieuw kanaal aanmaken
            </button>
          </div>
        </div>
      )}

      {/* Toast-popups voor activiteit in niet-actieve opgeslagen kanalen —
          bewust dezelfde visuele taal als het menu hierboven. Verborgen
          zolang dat menu open staat om overlap te voorkomen; de badges
          daarin zijn dan toch al zichtbaar. */}
      {!menuOpen && toasts.length > 0 && (
        <div className="fixed left-4 top-16 w-72 max-w-[calc(100vw-2rem)] flex flex-col gap-2 z-20">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="button"
              tabIndex={0}
              onClick={() => {
                onSelectChannel(t.channelId);
                onDismissToast(t.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  onSelectChannel(t.channelId);
                  onDismissToast(t.id);
                }
              }}
              className="bg-white border border-slate-200 rounded-lg shadow-lg cursor-pointer text-left px-3 py-2 hover:bg-slate-50 animate-[fadeIn_0.15s_ease-out]"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide truncate">
                  {t.channelName}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDismissToast(t.id);
                  }}
                  className="shrink-0 text-slate-300 hover:text-slate-500 text-xs leading-none"
                  title="Sluiten"
                >
                  ✕
                </button>
              </div>
              <div className="text-xs text-slate-700 mt-0.5">
                {t.authorName && !t.line.startsWith(t.authorName) ? (
                  <>
                    <span className="font-medium">{t.authorName}</span> {t.line}
                  </>
                ) : (
                  t.line
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {pendingDeleteChannel && (
        <ConfirmDeleteModal
          label={pendingDeleteChannel.name}
          kind="channel"
          onConfirm={() => {
            onRemoveChannel(pendingDeleteChannel.id);
            setPendingDeleteChannel(null);
          }}
          onCancel={() => setPendingDeleteChannel(null)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Linkerpaneel: Nostr-chat                                            */
/* ------------------------------------------------------------------ */

// Chat- en systeem-entries hebben allebei een tijdstip, maar op een andere
// plek in het object; deze helper zorgt dat sort() nooit op de verkeerde
// (of ontbrekende) property struikelt.
function entryTime(entry) {
  return entry.type === 'chat' ? entry.event.created_at : entry.created_at;
}

function ChatPanel({
  channelId,
  identity,
  entries,
  peerNames,
  onSend,
  onOpenDoc,
  onOpenCall,
  displayName,
  onRenameDisplayName,
  channelName,
  onRenameChannel,
  onToggleMenu,
  totalUnread,
  mobileView,
}) {
  const [input, setInput] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(channelName);
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState(displayName);
  const bottomRef = useRef(null);

  useEffect(() => setNameDraft(channelName), [channelName]);
  useEffect(() => setDisplayNameDraft(displayName), [displayName]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [entries.length]);

  function handleSend() {
    if (!input.trim()) return;
    onSend(input);
    setInput('');
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function commitRename() {
    setEditingName(false);
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== channelName) onRenameChannel(trimmed);
    else setNameDraft(channelName);
  }

  function commitDisplayNameChange() {
    setEditingDisplayName(false);
    const trimmed = displayNameDraft.trim();
    if (trimmed && trimmed !== displayName) onRenameDisplayName(trimmed);
    else setDisplayNameDraft(displayName);
  }

  return (
    <div
      className={`${mobileView === 'chat' ? 'flex' : 'hidden'} md:flex flex-col flex-1 min-h-0 w-full md:w-1/2 md:flex-none md:h-full bg-white border-r border-slate-200`}
    >
      {/* Kanaalheader — 3 zones (hamburger / titel / balancerende spacer)
          zodat de titel op mobiel exact gecentreerd staat; op md+ schuift
          de titel gewoon weer naar links (justify-start), zoals voorheen. */}
      <div className="h-14 flex items-center gap-2 px-4 border-b border-slate-200 shrink-0">
        {/* Zelfgebouwd i.p.v. het '☰'-teken: emoji-iconen (🖥️/📄/📹 in
            WorkspaceHeader hiernaast) en tekst-glyphs zoals ☰ hebben een net
            andere positionering binnen hun tekenbox, wat bij dezelfde
            text-lg/leading-none-opmaak toch een merkbaar scheve uitlijning
            gaf. Deze vaste 18×18px-doos lijnt wél exact uit met het
            Bureaublad-icoon ernaast. Zelfde knop (met data-attribuut voor
            buiten-klik-detectie) staat ook, mobiel-only, in WorkspaceHeader
            — zie SavedChannelsOverlay voor het gedeelde menu dat beide
            knoppen openen. */}
        <button
          data-savedchannels-trigger
          onClick={onToggleMenu}
          className="relative flex items-center justify-center shrink-0 w-[18px] h-[18px] rounded hover:bg-slate-100"
          title={
            totalUnread > 0
              ? `Opgeslagen werkruimtes (${totalUnread} nieuw in andere kanalen)`
              : 'Opgeslagen werkruimtes'
          }
        >
          <span className="flex flex-col items-center justify-center gap-[3px]">
            <span className="block w-[14px] h-[2px] rounded-full bg-slate-700" />
            <span className="block w-[14px] h-[2px] rounded-full bg-slate-700" />
            <span className="block w-[14px] h-[2px] rounded-full bg-slate-700" />
          </span>
          {totalUnread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />
          )}
        </button>
        <div className="flex-1 min-w-0 flex items-center justify-center md:justify-start gap-1.5">
          <span className="text-base leading-none shrink-0">💬</span>
          {editingName ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  setNameDraft(channelName);
                  setEditingName(false);
                }
              }}
              className="text-sm font-semibold border-b border-indigo-400 outline-none px-1 min-w-0 bg-transparent"
            />
          ) : (
            <button
              onClick={() => setEditingName(true)}
              className="text-sm font-semibold truncate hover:underline text-center md:text-left"
              title="Klik om dit kanaal een eigen naam te geven"
            >
              {channelName}
            </button>
          )}
        </div>
        {/* Balanceert de hamburger-knop links, puur voor centrering op
            mobiel — geen functie, niet interactief. */}
        <div className="w-[18px] shrink-0" aria-hidden="true" />
      </div>

      {/* Berichtenlog */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
        {entries.length === 0 && (
          <div className="text-xs text-slate-400 text-center pt-6">
            Nog geen berichten in dit kanaal. Stuur het eerste bericht!
          </div>
        )}
        {entries.map((entry) => {
          if (entry.type === 'system') {
            return (
              <div key={entry.id} className="text-center text-[11px] text-slate-400 italic py-1">
                {entry.text}
              </div>
            );
          }
          if (entry.type === 'doclink') {
            return (
              <div key={entry.id} className="flex justify-center py-0.5">
                <button
                  onClick={() => onOpenDoc(entry.docId, entry.docName)}
                  className="text-xs text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-full px-3 py-1 flex items-center gap-1.5 max-w-full"
                  title={`"${entry.docName}" openen`}
                >
                  <span>📄</span>
                  <span className="truncate">
                    <span className="font-medium">{entry.authorName}</span>{' '}
                    {entry.action === 'renamed' ? (
                      <>
                        heeft "{entry.oldName}" hernoemd naar "{entry.docName}"
                      </>
                    ) : (
                      <>
                        heeft "{entry.docName}" {entry.action === 'created' ? 'aangemaakt' : 'geopend'}
                      </>
                    )}
                  </span>
                </button>
              </div>
            );
          }
          if (entry.type === 'calllink') {
            return (
              <div key={entry.id} className="flex justify-center py-0.5">
                <button
                  onClick={() => onOpenCall(entry.callId, entry.callName)}
                  className="text-xs text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-full px-3 py-1 flex items-center gap-1.5 max-w-full"
                  title={`Video-oproep "${entry.callName}" openen`}
                >
                  <span>📹</span>
                  <span className="truncate">
                    <span className="font-medium">{entry.authorName}</span>{' '}
                    {entry.action === 'renamed' ? (
                      <>
                        heeft video-oproep "{entry.oldName}" hernoemd naar "{entry.callName}"
                      </>
                    ) : (
                      <>
                        heeft video-oproep "{entry.callName}" {entry.action === 'started' ? 'gestart' : 'geopend'}
                      </>
                    )}
                  </span>
                </button>
              </div>
            );
          }
          return (
            <MessageBubble
              key={entry.id}
              event={entry.event}
              authorLabel={peerNames[entry.event.pubkey]}
              isMe={Boolean(identity && entry.event.pubkey === identity.pubkey)}
            />
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Eigen weergavenaam */}
      <div className="px-4 py-1.5 border-t border-slate-100 flex items-center gap-1.5 text-xs text-slate-500 shrink-0">
        <span>👤 Chatten als</span>
        {editingDisplayName ? (
          <input
            autoFocus
            value={displayNameDraft}
            onChange={(e) => setDisplayNameDraft(e.target.value)}
            onBlur={commitDisplayNameChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                setDisplayNameDraft(displayName);
                setEditingDisplayName(false);
              }
            }}
            className="border-b border-indigo-400 outline-none px-1 bg-transparent font-medium text-slate-700"
          />
        ) : (
          <button
            onClick={() => setEditingDisplayName(true)}
            className="font-medium text-slate-700 hover:underline"
            title="Klik om je naam te wijzigen"
          >
            {displayName}
          </button>
        )}
      </div>

      {/* Invoerbalk */}
      <div className="border-t border-slate-200 p-3 flex gap-2 items-end shrink-0">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={identity ? 'Typ een bericht… (Enter = versturen, Shift+Enter = nieuwe regel)' : 'Identiteit laden…'}
          disabled={!identity}
          rows={1}
          className="flex-1 resize-none border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-400 max-h-32 overflow-y-auto"
        />
        <button
          onClick={handleSend}
          disabled={!identity || !input.trim()}
          className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-indigo-700 shrink-0"
        >
          Verstuur
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ event, authorLabel, isMe }) {
  const npubFallback = useMemo(() => {
    try {
      return `${nip19.npubEncode(event.pubkey).slice(0, 12)}…`;
    } catch {
      return event.pubkey.slice(0, 8);
    }
  }, [event.pubkey]);
  const author = authorLabel || npubFallback;

  const time = new Date(event.created_at * 1000).toLocaleTimeString('nl-NL', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${isMe ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-800'}`}>
        {!isMe && <div className="text-[10px] font-medium mb-0.5 opacity-60">{author}</div>}
        <div className="whitespace-pre-wrap break-words">{event.content}</div>
        <div className={`text-[10px] mt-1 text-right ${isMe ? 'text-indigo-100' : 'text-slate-400'}`}>{time}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Rechterpaneel: dynamische workspace                                 */
/* ------------------------------------------------------------------ */

function WorkspacePanel({
  channelId,
  docs,
  calls,
  docSyncInstances,
  activeItem,
  onOpenDoc,
  onOpenCall,
  onCreateDoc,
  onCreateCall,
  onRenameDoc,
  onRenameCall,
  onDeleteDoc,
  onDeleteCall,
  onGoToDesktop,
  onDockCall,
  onEndCall,
  identity,
  displayName,
  mobileView,
  onToggleMenu,
  totalUnread,
}) {
  const activeDoc = activeItem?.type === 'doc' ? docs.find((d) => d.id === activeItem.id) : null;
  const activeCall = activeItem?.type === 'call' ? calls.find((c) => c.id === activeItem.id) : null;
  const activeDocSync = activeDoc ? docSyncInstances.get(activeDoc.id) : null;
  const onDesktop = !activeDoc && !activeCall;

  return (
    <div
      className={`${mobileView === 'desktop' ? 'flex' : 'hidden'} md:flex flex-col flex-1 min-h-0 w-full md:w-1/2 md:flex-none md:h-full bg-white`}
    >
      <WorkspaceHeader
        onDesktop={onDesktop}
        icon={onDesktop ? '🖥️' : activeDoc ? '📄' : '📹'}
        title={onDesktop ? 'Bureaublad' : activeDoc ? activeDoc.name : activeCall.name}
        editable={Boolean(activeDoc || activeCall)}
        onRename={
          activeDoc
            ? (name) => onRenameDoc(activeDoc.id, name)
            : activeCall
              ? (name) => onRenameCall(activeCall.id, name)
              : undefined
        }
        onDock={activeCall ? onDockCall : undefined}
        onClose={activeCall ? onEndCall : onGoToDesktop}
        onToggleMenu={onToggleMenu}
        totalUnread={totalUnread}
      />

      <div className="flex-1 min-h-0 relative">
        {onDesktop && (
          <WorkspaceDesktop
            docs={docs}
            calls={calls}
            onOpenDoc={onOpenDoc}
            onOpenCall={onOpenCall}
            onCreateDoc={onCreateDoc}
            onCreateCall={onCreateCall}
            onDeleteDoc={onDeleteDoc}
            onDeleteCall={onDeleteCall}
          />
        )}
        {activeDoc &&
          (activeDocSync ? (
            <BlockNoteEditorInner
              key={activeDoc.id}
              ydoc={activeDocSync.ydoc}
              provider={activeDocSync.provider}
              identity={identity}
              displayName={displayName}
              roomName={activeDoc.id}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-slate-400 text-sm">Document wordt geladen…</div>
          ))}
        {/* De video-oproep zelf wordt niet hier gerenderd: Dashboard toont
              'm als een losse, vast-gepositioneerde laag (zie DockableVideoCall)
             die precies dit vlak overlapt — zo blijft de iframe (en dus de
             verbinding/audio) bestaan als je later dockt en elders navigeert. */}
      </div>
    </div>
  );
}

// Header van het werkscherm — zelfde hoogte/opmaak als de chatheader.
// Toont "Bureaublad" op de startweergave, de (bewerkbare) documentnaam
// zodra een document open staat, of de video-oproepnaam tijdens een call.
// Een document/call heeft een ✕ rechtsboven om terug te gaan naar het
// bureaublad.
function WorkspaceHeader({ onDesktop, icon, title, editable, onRename, onDock, onClose, onToggleMenu, totalUnread }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title ?? '');

  useEffect(() => {
    setDraft(title ?? '');
    setEditing(false);
  }, [title]);

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (editable && trimmed && trimmed !== title) {
      onRename(trimmed);
    } else {
      setDraft(title ?? '');
    }
  }

  return (
    <div className="h-14 flex items-center gap-2 px-4 border-b border-slate-200 shrink-0">
      {/* Mobiel-only: dezelfde kanalenmenu-knop als in ChatPanel (zie
          uitleg daar). Op md+ verborgen — daar volstaat de ene knop in
          ChatPanel, want beide panelen staan toch al naast elkaar. Op
          desktop dus geen linkerzone hier, en blijft de titel via
          md:justify-start gewoon links staan. */}
      <button
        data-savedchannels-trigger
        onClick={onToggleMenu}
        className="relative md:hidden flex items-center justify-center shrink-0 w-[18px] h-[18px] rounded hover:bg-slate-100"
        title={
          totalUnread > 0
            ? `Opgeslagen werkruimtes (${totalUnread} nieuw in andere kanalen)`
            : 'Opgeslagen werkruimtes'
        }
      >
        <span className="flex flex-col items-center justify-center gap-[3px]">
          <span className="block w-[14px] h-[2px] rounded-full bg-slate-700" />
          <span className="block w-[14px] h-[2px] rounded-full bg-slate-700" />
          <span className="block w-[14px] h-[2px] rounded-full bg-slate-700" />
        </span>
        {totalUnread > 0 && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />}
      </button>
      <div className="flex-1 min-w-0 flex items-center justify-center md:justify-start gap-2">
        <span className="text-lg leading-none shrink-0">{icon}</span>
        {!editable ? (
          <span className="text-sm font-semibold text-slate-700 truncate" title={title}>
            {title}
          </span>
        ) : editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                setDraft(title ?? '');
                setEditing(false);
              }
            }}
            className="text-sm font-semibold border-b border-indigo-400 outline-none px-1 min-w-0 bg-transparent"
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="text-sm font-semibold truncate hover:underline text-center md:text-left"
            title={`${title} — klik om te hernoemen`}
          >
            {title}
          </button>
        )}
      </div>
      {!onDesktop ? (
        <div className="flex items-center gap-1 shrink-0">
          {onDock && (
            <button
              onClick={onDock}
              className="text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full w-7 h-7 flex items-center justify-center text-sm"
              title="Minimaliseren — de oproep blijft op de achtergrond doorlopen"
            >
              ─
            </button>
          )}
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full w-7 h-7 flex items-center justify-center text-sm"
            title="Sluiten"
          >
            ✕
          </button>
        </div>
      ) : (
        // Balanceert de mobiele hamburger-knop links, puur voor centrering
        // — op md+ neemt de (dan md:hidden) hamburger toch al geen ruimte
        // in, dus is deze spacer daar ook niet nodig.
        <div className="w-[18px] shrink-0 md:hidden" aria-hidden="true" />
      )}
    </div>
  );
}

// Het "bureaublad" van de workspace: elk document én elke video-oproep is
// een icoon, plus icons om een nieuw document/nieuwe video-oproep te
// starten (dat direct het bijbehorende Nostr-event de deur uit stuurt,
// zodat andere deelnemers het ook zien verschijnen) — allemaal launch-
// icons op één scherm, geen aparte tabjes.
function WorkspaceDesktop({ docs, calls, onOpenDoc, onOpenCall, onCreateDoc, onCreateCall, onDeleteDoc, onDeleteCall }) {
  const gridStyle = { gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))' };
  const hasItems = docs.length > 0 || calls.length > 0;
  // { type: 'doc' | 'call', id, name } van het item waarvoor net op het
  // prullenbakje is geklikt, of null als er niets ter bevestiging staat.
  const [pendingDelete, setPendingDelete] = useState(null);

  function confirmDelete() {
    if (pendingDelete.type === 'doc') onDeleteDoc(pendingDelete.id);
    else onDeleteCall(pendingDelete.id);
    setPendingDelete(null);
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* "Nieuw(e) ..."-iconen altijd vooraan, op hun eigen rij. */}
      <div className="grid gap-4" style={gridStyle}>
        <button
          onClick={onCreateDoc}
          className="flex flex-col items-center gap-1.5 p-2 rounded-lg hover:bg-slate-100 text-center"
          title="Nieuw document aanmaken"
        >
          <span className="text-4xl leading-none">📄</span>
          <span className="text-xs text-slate-500">Nieuw document</span>
        </button>
        <button
          onClick={onCreateCall}
          className="flex flex-col items-center gap-1.5 p-2 rounded-lg hover:bg-slate-100 text-center"
          title="Video-oproep starten"
        >
          <span className="text-4xl leading-none">📹</span>
          <span className="text-xs text-slate-500">Nieuwe video-oproep</span>
        </button>
      </div>

      {/* Bestaande documenten/video-oproepen op een eigen rij eronder. */}
      {hasItems && (
        <div className="grid gap-4 mt-6 pt-5 border-t border-slate-100" style={gridStyle}>
          {docs.map((doc) => (
            <DesktopIcon
              key={doc.id}
              icon="📄"
              label={doc.name}
              onOpen={() => onOpenDoc(doc.id, doc.name)}
              onRequestDelete={() => setPendingDelete({ type: 'doc', id: doc.id, name: doc.name })}
            />
          ))}
          {calls.map((call) => (
            <DesktopIcon
              key={call.id}
              icon="📹"
              label={call.name}
              onOpen={() => onOpenCall(call.id, call.name)}
              onRequestDelete={() => setPendingDelete({ type: 'call', id: call.id, name: call.name })}
            />
          ))}
        </div>
      )}

      {!hasItems && (
        <p className="text-xs text-slate-400 mt-5">
          Nog niets in dit kanaal — klik op "Nieuw document" of "Nieuwe video-oproep" om te beginnen.
        </p>
      )}

      {pendingDelete && (
        <ConfirmDeleteModal
          label={pendingDelete.name}
          kind={pendingDelete.type}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

// Eén icoon op het bureaublad. Hover je 3 seconden stil boven het icoon,
// dan verschijnt er rechtsboven een klein rood prullenbak-bolletje —
// bewust vertraagd, zodat je er niet per ongeluk overheen "raakt" op weg
// naar iets anders.
function DesktopIcon({ icon, label, onOpen, onRequestDelete }) {
  const [showDelete, setShowDelete] = useState(false);
  const timerRef = useRef(null);

  function handleEnter() {
    timerRef.current = setTimeout(() => setShowDelete(true), 3000);
  }
  function handleLeave() {
    clearTimeout(timerRef.current);
    setShowDelete(false);
  }

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <div className="relative" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <button
        onClick={onOpen}
        className="flex flex-col items-center gap-1.5 p-2 rounded-lg hover:bg-slate-100 text-center w-full"
        title={label}
      >
        <span className="text-4xl leading-none">{icon}</span>
        <span className="text-xs text-slate-600 break-words line-clamp-2">{label}</span>
      </button>
      {showDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRequestDelete();
          }}
          className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center text-white shadow"
          title="Verwijderen"
        >
          <span className="text-[10px] leading-none">🗑️</span>
        </button>
      )}
    </div>
  );
}

// kind: 'doc' | 'call' | 'channel' — bepaalt zowel het zelfstandig
// naamwoord in de vraag als (voor 'channel') een geruststellende
// toelichting: het verwijderen van een opgeslagen kanaal is puur een
// lokale bladwijzer die verdwijnt, geen destructieve actie op het kanaal
// zelf (in tegenstelling tot een document/video-oproep verwijderen, wat
// wél een Nostr-event naar alle deelnemers stuurt).
function ConfirmDeleteModal({ label, kind = 'doc', onConfirm, onCancel }) {
  const noun = kind === 'call' ? 'de video-oproep' : kind === 'channel' ? 'het kanaal' : 'het document';
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-white rounded-lg shadow-xl p-5 w-80 max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm text-slate-700 mb-1">
          Weet je zeker dat je {noun} <span className="font-medium">"{label}"</span>{' '}
          {kind === 'channel' ? 'uit je opgeslagen kanalen wilt verwijderen' : 'wilt verwijderen'}?
        </p>
        {kind === 'channel' && (
          <p className="text-xs text-slate-400 mb-3">
            Het kanaal zelf (chat, documenten, video-oproepen) blijft gewoon bestaan — dit haalt 'm alleen uit dit
            lijstje. Bezoek je de link later opnieuw, dan verschijnt hij vanzelf weer.
          </p>
        )}
        <div className={`flex justify-end gap-2 ${kind === 'channel' ? '' : 'mt-3'}`}>
          <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded border border-slate-200 hover:bg-slate-50">
            Annuleren
          </button>
          <button onClick={onConfirm} className="text-xs px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700">
            Verwijderen
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Collaboratieve editor: BlockNoteJS + Yjs, P2P via NostrWebrtcProvider */
/*  Het ydoc/provider-paar wordt centraal beheerd door useDocumentSync    */
/*  (Dashboard) — dit is puur de presentatielaag voor het geopende doc.  */
/* ------------------------------------------------------------------ */

function BlockNoteEditorInner({ ydoc, provider, identity, displayName, roomName }) {
  const editor = useCreateBlockNote({
    collaboration: {
      provider,
      fragment: ydoc.getXmlFragment('document-store'),
      user: {
        name: displayName || 'Gast',
        color: colorFromString(identity?.pubkey ?? roomName),
      },
    },
  });

  return (
    <div className="h-full overflow-y-auto">
      <BlockNoteView editor={editor} theme="light" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  P2P videobellen via Jitsi Meet                                      */
/* ------------------------------------------------------------------ */

function VideoCall({ roomId, displayName }) {
  // videobellen.pleio.nl is een zelfgehoste Jitsi Meet-instantie (zelfde
  // domein/kamernaam-URL-structuur als meet.jit.si). roomId (kanaal-ID +
  // video-oproep-ID) is stabiel en willekeurig per aangemaakte oproep, dus
  // dezelfde kamer is later via hetzelfde icoon/dezelfde chatlink altijd
  // weer te bereiken.
  const src = `https://videobellen.pleio.nl/${encodeURIComponent(roomId)}#userInfo.displayName=%22${encodeURIComponent(
    displayName
  )}%22&config.prejoinPageEnabled=false`;

  return (
    <iframe
      src={src}
      allow="camera; microphone; fullscreen; display-capture; autoplay"
      className="w-full h-full border-0"
      title="Video call"
    />
  );
}
