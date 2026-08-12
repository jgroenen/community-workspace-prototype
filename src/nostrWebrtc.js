// -------------------------------------------------------------------
// NostrWebrtcProvider
//
// Een Yjs-provider met dezelfde vorm/interface als y-webrtc's
// `WebrtcProvider` (roomName, doc, opts) → { awareness, destroy() }, maar
// zonder aparte signaling-websocket. In plaats daarvan lopen de SDP/ICE-
// uitwisseling (het daadwerkelijke WebRTC-verbindingsopzet) als Nostr-
// events over dezelfde relays en hetzelfde kanaal als de rest van de app —
// vervolg op het architectuurprincipe uit App.jsx: "alle toestand die
// andere peers moeten meekrijgen, gaat als Nostr-event het kanaal in".
//
// Het CRDT-sync-protocol (sync-step 1/2, incrementele updates) en het
// awareness-protocol (cursors/selecties) zijn overgenomen van y-webrtc
// (y-protocols/sync + y-protocols/awareness) — beproefde logica die we
// niet opnieuw willen uitvinden. Wat vervangen is: de signaling-laag die
// de twee peers bij elkaar brengt vóórdat er een WebRTC-datakanaal is.
//
// Nostr-eventkinds (ephemeral, NIP-01: 20000-29999 — relays hoeven ze niet
// te bewaren, precies wat je wilt voor verbindingsopzet):
//   RTC_ANNOUNCE_KIND  "ik ben aanwezig in deze room" (onversleuteld, leeg)
//   RTC_SIGNAL_KIND     SDP-offer/answer, NIP-04-versleuteld en gericht aan
//                        één specifieke peer via een 'p'-tag
//
// Wie initieert de verbinding? Zodra twee peers elkaars announce zien,
// initieert degene met de (lexicografisch) laagste pubkey; de ander wacht
// op een inkomend offer-signaal. Dat is deterministisch en sluit "glare"
// (beide kanten initiëren tegelijk) volledig uit — geen race-conditie of
// token-vergelijking nodig.
//
// De SDP/ICE-payload wordt met NIP-04 versleuteld (alleen leesbaar voor
// afzender en geadresseerde), want SDP bevat lokale netwerk-IP's die je
// niet in platte tekst op een publieke relay wilt zetten. Ondersteunt een
// extensie zonder NIP-04 (zeldzaam) niet, dan valt dit terug op onversleuteld
// met een eenmalige waarschuwing in de console.
// -------------------------------------------------------------------

import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { ObservableV2 } from 'lib0/observable';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import Peer from 'simple-peer/simplepeer.min.js';

const messageSync = 0;
const messageAwareness = 1;
const messageQueryAwareness = 3;

export const RTC_ANNOUNCE_KIND = 20090;
export const RTC_SIGNAL_KIND = 20091;

// Hoe vaak we onszelf opnieuw aankondigen: vangt gemiste events op (een
// relay die een event niet doorstuurde) en helpt laat binnenkomende peers
// ons alsnog te vinden.
const ANNOUNCE_INTERVAL_MS = 15000;

/** Eén WebRTC-peerverbinding naar één andere gebruiker in dezelfde room. */
class WebrtcConn {
  constructor(provider, initiator, remotePubkey) {
    this.provider = provider;
    this.remotePubkey = remotePubkey;
    this.connected = false;
    this.synced = false;
    // trickle:false bundelt alle ICE-candidates bij de offer/answer, zodat
    // er precies één Nostr-signaalevent per kant nodig is i.p.v. één per
    // candidate (minder relay-verkeer, iets tragere verbindingsopzet).
    this.peer = new Peer({ initiator, trickle: false });

    this.peer.on('signal', (signal) => {
      provider.publishSignal(remotePubkey, signal);
    });

    this.peer.on('connect', () => {
      this.connected = true;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeSyncStep1(encoder, provider.doc);
      this.send(encoding.toUint8Array(encoder));

      const states = provider.awareness.getStates();
      if (states.size > 0) {
        const awEncoder = encoding.createEncoder();
        encoding.writeVarUint(awEncoder, messageAwareness);
        encoding.writeVarUint8Array(
          awEncoder,
          awarenessProtocol.encodeAwarenessUpdate(provider.awareness, Array.from(states.keys()))
        );
        this.send(encoding.toUint8Array(awEncoder));
      }
      provider._emitPeers();
    });

    this.peer.on('close', () => {
      this.connected = false;
      provider.conns.delete(remotePubkey);
      provider._emitPeers();
      provider._updateSynced();
      // Nieuwe kans geven om elkaar opnieuw te vinden (bv. na een netwerk-
      // hikje) door onszelf meteen opnieuw aan te kondigen.
      provider._announce();
    });

    this.peer.on('error', () => {
      provider._announce();
    });

    this.peer.on('data', (data) => {
      const reply = readPeerMessage(provider, this, data);
      if (reply) this.send(reply);
    });
  }

