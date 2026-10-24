// Call signalling for B-MESSENGER.
// The server never carries audio or video. It only relays the WebRTC setup messages
// (offer, answer, ICE candidates) between the two people in a call, and records the result.

const crypto = require('crypto');

const RING_MS = 40 * 1000;          // how long a call rings before it is counted as missed
const DISCONNECT_RING_MS = 5 * 1000; // ringing call whose person went offline
const GRACE_MS = 20 * 1000;          // time a connected call survives a dropped connection
const MAX_SIGNAL_CHARS = 16 * 1024;  // largest signalling message accepted
const INVITES_PER_MINUTE = 10;

function fail(message) {
    const err = new Error(message);
    err.publicMessage = message;
    return err;
}

function createCalls({ io, getDb, isOnline, emitToUser }) {
    const activeCalls = new Map(); // callId -> call
    const userCall = new Map();    // username -> callId of the call they are in
    const inviteLog = new Map();   // username -> timestamps of recent invites

    // STUN finds the public address of each phone. TURN relays media when a direct path is blocked.
    // TURN logins expire after one hour and are generated here, so the secret never reaches the browser.
    function iceServers(username) {
        const servers = [{
            urls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map(s => s.trim()).filter(Boolean)
        }];
        const turnUrls = process.env.TURN_URLS;
        const secret = process.env.TURN_SECRET;
        if (turnUrls && secret) {
            const expiry = Math.floor(Date.now() / 1000) + 3600;
            const login = `${expiry}:${username}`;
            const credential = crypto.createHmac('sha1', secret).update(login).digest('base64');
            servers.push({ urls: turnUrls.split(',').map(s => s.trim()).filter(Boolean), username: login, credential });
        }
        return servers;
    }

    function allowInvite(username) {
        const now = Date.now();
        const recent = (inviteLog.get(username) || []).filter(t => now - t < 60 * 1000);
        if (recent.length >= INVITES_PER_MINUTE) return false;
        recent.push(now);
        inviteLog.set(username, recent);
        return true;
    }

    function roleOf(call, me) {
        if (call.caller === me) return 'caller';
        if (call.callee === me) return 'callee';
        return null;
    }

    function requireCall(me, callId) {
        const call = typeof callId === 'string' ? activeCalls.get(callId) : null;
        if (!call || call.state === 'ended') throw fail('This call has already ended');
        if (!roleOf(call, me)) throw fail('You are not part of this call');
        return call;
    }

    function saveRecord(record) {
        getDb().collection('calls').insertOne(record)
            .catch(err => console.error('Call record error:', err));
    }

    // Ends a call once, saves its record, and tells both people
    function finish(call, status) {
        if (call.state === 'ended') return;
        call.state = 'ended';
        clearTimeout(call.ringTimer);
        clearTimeout(call.graceTimer);
        activeCalls.delete(call.id);
        if (userCall.get(call.caller) === call.id) userCall.delete(call.caller);
        if (userCall.get(call.callee) === call.id) userCall.delete(call.callee);

        const endedAt = new Date();
        const durationSec = call.connectedAt ? Math.max(0, Math.round((endedAt - call.connectedAt) / 1000)) : 0;
        const record = {
            caller: call.caller,
            callee: call.callee,
            type: call.type,
            status,
            startedAt: call.startedAt,
            endedAt,
            durationSec
        };
        saveRecord(record);

        const payload = { callId: call.id, status, durationSec, record };
        emitToUser(call.caller, 'call-ended', payload);
        emitToUser(call.callee, 'call-ended', payload);
    }

    async function invite(me, data) {
        const to = String(data.to || '').trim();
        const type = data.type === 'video' ? 'video' : (data.type === 'voice' ? 'voice' : null);
        if (!to || to === me || !type) throw fail('Invalid call request');
        if (!allowInvite(me)) throw fail('You are calling too often. Wait a moment and try again.');
        if (userCall.has(me)) throw fail('You are already on a call');

        const target = await getDb().collection('users').findOne({ username: to }, { projection: { _id: 1 } });
        if (!target) throw fail('That user does not exist');

        const settings = await getDb().collection('user_settings').findOne({ username: to }, { projection: { blockedUsers: 1 } });
        if (settings && Array.isArray(settings.blockedUsers) && settings.blockedUsers.includes(me)) {
            return { status: 'unavailable' };
        }
        if (userCall.has(to)) return { status: 'busy' };

        const now = new Date();
        if (!isOnline(to)) {
            // Nobody is there to ring: record a missed call and tell the caller
            saveRecord({ caller: me, callee: to, type, status: 'missed', startedAt: now, endedAt: now, durationSec: 0 });
            return { status: 'unavailable' };
        }

        const call = {
            id: crypto.randomUUID(),
            caller: me,
            callee: to,
            type,
            state: 'ringing',
            startedAt: now,
            connectedAt: null,
            ringTimer: null,
            graceTimer: null
        };
        activeCalls.set(call.id, call);
        userCall.set(me, call.id);
        userCall.set(to, call.id);
        call.ringTimer = setTimeout(() => {
            if (call.state === 'ringing') finish(call, 'missed');
        }, RING_MS);

        emitToUser(to, 'call-incoming', { callId: call.id, from: me, type });
        return { status: 'ringing', callId: call.id };
    }

    function attach(socket, me) {
        const on = (name, handler) => socket.on(name, async (...args) => {
            const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
            try {
                const result = await handler(args[0] || {}, me);
                if (ack) ack({ success: true, ...(result || {}) });
            } catch (err) {
                if (!err.publicMessage) console.error(`${name} error:`, err);
                if (ack) ack({ success: false, error: err.publicMessage || 'Call failed. Try again.' });
            }
        });

        on('get-ice-config', async (_d, me) => ({ iceServers: iceServers(me) }));

        on('get-active-call', async (_d, me) => {
            const call = userCall.has(me) ? activeCalls.get(userCall.get(me)) : null;
            if (!call) return { call: null };
            return {
                call: {
                    callId: call.id,
                    role: roleOf(call, me),
                    peer: call.caller === me ? call.callee : call.caller,
                    type: call.type,
                    state: call.state,
                    connected: !!call.connectedAt
                }
            };
        });

        on('call-invite', (d, me) => invite(me, d));

        on('call-accept', async (d, me) => {
            const call = requireCall(me, d.callId);
            if (roleOf(call, me) !== 'callee') throw fail('Only the person being called can accept');
            if (call.state !== 'ringing') throw fail('This call was already answered');
            call.state = 'connecting';
            clearTimeout(call.ringTimer);
            emitToUser(call.caller, 'call-accepted', { callId: call.id });
            return {};
        });

        on('call-decline', async (d, me) => {
            const call = requireCall(me, d.callId);
            if (roleOf(call, me) !== 'callee') throw fail('Only the person being called can decline');
            if (call.state === 'ringing') finish(call, 'rejected');
            return {};
        });

        on('call-cancel', async (d, me) => {
            const call = requireCall(me, d.callId);
            if (roleOf(call, me) !== 'caller') throw fail('Only the caller can cancel');
            if (call.state === 'ringing') finish(call, 'cancelled');
            return {};
        });

        on('call-end', async (d, me) => {
            const call = requireCall(me, d.callId);
            if (call.state === 'ringing') {
                finish(call, roleOf(call, me) === 'caller' ? 'cancelled' : 'rejected');
            } else {
                finish(call, call.connectedAt ? 'completed' : 'failed');
            }
            return {};
        });

        // Relays WebRTC setup messages between the two people in one call
        on('call-signal', async (d, me) => {
            const call = requireCall(me, d.callId);
            if (call.state !== 'connecting' && call.state !== 'connected') throw fail('The call is not ready yet');
            if (!['offer', 'answer', 'ice'].includes(d.kind)) throw fail('Invalid signal');
            if (JSON.stringify(d.data ?? null).length > MAX_SIGNAL_CHARS) throw fail('Signal too large');
            const other = roleOf(call, me) === 'caller' ? call.callee : call.caller;
            emitToUser(other, 'call-signal', { callId: call.id, kind: d.kind, data: d.data });
            return {};
        });

        on('call-connected', async (d, me) => {
            const call = requireCall(me, d.callId);
            if (call.state === 'ended') return {};
            if (!call.connectedAt) {
                call.connectedAt = new Date();
                call.state = 'connected';
                const other = roleOf(call, me) === 'caller' ? call.callee : call.caller;
                emitToUser(other, 'call-state', { callId: call.id, state: 'connected' });
            }
            return {};
        });

        on('get-calls', async (d, me) => {
            const withUser = String(d.with || '');
            if (!withUser) throw fail('Invalid chat');
            const list = await getDb().collection('calls').find({
                $or: [{ caller: me, callee: withUser }, { caller: withUser, callee: me }]
            }).sort({ startedAt: -1 }).limit(30).toArray();
            return {
                calls: list.reverse().map(c => ({
                    caller: c.caller, callee: c.callee, type: c.type, status: c.status,
                    durationSec: c.durationSec || 0, startedAt: c.startedAt
                }))
            };
        });

        // A reconnecting phone cancels the pending drop timer
        const call = userCall.has(me) ? activeCalls.get(userCall.get(me)) : null;
        if (call && call.graceTimer) {
            clearTimeout(call.graceTimer);
            call.graceTimer = null;
        }

        socket.on('disconnect', () => {
            const current = userCall.has(me) ? activeCalls.get(userCall.get(me)) : null;
            if (!current || current.graceTimer) return;
            const delay = current.state === 'ringing' ? DISCONNECT_RING_MS : GRACE_MS;
            current.graceTimer = setTimeout(() => {
                current.graceTimer = null;
                if (current.state === 'ended' || isOnline(me)) return;
                if (current.state === 'ringing') {
                    finish(current, roleOf(current, me) === 'caller' ? 'cancelled' : 'missed');
                } else {
                    finish(current, current.connectedAt ? 'completed' : 'failed');
                }
            }, delay);
        });
    }

    return { attach };
}

module.exports = createCalls;
