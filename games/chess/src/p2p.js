// Direct browser-to-browser link (WebRTC data channel) for player-hosted games.
// Signaling messages travel through our server's relay; once the channel opens,
// game traffic flows directly between the two browsers.
//
// No TURN server: if hole punching fails, callers keep using the server relay instead.
// Set from the server's /status (our own STUN, plus a fallback only while ours is unreachable).
let ICE_SERVERS = [{ urls: ['stun:jgame.duckdns.org:3478'] }];
export function setStunServers(urls) {
  if (Array.isArray(urls) && urls.length) ICE_SERVERS = [{ urls }];
}
const OPEN_TIMEOUT_MS = 12000;

export const webrtcSupported = () => typeof RTCPeerConnection !== 'undefined';

export class DirectLink {
  /**
   * @param {object} o
   * @param {'offer'|'answer'} o.role     the guest offers, the host answers
   * @param {(s:object) => void} o.sendSignal   deliver {sdp}|{candidate} to the other side via the relay
   * @param {(msg:object) => void} o.onMessage
   * @param {(state:'open'|'closed') => void} o.onState
   */
  constructor({ role, sendSignal, onMessage, onState }) {
    this.sendSignal = sendSignal;
    this.onMessage = onMessage;
    this.onState = onState;
    this.open = false;
    this.dead = false;
    this.pendingCandidates = [];
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.sendSignal({ candidate: e.candidate.toJSON() });
    };
    this.pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(this.pc.connectionState)) this.fail();
    };
    if (role === 'offer') {
      this.attach(this.pc.createDataChannel('game', { ordered: true }));
      this.makeOffer();
    } else {
      this.pc.ondatachannel = (e) => this.attach(e.channel);
    }
    this.timer = setTimeout(() => {
      if (!this.open) this.fail();
    }, OPEN_TIMEOUT_MS);
  }

  async makeOffer() {
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer());
      this.sendSignal({ sdp: this.pc.localDescription.toJSON() });
    } catch {
      this.fail();
    }
  }

  /** Feed a signaling message ({sdp} or {candidate}) from the other side. */
  async signal(msg) {
    if (this.dead) return;
    try {
      if (msg.sdp) {
        await this.pc.setRemoteDescription(msg.sdp);
        if (msg.sdp.type === 'offer') {
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          this.sendSignal({ sdp: this.pc.localDescription.toJSON() });
        }
        for (const c of this.pendingCandidates.splice(0)) await this.pc.addIceCandidate(c);
      } else if (msg.candidate) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(msg.candidate);
        else this.pendingCandidates.push(msg.candidate);
      }
    } catch {
      this.fail();
    }
  }

  attach(dc) {
    this.dc = dc;
    dc.onopen = () => {
      this.open = true;
      clearTimeout(this.timer);
      this.onState('open');
    };
    dc.onclose = () => this.fail();
    dc.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg && typeof msg.t === 'string') this.onMessage(msg);
    };
  }

  get isOpen() {
    return this.open && !this.dead && this.dc?.readyState === 'open';
  }

  send(msg) {
    if (!this.isOpen) return false;
    try {
      this.dc.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  fail() {
    if (this.dead) return;
    this.close();
    this.onState('closed');
  }

  close() {
    this.dead = true;
    this.open = false;
    clearTimeout(this.timer);
    try {
      this.dc?.close();
      this.pc.close();
    } catch {}
  }
}