  send(buf) {
    try {
      this.peer.send(buf);
    } catch {
      /* peer al gesloten, negeren */
    }
  }

  destroy() {
    this.peer.destroy();
  }
}

function readPeerMessage(provider, conn, buf) {
  const decoder = decoding.createDecoder(buf);
  const encoder = encoding.createEncoder();
  const messageType = decoding.readVarUint(decoder);
  let sendReply = false;
  switch (messageType) {
    case messageSync: {
      encoding.writeVarUint(encoder, messageSync);
      const syncType = syncProtocol.readSyncMessage(decoder, encoder, provider.doc, provider);
      if (syncType === syncProtocol.messageYjsSyncStep2 && !conn.synced) {
        conn.synced = true;
        provider._updateSynced();
      }
      if (syncType === syncProtocol.messageYjsSyncStep1) sendReply = true;
      break;
    }
    case messageQueryAwareness:
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(provider.awareness, Array.from(provider.awareness.getStates().keys()))
      );
      sendReply = true;
      break;
    case messageAwareness:
      awarenessProtocol.applyAwarenessUpdate(provider.awareness, decoding.readVarUint8Array(decoder), provider);
      break;
    default:
      return null;
  }
  return sendReply ? encoding.toUint8Array(encoder) : null;
}

export class NostrWebrtcProvider extends ObservableV2 {
  /**
   * @param {string} roomTag - unieke 't'-tagwaarde voor deze room (bv. `wsdoc-${channelId}-${docId}`).
   * @param {import('yjs').Doc} doc
   * @param {{ pool: any, relays: string[], identity: { pubkey: string, signEvent: Function, encrypt?: Function, decrypt?: Function }, maxConns?: number }} opts
   */
  constructor(roomTag, doc, { pool, relays, identity, maxConns = 20 } = {}) {
    super();
    this.doc = doc;
    this.roomTag = roomTag;
    this.pool = pool;
    this.relays = relays;
    this.identity = identity;
    this.maxConns = maxConns;
    this.awareness = new awarenessProtocol.Awareness(doc);
    this.conns = new Map(); // pubkey -> WebrtcConn
    this.synced = false;
    this.destroyed = false;
    this._warnedNoEncryption = false;
    this._announceTimer = null;
    this._announceSub = null;
    this._signalSub = null;

    this._docUpdateHandler = (update, origin) => {
      if (origin === this) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      this._broadcast(encoding.toUint8Array(encoder));
    };
    this.doc.on('update', this._docUpdateHandler);

    this._awarenessUpdateHandler = ({ added, updated, removed }) => {
      const changed = added.concat(updated).concat(removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      this._broadcast(encoding.toUint8Array(encoder));
    };
    this.awareness.on('update', this._awarenessUpdateHandler);

    this._beforeUnloadHandler = () => {
      awarenessProtocol.removeAwarenessStates(this.awareness, [doc.clientID], 'window unload');
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this._beforeUnloadHandler);
    }

    if (this.identity && this.pool) {
      this._start();
    }
  }

  _broadcast(buf) {
    this.conns.forEach((conn) => conn.send(buf));
  }

  _emitPeers() {
    this.emit('peers', [{ webrtcPeers: Array.from(this.conns.keys()) }]);
  }

  _updateSynced() {
    const synced = this.conns.size > 0 && Array.from(this.conns.values()).every((c) => c.synced);
    if (synced !== this.synced) {
      this.synced = synced;
      this.emit('synced', [{ synced }]);
    }
  }

  async _encryptFor(pubkey, plaintext) {
    if (this.identity.encrypt) {
      try {
        return await this.identity.encrypt(pubkey, plaintext);
      } catch (err) {
        console.warn('NIP-04-versleuteling mislukt, val terug op onversleuteld signaal.', err);
      }
    } else if (!this._warnedNoEncryption) {
      this._warnedNoEncryption = true;
      console.warn('Identiteit ondersteunt geen NIP-04 — WebRTC-signalering gaat onversleuteld over de relay.');
    }
    return plaintext;
  }

  async _decryptFrom(pubkey, payload) {
    if (this.identity.decrypt) {
      try {
        return await this.identity.decrypt(pubkey, payload);
      } catch {
        // Waarschijnlijk onversleutelde payload (fallback-pad) of van een
        // niet-compatibele afzender — probeer as-is te parsen.
        return payload;
      }
    }
    return payload;
  }

  async publishSignal(toPubkey, signal) {
    if (!this.identity || !this.pool || this.destroyed) return;
    const content = await this._encryptFor(toPubkey, JSON.stringify(signal));
    const template = {
      kind: RTC_SIGNAL_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['t', this.roomTag],
        ['p', toPubkey],
      ],
      content,
    };
    try {
      const signed = await this.identity.signEvent(template);
      this.pool.publish(this.relays, signed).forEach((p) => p.catch(() => {}));
    } catch (err) {
      console.error('Kon WebRTC-signaal niet publiceren.', err);
    }
  }

  async _announce() {
    if (!this.identity || !this.pool || this.destroyed) return;
    const template = {
      kind: RTC_ANNOUNCE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', this.roomTag]],
      content: '',
    };
    try {
      const signed = await this.identity.signEvent(template);
      this.pool.publish(this.relays, signed).forEach((p) => p.catch(() => {}));
    } catch (err) {
      console.error('Kon WebRTC-announce niet publiceren.', err);
    }
  }

  // "Get or create": bestaat er al een verbinding naar deze peer, dan die
  // teruggeven — nooit een tweede verbinding naar dezelfde peer openen.
  _ensureConn(remotePubkey, initiator) {
    if (!this.identity || remotePubkey === this.identity.pubkey) return null;
    let conn = this.conns.get(remotePubkey);
    if (!conn) {
      if (this.conns.size >= this.maxConns) return null;
      conn = new WebrtcConn(this, initiator, remotePubkey);
      this.conns.set(remotePubkey, conn);
      this._emitPeers();
    }
    return conn;
  }

  _handleAnnounce(event) {
    const myPubkey = this.identity.pubkey;
    if (event.pubkey === myPubkey || this.conns.has(event.pubkey)) return;
    // Deterministisch: wie de laagste pubkey heeft initieert de
    // verbinding, de ander wacht passief op een inkomend offer-signaal.
    // Voorkomt dat beide kanten tegelijk een offer sturen ("glare").
    if (myPubkey < event.pubkey) {
      this._ensureConn(event.pubkey, true);
    }
  }

  async _handleSignal(event) {
    const myPubkey = this.identity.pubkey;
    if (event.pubkey === myPubkey) return;
    let signal;
    try {
      const plaintext = await this._decryptFrom(event.pubkey, event.content);
      signal = JSON.parse(plaintext);
    } catch {
      return;
    }
    if (!signal) return;
    const conn = this._ensureConn(event.pubkey, false);
    conn?.peer.signal(signal);
  }

  _start() {
    const myPubkey = this.identity.pubkey;

    // Let op: subscribeMany verwacht in nostr-tools v2 één los filter-
    // object (geen array van filters).
    this._announceSub = this.pool.subscribeMany(
      this.relays,
      { kinds: [RTC_ANNOUNCE_KIND], '#t': [this.roomTag] },
      { onevent: (event) => this._handleAnnounce(event) }
    );

    this._signalSub = this.pool.subscribeMany(
      this.relays,
      { kinds: [RTC_SIGNAL_KIND], '#t': [this.roomTag], '#p': [myPubkey] },
      { onevent: (event) => this._handleSignal(event) }
    );

    this._announce();
    this._announceTimer = setInterval(() => this._announce(), ANNOUNCE_INTERVAL_MS);
  }

  destroy() {
    this.destroyed = true;
    if (this._announceTimer) clearInterval(this._announceTimer);
    this._announceSub?.close();
    this._signalSub?.close();
    this.doc.off('update', this._docUpdateHandler);
    this.awareness.off('update', this._awarenessUpdateHandler);
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this._beforeUnloadHandler);
    }
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    this.conns.forEach((conn) => conn.destroy());
    this.conns.clear();
    super.destroy();
  }
}
