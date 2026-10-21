require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');

const APP_NAME = 'B-Messenger';
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'gramXDB';
const PORT = process.env.PORT || 3000;

if (!MONGODB_URI) {
    console.error('MONGODB_URI is not set. Add it to your .env file or hosting environment.');
    process.exit(1);
}

const COLLECTIONS = {
    USERS: 'users',
    MESSAGES: 'messages',
    USER_SETTINGS: 'user_settings',
    STATUSES: 'statuses',
    CHAT_PREFS: 'chat_prefs',
    GROUPS: 'groups',
    STARRED: 'starred',
    CHANNELS: 'channels',
    CHANNEL_POSTS: 'channel_posts',
    REPORTS: 'reports',
    PASSWORD_REQUESTS: 'password_requests',
    ADMINS: 'admins',
    ADMIN_LOGS: 'admin_logs'
};

const LIMITS = {
    TEXT: 2000,
    STATUS_TEXT: 500,
    NAME: 40,
    ABOUT: 140,
    PASSWORD_MIN: 6,
    PASSWORD_MAX: 100,
    HISTORY: 150,
    CONVERSATIONS: 200,
    PEOPLE: 300,
    IMAGE_CHARS: 3 * 1024 * 1024,
    AUDIO_CHARS: 4 * 1024 * 1024,
    AUDIO_SECONDS: 120,
    PINNED_MAX: 3,
    STATUS_LIST: 300,
    GROUP_MEMBERS: 256,
    GROUP_NAME: 50,
    GROUP_DESC: 300,
    GROUP_HISTORY: 300
};

const BUBBLE_COLORS = ['#11412B', '#1E3A5F', '#4A2B5C', '#5C3A1E', '#1F4A4A', '#5C1E2B'];
const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,/;
const AUDIO_RE = /^data:audio\/(webm|ogg|mp4|mpeg|wav|x-m4a)(;[a-z0-9=.-]+)*;base64,/;
const PRIVACY_VALUES = ['everyone', 'contacts', 'nobody'];
const THEMES = ['dark', 'light', 'auto'];
const STATUS_BACKGROUNDS = ['#14402C', '#1F3A5F', '#5B2A4A', '#4A3B12', '#2A2F36', '#0F5C4A'];

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 6 * 1024 * 1024 });

app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db;
let mongoClient;

const users = () => db.collection(COLLECTIONS.USERS);
const messages = () => db.collection(COLLECTIONS.MESSAGES);
const settingsCol = () => db.collection(COLLECTIONS.USER_SETTINGS);
const statuses = () => db.collection(COLLECTIONS.STATUSES);
const chatPrefs = () => db.collection(COLLECTIONS.CHAT_PREFS);
const groups = () => db.collection(COLLECTIONS.GROUPS);
const starred = () => db.collection(COLLECTIONS.STARRED);
const channels = () => db.collection(COLLECTIONS.CHANNELS);
const channelPosts = () => db.collection(COLLECTIONS.CHANNEL_POSTS);
const reports = () => db.collection(COLLECTIONS.REPORTS);
const passwordRequests = () => db.collection(COLLECTIONS.PASSWORD_REQUESTS);

// Channel info as seen by one user
function channelView(c, me) {
    const subscribers = c.subscribers || [];
    const admins = c.admins || [];
    return {
        _id: String(c._id),
        name: c.name,
        description: c.description || '',
        photo: c.photo || null,
        createdBy: c.createdBy,
        admins,
        subscriberCount: subscribers.length,
        isOwner: c.createdBy === me,
        isAdmin: admins.includes(me),
        subscribed: subscribers.includes(me),
        createdAt: c.createdAt,
        lastPost: c.lastPost || null
    };
}

// A channel post as seen by one user; reactions are returned as counts plus the viewer's own choice
function publicPost(p, me) {
    const reactions = p.reactions || {};
    const counts = {};
    Object.values(reactions).forEach(e => { counts[e] = (counts[e] || 0) + 1; });
    if (p.deleted) {
        return { _id: String(p._id), channelId: p.channelId, sender: p.sender, timestamp: p.timestamp, deleted: true, counts: {}, myReaction: null };
    }
    return {
        _id: String(p._id),
        channelId: p.channelId,
        sender: p.sender,
        timestamp: p.timestamp,
        deleted: false,
        text: p.text || '',
        image: p.image || null,
        audio: p.audio || null,
        audioDuration: p.audioDuration || 0,
        counts,
        myReaction: me ? (reactions[me] || null) : null
    };
}

async function getChannel(id) {
    if (!ObjectId.isValid(id)) throw fail('Channel not found');
    const c = await channels().findOne({ _id: new ObjectId(id) });
    if (!c) throw fail('Channel not found');
    return c;
}

async function emitChannel(c, event, payload) {
    for (const s of c.subscribers || []) emitToUser(s, event, payload);
}

function fail(message) {
    const err = new Error(message);
    err.publicMessage = message;
    return err;
}

async function connectToDatabase() {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    db = mongoClient.db(DB_NAME);

    await users().createIndex({ username: 1 }, { unique: true });
    await settingsCol().createIndex({ username: 1 }, { unique: true });
    await messages().createIndex({ sender: 1, receiver: 1, timestamp: 1 });
    await messages().createIndex({ receiver: 1, read: 1 });
    await messages().createIndex({ groupId: 1, timestamp: 1 });
    await statuses().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await statuses().createIndex({ user: 1, timestamp: 1 });
    await chatPrefs().createIndex({ owner: 1, partner: 1 }, { unique: true });
    await groups().createIndex({ members: 1 });
    await starred().createIndex({ owner: 1, messageId: 1 }, { unique: true });
    await channels().createIndex({ subscribers: 1 });
    await channelPosts().createIndex({ channelId: 1, timestamp: 1 });
    await reports().createIndex({ status: 1, createdAt: 1 });
    await passwordRequests().createIndex({ status: 1, createdAt: 1 });
    await ensureAdmin();

    console.log(`Connected to MongoDB (${DB_NAME})`);
}

// Passwords

// Account status: active, suspended (until a date or indefinitely), or banned

function accountBlock(user) {
    if (!user) return null;
    if (user.status === 'banned') return 'This account has been banned.';
    if (user.status === 'suspended') {
        const until = user.suspendedUntil ? new Date(user.suspendedUntil) : null;
        if (!until || until > new Date()) {
            return until ? `This account is suspended until ${until.toLocaleString()}.` : 'This account is suspended.';
        }
    }
    return null;
}

function accountStatus(user) {
    if (accountBlock(user)) return user.status;
    return 'active';
}

function disconnectUser(username) {
    io.in(`user:${username}`).disconnectSockets(true);
}

function sanitizeReply(r) {
    if (!r || typeof r !== 'object' || !r._id) return null;
    return {
        _id: String(r._id).slice(0, 40),
        sender: String(r.sender || '').slice(0, 40),
        text: String(r.text || '').slice(0, 140),
        kind: ['text', 'photo', 'voice', 'status'].includes(r.kind) ? r.kind : 'text'
    };
}

// Creates or updates the admin account from ADMIN_EMAIL and ADMIN_PASSWORD
async function ensureAdmin() {
    const email = (process.env.ADMIN_EMAIL || 'admin@bmessenger.com').trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD || 'Adminbera';
    if (!process.env.ADMIN_PASSWORD) {
        console.warn('ADMIN_PASSWORD is not set, so the default admin password is in use. Set it in your environment.');
    }
    await db.collection(COLLECTIONS.ADMINS).updateOne(
        { email },
        {
            $set: { email, passwordHash: hashPassword(password), updatedAt: new Date() },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
    );
    console.log(`Admin account ready: ${email}`);
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(stored, password) {
    try {
        const [salt, hash] = stored.split(':');
        const test = crypto.scryptSync(password, salt, 64).toString('hex');
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
    } catch (err) {
        return false;
    }
}

// Helpers

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validDataUrl(value, re, maxChars) {
    return typeof value === 'string' && value.length <= maxChars && re.test(value);
}

async function userExists(username) {
    return !!(await users().findOne({ username }, { projection: { _id: 1 } }));
}

async function blockState(me, other) {
    const [mine, theirs] = await Promise.all([
        settingsCol().findOne({ username: me, blockedUsers: other }, { projection: { _id: 1 } }),
        settingsCol().findOne({ username: other, blockedUsers: me }, { projection: { _id: 1 } })
    ]);
    return { byMe: !!mine, byThem: !!theirs };
}

// Presence

const onlineCounts = new Map();

function isOnline(username) {
    return (onlineCounts.get(username) || 0) > 0;
}

function emitToUser(username, event, payload) {
    io.to(`user:${username}`).emit(event, payload);
}

// Settings

function defaultSettings(displayName = null) {
    return {
        theme: 'dark',
        notifications: true,
        sound: true,
        keepArchived: false,
        privacy: { lastSeen: 'everyone', profilePhoto: 'everyone', readReceipts: true },
        avatar: 'default1',
        customAvatar: null,
        customBackground: null,
        twoStep: false,
        mutedChats: [],
        blockedUsers: [],
        displayName,
        about: 'Hey there! I am using B-Messenger.',
        updatedAt: new Date()
    };
}

async function getSettings(username) {
    let settings = await settingsCol().findOne({ username });
    if (!settings) {
        try {
            await settingsCol().insertOne({ username, ...defaultSettings() });
        } catch (err) {
            if (err.code !== 11000) throw err;
        }
        settings = await settingsCol().findOne({ username });
    }
    return settings;
}

function sanitizeSettings(input) {
    const patch = {};
    if (!input || typeof input !== 'object') return patch;

    if ('displayName' in input) {
        patch.displayName = input.displayName === null
            ? null
            : (String(input.displayName).trim().slice(0, LIMITS.NAME) || null);
    }
    if ('about' in input) {
        patch.about = String(input.about ?? '').slice(0, LIMITS.ABOUT);
    }
    if ('avatar' in input) {
        patch.avatar = String(input.avatar).slice(0, 20);
    }
    if ('customAvatar' in input) {
        if (input.customAvatar === null) patch.customAvatar = null;
        else if (validDataUrl(input.customAvatar, IMAGE_RE, LIMITS.IMAGE_CHARS)) patch.customAvatar = input.customAvatar;
        else throw fail('That profile photo is too large or not supported');
    }
    if ('customBackground' in input) {
        if (input.customBackground === null) patch.customBackground = null;
        else if (validDataUrl(input.customBackground, IMAGE_RE, LIMITS.IMAGE_CHARS)) patch.customBackground = input.customBackground;
        else throw fail('That wallpaper is too large or not supported');
    }
    if (THEMES.includes(input.theme)) patch.theme = input.theme;
    if (typeof input.notifications === 'boolean') patch.notifications = input.notifications;
    if (typeof input.sound === 'boolean') patch.sound = input.sound;
    if (typeof input.keepArchived === 'boolean') patch.keepArchived = input.keepArchived;
    if (typeof input.twoStep === 'boolean') patch.twoStep = input.twoStep;
    if (Array.isArray(input.mutedChats)) patch.mutedChats = input.mutedChats.map(String).slice(0, 500);

    if (input.privacy && typeof input.privacy === 'object') {
        if (PRIVACY_VALUES.includes(input.privacy.lastSeen)) patch['privacy.lastSeen'] = input.privacy.lastSeen;
        if (PRIVACY_VALUES.includes(input.privacy.profilePhoto)) patch['privacy.profilePhoto'] = input.privacy.profilePhoto;
        if (typeof input.privacy.readReceipts === 'boolean') patch['privacy.readReceipts'] = input.privacy.readReceipts;
        if (['everyone', 'contacts'].includes(input.privacy.status)) patch['privacy.status'] = input.privacy.status;
    }
    return patch;
}

// Chat preferences (per user, per chat)

async function getPrefsMap(owner) {
    const rows = await chatPrefs().find({ owner }).toArray();
    return new Map(rows.map(r => [r.partner, r]));
}

async function countPinned(owner, exceptPartner) {
    return chatPrefs().countDocuments({
        owner,
        pinned: true,
        partner: { $ne: exceptPartner }
    });
}

const PRIVATE_IPV4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

async function isPublicHost(hostname) {
    const dns = require('dns').promises;
    const addresses = await dns.lookup(hostname, { all: true });
    return addresses.every(a => {
        if (a.family === 4) return !PRIVATE_IPV4.test(a.address);
        const ip = a.address.toLowerCase();
        return ip !== '::1' && !ip.startsWith('fc') && !ip.startsWith('fd') && !ip.startsWith('fe80');
    });
}

function firstUrl(text) {
    const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
    return m ? m[0].replace(/[.,;:!?)\]]+$/, '') : null;
}

function decodeHtml(s) {
    return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function metaFrom(html, base) {
    const pick = (key) => {
        const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'));
        const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i'));
        const m = a || b;
        return m ? decodeHtml(m[1]).trim() : null;
    };
    const tag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    const title = pick('og:title') || pick('twitter:title') || (tag ? decodeHtml(tag).trim() : null);
    let image = pick('og:image') || pick('twitter:image');
    if (image) { try { image = new URL(image, base).href; } catch (e) { image = null; } }
    const description = pick('og:description') || pick('description');
    return {
        url: base,
        title: title ? title.slice(0, 200) : null,
        description: description ? description.slice(0, 300) : null,
        image,
        site: pick('og:site_name') || new URL(base).hostname
    };
}

async function fetchLinkPreview(url) {
    const first = new URL(url);
    if (!['http:', 'https:'].includes(first.protocol)) return null;
    if (!(await isPublicHost(first.hostname))) return null;

    const res = await fetch(first.href, {
        redirect: 'follow',
        signal: AbortSignal.timeout(6000),
        headers: { 'User-Agent': 'B-MessengerPreview/1.0', Accept: 'text/html' }
    });
    if (!res.ok || !res.body) return null;
    const finalUrl = new URL(res.url || first.href);
    if (!(await isPublicHost(finalUrl.hostname))) return null;
    if (!(res.headers.get('content-type') || '').includes('text/html')) return null;

    // Read at most 256 KB; the title and tags are at the top of the page
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (received < 262144) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        received += value.length;
    }
    try { await reader.cancel(); } catch (e) { /* already finished */ }
    return metaFrom(Buffer.concat(chunks).toString('utf8'), finalUrl.href);
}

async function attachLinkPreview(messageId, text, recipients) {
    const url = firstUrl(text);
    if (!url) return;
    let preview = null;
    try { preview = await fetchLinkPreview(url); } catch (err) { preview = null; }
    if (!preview || !preview.title) return;
    await messages().updateOne({ _id: messageId }, { $set: { preview } });
    for (const r of new Set(recipients)) emitToUser(r, 'message-preview', { messageId: String(messageId), preview });
}

async function canSeeStatus(me, s) {
    if (s.user === me || s.audience === 'everyone') return true;
    return sharesContact(me, s.user);
}

async function filterVisibleStatuses(me, list) {
    const cache = new Map();
    const visible = [];
    for (const s of list) {
        if (s.user !== me && s.audience !== 'everyone') {
            if (!cache.has(s.user)) cache.set(s.user, await sharesContact(me, s.user));
            if (!cache.get(s.user)) continue;
        }
        visible.push(s);
    }
    return visible;
}

async function sharesContact(a, b) {
    const chatted = await messages().findOne({
        groupId: null,
        $or: [{ sender: a, receiver: b }, { sender: b, receiver: a }]
    }, { projection: { _id: 1 } });
    if (chatted) return true;
    return !!(await groups().findOne({ members: { $all: [a, b] } }, { projection: { _id: 1 } }));
}

// Profiles and visibility

async function visibleTo(viewer, owner, setting) {
    if (viewer === owner || setting === 'everyone') return true;
    if (setting === 'nobody') return false;
    const chatted = await messages().findOne({
        groupId: null,
        $or: [{ sender: viewer, receiver: owner }, { sender: owner, receiver: viewer }]
    }, { projection: { _id: 1 } });
    return !!chatted;
}

async function batchProfiles(viewer, names) {
    const unique = [...new Set(names)];
    const [settingRows, userRows] = await Promise.all([
        settingsCol().find({ username: { $in: unique } }).toArray(),
        users().find({ username: { $in: unique } }, { projection: { username: 1, lastSeen: 1, phone: 1 } }).toArray()
    ]);
    const settingsByUser = new Map(settingRows.map(x => [x.username, x]));
    const usersByName = new Map(userRows.map(x => [x.username, x]));
    const out = {};
    for (const n of unique) {
        out[n] = await buildProfile(viewer, n, settingsByUser.get(n), usersByName.get(n) || null);
    }
    return out;
}

async function buildProfile(viewer, username, settings, preloadedUser) {
    const s = settings || await getSettings(username);
    const photoOk = await visibleTo(viewer, username, s.privacy?.profilePhoto || 'everyone');
    const seenOk = await visibleTo(viewer, username, s.privacy?.lastSeen || 'everyone');

    const userDoc = preloadedUser !== undefined
        ? preloadedUser
        : await users().findOne({ username }, { projection: { lastSeen: 1, phone: 1 } });
    const phoneOk = !!userDoc?.phone && (viewer === username || await sharesContact(viewer, username));
    const lastSeen = seenOk ? (userDoc?.lastSeen || null) : null;

    return {
        username,
        displayName: s.displayName || username,
        about: s.about || '',
        avatar: s.avatar || 'default1',
        customAvatar: photoOk ? (s.customAvatar || null) : null,
        lastSeen,
        online: seenOk && isOnline(username),
        phone: phoneOk ? (userDoc?.phone || null) : null
    };
}

// Private messages sent to clients. One-view photos never include the image here;
// the receiver fetches it once with open-one-view.

function publicMessage(m) {
    const base = {
        _id: String(m._id),
        sender: m.sender,
        receiver: m.receiver,
        timestamp: m.timestamp,
        read: !!m.read,
        delivered: !!m.delivered,
        deleted: !!m.deleted
    };
    if (m.deleted) return base;
    if (m.oneView) {
        return { ...base, text: '', image: null, audio: null, audioDuration: 0, oneView: true, opened: !!m.opened };
    }
    return {
        ...base,
        text: m.text || '',
        image: m.image || null,
        audio: m.audio || null,
        audioDuration: m.audioDuration || 0,
        oneView: false,
        opened: false,
        edited: !!m.edited,
        preview: m.preview || null,
        forwarded: !!m.forwarded,
        replyTo: m.replyTo || null,
        reactions: m.reactions || {}
    };
}

// Group messages sent to clients

function publicGroupMessage(m) {
    if (m.deleted) {
        return { _id: String(m._id), groupId: m.groupId, sender: m.sender, timestamp: m.timestamp, deleted: true, system: !!m.system };
    }
    return {
        _id: String(m._id),
        groupId: m.groupId,
        sender: m.sender,
        timestamp: m.timestamp,
        deleted: false,
        system: !!m.system,
        text: m.text || '',
        image: m.image || null,
        audio: m.audio || null,
        audioDuration: m.audioDuration || 0,
        edited: !!m.edited,
        preview: m.preview || null,
        forwarded: !!m.forwarded,
        replyTo: m.replyTo || null,
        reactions: m.reactions || {}
    };
}

// Conversations and receipts

async function getConversations(me) {
    const rows = await messages().aggregate([
        { $match: { groupId: null, $or: [{ sender: me }, { receiver: me }], hiddenFor: { $ne: me } } },
        { $addFields: { partner: { $cond: [{ $eq: ['$sender', me] }, '$receiver', '$sender'] } } },
        { $sort: { timestamp: -1 } },
        {
            $group: {
                _id: '$partner',
                text: { $first: '$text' },
                sender: { $first: '$sender' },
                deleted: { $first: '$deleted' },
                timestamp: { $first: '$timestamp' },
                hasImage: { $first: { $cond: [{ $ifNull: ['$image', false] }, true, false] } },
                oneView: { $first: { $cond: [{ $eq: ['$oneView', true] }, true, false] } },
                hasAudio: { $first: { $cond: [{ $ifNull: ['$audio', false] }, true, false] } },
                unread: {
                    $sum: { $cond: [{ $and: [{ $eq: ['$receiver', me] }, { $eq: ['$read', false] }] }, 1, 0] }
                }
            }
        },
        { $sort: { timestamp: -1 } },
        { $limit: LIMITS.CONVERSATIONS }
    ]).toArray();

    const prefs = await getPrefsMap(me);
    const partners = rows.map(r => r._id);
    const [settingRows, userRows] = await Promise.all([
        settingsCol().find({ username: { $in: partners } }).toArray(),
        users().find({ username: { $in: partners } }, { projection: { username: 1, lastSeen: 1, phone: 1 } }).toArray()
    ]);
    const settingsByUser = new Map(settingRows.map(x => [x.username, x]));
    const usersByName = new Map(userRows.map(x => [x.username, x]));
    const result = [];

    for (const row of rows) {
        const profile = await buildProfile(me, row._id, settingsByUser.get(row._id), usersByName.get(row._id) || null);
        const pref = prefs.get(row._id) || {};
        result.push({
            partner: row._id,
            profile,
            pinned: !!pref.pinned,
            pinnedAt: pref.pinnedAt || null,
            archived: !!pref.archived,
            lastMessage: {
                text: row.deleted ? '' : (row.text || ''),
                hasImage: !row.deleted && row.hasImage,
                hasAudio: !row.deleted && row.hasAudio,
                oneView: !row.deleted && row.oneView,
                deleted: !!row.deleted,
                sender: row.sender,
                timestamp: row.timestamp
            },
            unreadCount: row.unread
        });
    }
    return result;
}

async function markReadFrom(partner, me) {
    const unread = await messages().find(
        { groupId: null, sender: partner, receiver: me, read: false },
        { projection: { _id: 1 } }
    ).toArray();
    if (!unread.length) return;

    const ids = unread.map(m => m._id);
    await messages().updateMany({ _id: { $in: ids } }, { $set: { read: true, readAt: new Date() } });

    const mySettings = await getSettings(me);
    if (mySettings.privacy?.readReceipts) {
        emitToUser(partner, 'messages-read', { reader: me, messageIds: ids.map(String) });
    }
}

async function markDeliveredFor(me) {
    const pending = await messages().find(
        { groupId: null, receiver: me, delivered: false },
        { projection: { _id: 1, sender: 1 } }
    ).toArray();
    if (!pending.length) return;

    await messages().updateMany(
        { _id: { $in: pending.map(p => p._id) } },
        { $set: { delivered: true, deliveredAt: new Date() } }
    );

    const bySender = new Map();
    for (const p of pending) {
        if (!bySender.has(p.sender)) bySender.set(p.sender, []);
        bySender.get(p.sender).push(String(p._id));
    }
    for (const [sender, ids] of bySender) {
        emitToUser(sender, 'message-delivered', { messageIds: ids });
    }
}

// Groups

function groupView(g, me) {
    return {
        _id: String(g._id),
        name: g.name,
        description: g.description || '',
        photo: g.photo || null,
        createdBy: g.createdBy,
        admins: g.admins || [],
        members: g.members || [],
        announcementOnly: !!g.announcementOnly,
        membersCanEdit: !!g.membersCanEdit,
        isAdmin: (g.admins || []).includes(me),
        canSend: !g.announcementOnly || (g.admins || []).includes(me),
        createdAt: g.createdAt
    };
}

async function getGroupForMember(groupId, me) {
    if (!ObjectId.isValid(groupId)) throw fail('Group not found');
    const g = await groups().findOne({ _id: new ObjectId(groupId), members: me });
    if (!g) throw fail('Group not found');
    return g;
}

function requireAdmin(g, me) {
    if (!(g.admins || []).includes(me)) throw fail('Only group admins can do that');
}

async function emitGroup(g, event, payload) {
    for (const member of g.members || []) emitToUser(member, event, payload);
}

async function groupSystemMessage(g, text) {
    const doc = {
        groupId: String(g._id),
        sender: 'system',
        receiver: null,
        text,
        image: null,
        audio: null,
        audioDuration: 0,
        system: true,
        timestamp: new Date(),
        deleted: false,
        hiddenFor: []
    };
    const result = await messages().insertOne(doc);
    doc._id = result.insertedId;
    await emitGroup(g, 'group-message', publicGroupMessage(doc));
}

async function touchGroup(groupId) {
    await groups().updateOne({ _id: groupId }, { $set: { updatedAt: new Date() } });
}

// HTTP auth

async function requireAuth(req, res, next) {
    try {
        const username = req.headers['x-username'];
        const token = req.headers['x-token'];
        if (typeof username !== 'string' || typeof token !== 'string') {
            return res.status(401).json({ success: false, error: 'Not signed in' });
        }
        const user = await users().findOne({ username, sessionToken: token }, { projection: { _id: 1 } });
        if (!user) return res.status(401).json({ success: false, error: 'Session expired' });
        req.username = username;
        next();
    } catch (err) {
        res.status(500).json({ success: false, error: 'Authentication failed' });
    }
}

// HTTP routes

app.post('/forgot-password', async (req, res) => {
    try {
        const username = String(req.body.username || '').trim();
        const user = username ? await users().findOne({ username }, { projection: { _id: 1 } }) : null;
        if (user) {
            const open = await passwordRequests().findOne({ username, status: 'open' });
            if (!open) await passwordRequests().insertOne({ username, status: 'open', createdAt: new Date() });
        }
        res.json({
            success: true,
            message: 'Your request has been sent to the admin. They will contact you with your new password.'
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not send the request. Try again.' });
    }
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/register', async (req, res) => {
    try {
        const username = String(req.body.username || '').trim();
        const password = String(req.body.password || '');
        const fullName = String(req.body.fullName || '').trim().slice(0, LIMITS.NAME);
        const phone = String(req.body.phone || '').replace(/[^\d+ ]/g, '').trim().slice(0, 20);

        if (!USERNAME_RE.test(username)) {
            return res.json({ success: false, error: 'Usernames use 3 to 20 letters, numbers, or underscores' });
        }
        if (password.length < LIMITS.PASSWORD_MIN || password.length > LIMITS.PASSWORD_MAX) {
            return res.json({ success: false, error: 'Password must be 6 to 100 characters' });
        }

        const avatarPhoto = req.body.avatarPhoto;
        if (avatarPhoto && !validDataUrl(avatarPhoto, IMAGE_RE, LIMITS.IMAGE_CHARS)) {
            return res.json({ success: false, error: 'That profile photo is too large or not supported' });
        }

        await users().insertOne({
            username,
            passwordHash: hashPassword(password),
            fullName: fullName || null,
            phone: phone || null,
            sessionToken: null,
            createdAt: new Date(),
            lastSeen: new Date()
        });

        await settingsCol().insertOne({ username, ...defaultSettings(fullName || null), customAvatar: avatarPhoto || null });
        res.json({ success: true, username });
    } catch (err) {
        if (err.code === 11000) return res.json({ success: false, error: 'Username taken' });
        console.error('Register error:', err);
        res.status(500).json({ success: false, error: 'Registration failed' });
    }
});

app.post('/login', async (req, res) => {
    try {
        const username = String(req.body.username || '').trim();
        const password = String(req.body.password || '');
        if (!username || !password) {
            return res.json({ success: false, error: 'Enter your username and password' });
        }

        const user = await users().findOne({ username });
        let valid = false;

        if (user?.passwordHash) {
            valid = verifyPassword(user.passwordHash, password);
        } else if (user && user.password && user.password === password) {
            valid = true;
            await users().updateOne(
                { username },
                { $set: { passwordHash: hashPassword(password) }, $unset: { password: '' } }
            );
        }

        if (!valid) return res.json({ success: false, error: 'Invalid username or password' });

        const blocked = accountBlock(user);
        if (blocked) return res.json({ success: false, error: blocked });

        const token = crypto.randomBytes(32).toString('hex');
        await users().updateOne({ username }, { $set: { sessionToken: token, lastSeen: new Date() } });
        res.json({ success: true, username, token });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, error: 'Login failed' });
    }
});

app.post('/session', async (req, res) => {
    try {
        const { username, token } = req.body || {};
        if (typeof username !== 'string' || typeof token !== 'string') return res.json({ success: false });
        const user = await users().findOne({ username, sessionToken: token }, { projection: { _id: 1 } });
        res.json({ success: !!user });
    } catch (err) {
        res.json({ success: false });
    }
});

app.post('/logout', async (req, res) => {
    try {
        const { username, token } = req.body || {};
        if (typeof username === 'string' && typeof token === 'string') {
            await users().updateOne({ username, sessionToken: token }, { $set: { sessionToken: null } });
        }
    } catch (err) {
        console.error('Logout error:', err);
    }
    res.json({ success: true });
});

app.get('/users', requireAuth, async (req, res) => {
    try {
        const me = req.username;
        const list = await users().find({ username: { $ne: me } }, { projection: { username: 1 } })
            .limit(LIMITS.PEOPLE).toArray();
        const profiles = [];
        for (const u of list) profiles.push(await buildProfile(me, u.username));
        res.json({ success: true, users: profiles });
    } catch (err) {
        console.error('Users error:', err);
        res.status(500).json({ success: false, error: 'Could not load people' });
    }
});

app.get('/search-users', requireAuth, async (req, res) => {
    try {
        const me = req.username;
        const q = String(req.query.q || '').trim().slice(0, 20);
        if (!q) return res.json({ success: true, users: [] });

        const found = await users().find(
            { username: { $regex: escapeRegex(q), $options: 'i', $ne: me } },
            { projection: { username: 1 } }
        ).limit(20).toArray();

        const profiles = [];
        for (const u of found) profiles.push(await buildProfile(me, u.username));
        res.json({ success: true, users: profiles });
    } catch (err) {
        console.error('Search error:', err);
        res.status(500).json({ success: false, error: 'Search failed' });
    }
});

// Admin panel API

const PUBLIC_USER_FIELDS = { passwordHash: 0, sessionToken: 0 };

function adminLog(admin, action, target, detail) {
    return db.collection(COLLECTIONS.ADMIN_LOGS).insertOne({
        admin, action, target, detail: detail || '', at: new Date()
    });
}

async function purgeUser(username) {
    await users().deleteOne({ username });
    await messages().deleteMany({ $or: [{ sender: username }, { receiver: username }] });
    await settingsCol().deleteOne({ username });
    await statuses().deleteMany({ user: username });
    await chatPrefs().deleteMany({ $or: [{ owner: username }, { partner: username }] });
    await starred().deleteMany({ owner: username });
    await groups().updateMany({ members: username }, { $pull: { members: username, admins: username } });
}

async function requireAdminAuth(req, res, next) {
    try {
        const token = req.headers['x-admin-token'];
        if (typeof token !== 'string' || !token) return res.status(401).json({ success: false, error: 'Not signed in' });
        const admin = await db.collection(COLLECTIONS.ADMINS).findOne({ sessionToken: token });
        if (!admin) return res.status(401).json({ success: false, error: 'Session expired' });
        req.admin = admin.email;
        next();
    } catch (err) {
        res.status(500).json({ success: false, error: 'Authentication failed' });
    }
}

app.post('/admin/login', async (req, res) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const password = String(req.body.password || '');
        const admin = await db.collection(COLLECTIONS.ADMINS).findOne({ email });
        if (!admin || !verifyPassword(admin.passwordHash, password)) {
            return res.json({ success: false, error: 'Invalid admin email or password' });
        }
        const token = crypto.randomBytes(32).toString('hex');
        await db.collection(COLLECTIONS.ADMINS).updateOne({ email }, { $set: { sessionToken: token, lastLogin: new Date() } });
        res.json({ success: true, token, email });
    } catch (err) {
        console.error('Admin login error:', err);
        res.status(500).json({ success: false, error: 'Login failed' });
    }
});

app.post('/admin/logout', requireAdminAuth, async (req, res) => {
    await db.collection(COLLECTIONS.ADMINS).updateOne({ email: req.admin }, { $set: { sessionToken: null } });
    res.json({ success: true });
});

app.get('/admin/stats', requireAdminAuth, async (req, res) => {
    try {
        const now = new Date();
        const since = new Date(now.getTime() - 86400000);
        const [total, banned, suspended, msgs, msgsToday, groupCount, statusCount] = await Promise.all([
            users().countDocuments({}),
            users().countDocuments({ status: 'banned' }),
            users().countDocuments({ status: 'suspended', $or: [{ suspendedUntil: null }, { suspendedUntil: { $gt: now } }] }),
            messages().countDocuments({}),
            messages().countDocuments({ timestamp: { $gt: since } }),
            groups().countDocuments({}),
            statuses().countDocuments({ expiresAt: { $gt: now } })
        ]);
        res.json({
            success: true,
            stats: {
                users: total, banned, suspended, online: onlineCounts.size,
                messages: msgs, messagesToday: msgsToday, groups: groupCount, activeStatuses: statusCount
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not load stats' });
    }
});

app.get('/admin/users', requireAdminAuth, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim().slice(0, 40);
        const filter = String(req.query.filter || 'all');
        const query = {};
        if (q) {
            const re = { $regex: escapeRegex(q), $options: 'i' };
            query.$or = [{ username: re }, { fullName: re }, { phone: re }];
        }
        if (filter === 'banned') query.status = 'banned';
        if (filter === 'suspended') query.status = 'suspended';

        const list = await users().find(query, { projection: PUBLIC_USER_FIELDS })
            .sort({ createdAt: -1 }).limit(200).toArray();

        res.json({
            success: true,
            users: list.map(u => ({
                username: u.username,
                fullName: u.fullName || null,
                phone: u.phone || null,
                status: accountStatus(u),
                suspendedUntil: u.suspendedUntil || null,
                createdAt: u.createdAt,
                lastSeen: u.lastSeen || null,
                online: isOnline(u.username)
            }))
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not load users' });
    }
});

app.get('/admin/users/:username', requireAdminAuth, async (req, res) => {
    try {
        const username = req.params.username;
        const u = await users().findOne({ username }, { projection: PUBLIC_USER_FIELDS });
        if (!u) return res.status(404).json({ success: false, error: 'User not found' });

        const settings = await settingsCol().findOne({ username }) || {};
        const [sent, groupCount, statusCount] = await Promise.all([
            messages().countDocuments({ sender: username }),
            groups().countDocuments({ members: username }),
            statuses().countDocuments({ user: username, expiresAt: { $gt: new Date() } })
        ]);

        res.json({
            success: true,
            user: {
                username,
                fullName: u.fullName || null,
                phone: u.phone || null,
                displayName: settings.displayName || null,
                about: settings.about || '',
                status: accountStatus(u),
                suspendedUntil: u.suspendedUntil || null,
                banReason: u.banReason || null,
                createdAt: u.createdAt,
                lastSeen: u.lastSeen || null,
                online: isOnline(username),
                blockedCount: (settings.blockedUsers || []).length
            },
            stats: { messagesSent: sent, groups: groupCount, activeStatuses: statusCount }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not load user' });
    }
});

app.post('/admin/users/:username/action', requireAdminAuth, async (req, res) => {
    try {
        const username = req.params.username;
        const action = String(req.body.action || '');
        const reason = String(req.body.reason || '').slice(0, 200);
        const now = new Date();

        const u = await users().findOne({ username }, { projection: { _id: 1 } });
        if (!u) return res.status(404).json({ success: false, error: 'User not found' });

        switch (action) {
            case 'suspend': {
                const days = Math.max(0, Number(req.body.days) || 0);
                const until = days > 0 ? new Date(now.getTime() + days * 86400000) : null;
                await users().updateOne({ username }, {
                    $set: { status: 'suspended', suspendedUntil: until, banReason: reason || null },
                    $unset: { sessionToken: '' }
                });
                disconnectUser(username);
                break;
            }
            case 'unsuspend':
                await users().updateOne({ username }, { $set: { status: 'active', suspendedUntil: null, banReason: null } });
                break;
            case 'ban':
                await users().updateOne({ username }, {
                    $set: { status: 'banned', suspendedUntil: null, banReason: reason || null },
                    $unset: { sessionToken: '' }
                });
                disconnectUser(username);
                break;
            case 'unban':
                await users().updateOne({ username }, { $set: { status: 'active', suspendedUntil: null, banReason: null } });
                break;
            case 'logout':
                await users().updateOne({ username }, { $unset: { sessionToken: '' } });
                disconnectUser(username);
                break;
            case 'reset-password': {
                const password = String(req.body.password || '');
                if (password.length < LIMITS.PASSWORD_MIN || password.length > LIMITS.PASSWORD_MAX) {
                    return res.json({ success: false, error: 'Password must be 6 to 100 characters' });
                }
                await users().updateOne({ username }, {
                    $set: { passwordHash: hashPassword(password) },
                    $unset: { sessionToken: '' }
                });
                disconnectUser(username);
                break;
            }
            case 'delete':
                await purgeUser(username);
                disconnectUser(username);
                break;
            default:
                return res.json({ success: false, error: 'Unknown action' });
        }

        await adminLog(req.admin, action, username, reason || (req.body.days ? `${req.body.days} days` : ''));
        res.json({ success: true });
    } catch (err) {
        console.error('Admin action error:', err);
        res.status(500).json({ success: false, error: 'Action failed' });
    }
});

app.get('/admin/groups', requireAdminAuth, async (req, res) => {
    const list = await groups().find({}).sort({ createdAt: -1 }).limit(200).toArray();
    res.json({
        success: true,
        groups: list.map(g => ({
            _id: String(g._id), name: g.name, createdBy: g.createdBy,
            members: g.members.length, createdAt: g.createdAt
        }))
    });
});

app.delete('/admin/groups/:id', requireAdminAuth, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.json({ success: false, error: 'Group not found' });
    const g = await groups().findOne({ _id: new ObjectId(req.params.id) });
    if (!g) return res.json({ success: false, error: 'Group not found' });

    await messages().deleteMany({ groupId: String(g._id) });
    await groups().deleteOne({ _id: g._id });
    for (const m of g.members) emitToUser(m, 'group-deleted', { groupId: String(g._id) });
    await adminLog(req.admin, 'delete-group', g.name, String(g._id));
    res.json({ success: true });
});

app.get('/admin/statuses', requireAdminAuth, async (req, res) => {
    const list = await statuses().find({ expiresAt: { $gt: new Date() } }).sort({ timestamp: -1 }).limit(200).toArray();
    res.json({
        success: true,
        statuses: list.map(s => ({
            _id: String(s._id), user: s.user, text: s.text || '', image: s.image || null, hasImage: !!s.image, timestamp: s.timestamp
        }))
    });
});

app.delete('/admin/statuses/:id', requireAdminAuth, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.json({ success: false, error: 'Status not found' });
    const result = await statuses().deleteOne({ _id: new ObjectId(req.params.id) });
    if (!result.deletedCount) return res.json({ success: false, error: 'Status not found' });
    io.emit('new-status', {});
    await adminLog(req.admin, 'delete-status', req.params.id, '');
    res.json({ success: true });
});

app.get('/admin/channel-posts', requireAdminAuth, async (req, res) => {
    try {
        const list = await channelPosts().find({ deleted: { $ne: true } }).sort({ timestamp: -1 }).limit(200).toArray();
        const ids = [...new Set(list.map(p => p.channelId))].filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
        const chans = await channels().find({ _id: { $in: ids } }, { projection: { name: 1 } }).toArray();
        const names = new Map(chans.map(c => [String(c._id), c.name]));
        res.json({
            success: true,
            posts: list.map(p => ({
                _id: String(p._id),
                channelId: p.channelId,
                channel: names.get(p.channelId) || 'Deleted channel',
                sender: p.sender,
                text: p.text || '',
                image: p.image || null,
                hasAudio: !!p.audio,
                timestamp: p.timestamp
            }))
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not load posts' });
    }
});

app.delete('/admin/channel-posts/:id', requireAdminAuth, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.json({ success: false, error: 'Post not found' });
    const p = await channelPosts().findOne({ _id: new ObjectId(req.params.id) });
    if (!p || p.deleted) return res.json({ success: false, error: 'Post not found' });

    await channelPosts().updateOne({ _id: p._id }, { $set: { deleted: true, text: '', image: null, audio: null } });
    if (ObjectId.isValid(p.channelId)) {
        const c = await channels().findOne({ _id: new ObjectId(p.channelId) });
        if (c) await emitChannel(c, 'channel-post-deleted', { channelId: p.channelId, postId: String(p._id) });
    }
    await adminLog(req.admin, 'delete-channel-post', p.sender, String(p._id));
    res.json({ success: true });
});

app.get('/admin/users/:username/posts', requireAdminAuth, async (req, res) => {
    try {
        const username = req.params.username;
        const [sts, posts] = await Promise.all([
            statuses().find({ user: username, expiresAt: { $gt: new Date() } }).sort({ timestamp: -1 }).limit(50).toArray(),
            channelPosts().find({ sender: username, deleted: { $ne: true } }).sort({ timestamp: -1 }).limit(50).toArray()
        ]);
        res.json({
            success: true,
            statuses: sts.map(s => ({ _id: String(s._id), text: s.text || '', image: s.image || null, timestamp: s.timestamp })),
            posts: posts.map(p => ({ _id: String(p._id), text: p.text || '', image: p.image || null, timestamp: p.timestamp }))
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not load posts' });
    }
});

app.get('/admin/reports', requireAdminAuth, async (req, res) => {
    try {
        const list = await reports().find({ status: 'open' }).sort({ createdAt: 1 }).limit(200).toArray();
        const counts = {};
        list.forEach(r => { counts[r.targetId] = (counts[r.targetId] || 0) + 1; });
        res.json({
            success: true,
            reports: list.map(r => ({
                _id: String(r._id),
                reason: r.reason,
                targetType: r.targetType,
                targetId: r.targetId,
                targetUser: r.targetUser,
                reporter: r.reporter,
                snapshot: r.snapshot || {},
                reportCount: counts[r.targetId] || 1,
                createdAt: r.createdAt
            }))
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not load reports' });
    }
});

async function removeReportedContent(r) {
    if (!ObjectId.isValid(r.targetId)) return;
    const id = new ObjectId(r.targetId);
    if (r.targetType === 'message' || r.targetType === 'channel-post') {
        const col = r.targetType === 'message' ? messages() : channelPosts();
        await col.updateOne({ _id: id }, { $set: { deleted: true, text: '', image: null, audio: null } });
    } else if (r.targetType === 'status') {
        await statuses().deleteOne({ _id: id });
    }
}

app.post('/admin/reports/:id/resolve', requireAdminAuth, async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) return res.json({ success: false, error: 'Report not found' });
        const r = await reports().findOne({ _id: new ObjectId(req.params.id) });
        if (!r) return res.json({ success: false, error: 'Report not found' });

        const action = String(req.body.action || 'dismiss');
        const reason = String(req.body.reason || r.reason || '').slice(0, 200);
        const now = new Date();

        if (action === 'delete') await removeReportedContent(r);

        if (action === 'suspend') {
            const days = Math.max(0, Number(req.body.days) || 0);
            await users().updateOne({ username: r.targetUser }, {
                $set: {
                    status: 'suspended',
                    suspendedUntil: days > 0 ? new Date(now.getTime() + days * 86400000) : null,
                    banReason: reason
                },
                $unset: { sessionToken: '' }
            });
            disconnectUser(r.targetUser);
        }

        if (action === 'ban') {
            await users().updateOne({ username: r.targetUser }, {
                $set: { status: 'banned', suspendedUntil: null, banReason: reason },
                $unset: { sessionToken: '' }
            });
            disconnectUser(r.targetUser);
        }

        // Every open report about the same content is closed together
        await reports().updateMany(
            { targetId: r.targetId, status: 'open' },
            { $set: { status: action === 'dismiss' ? 'dismissed' : 'actioned', resolvedAt: now, resolvedBy: req.admin, resolution: action } }
        );
        await adminLog(req.admin, `report-${action}`, r.targetUser, reason);
        res.json({ success: true });
    } catch (err) {
        console.error('Report resolve error:', err);
        res.status(500).json({ success: false, error: 'Action failed' });
    }
});

app.get('/admin/password-requests', requireAdminAuth, async (req, res) => {
    try {
        const list = await passwordRequests().find({ status: 'open' }).sort({ createdAt: 1 }).limit(200).toArray();
        const accounts = await users().find(
            { username: { $in: list.map(r => r.username) } },
            { projection: { username: 1, fullName: 1, phone: 1, createdAt: 1 } }
        ).toArray();
        const byName = new Map(accounts.map(u => [u.username, u]));
        res.json({
            success: true,
            requests: list.map(r => {
                const u = byName.get(r.username) || {};
                return {
                    _id: String(r._id),
                    username: r.username,
                    fullName: u.fullName || null,
                    phone: u.phone || null,
                    accountCreated: u.createdAt || null,
                    createdAt: r.createdAt
                };
            })
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not load requests' });
    }
});

app.post('/admin/password-requests/:id/resolve', requireAdminAuth, async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) return res.json({ success: false, error: 'Request not found' });
        const r = await passwordRequests().findOne({ _id: new ObjectId(req.params.id), status: 'open' });
        if (!r) return res.json({ success: false, error: 'Request not found' });
        const now = new Date();

        if (req.body.reject === true) {
            await passwordRequests().updateOne({ _id: r._id }, { $set: { status: 'rejected', resolvedAt: now, resolvedBy: req.admin } });
            await adminLog(req.admin, 'password-request-rejected', r.username, '');
            return res.json({ success: true });
        }

        const password = String(req.body.password || '');
        if (password.length < LIMITS.PASSWORD_MIN || password.length > LIMITS.PASSWORD_MAX) {
            return res.json({ success: false, error: 'Password must be 6 to 100 characters' });
        }

        await users().updateOne({ username: r.username }, {
            $set: { passwordHash: hashPassword(password) },
            $unset: { sessionToken: '' }
        });
        disconnectUser(r.username);
        await passwordRequests().updateOne({ _id: r._id }, { $set: { status: 'done', resolvedAt: now, resolvedBy: req.admin } });
        await adminLog(req.admin, 'password-reset-request', r.username, '');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not set the password' });
    }
});

app.get('/admin/logs', requireAdminAuth, async (req, res) => {
    const logs = await db.collection(COLLECTIONS.ADMIN_LOGS).find({}).sort({ at: -1 }).limit(200).toArray();
    res.json({ success: true, logs: logs.map(l => ({ admin: l.admin, action: l.action, target: l.target, detail: l.detail, at: l.at })) });
});

// Socket authentication

io.use(async (socket, next) => {
    try {
        const { username, token } = socket.handshake.auth || {};
        if (typeof username !== 'string' || typeof token !== 'string') return next(new Error('unauthorized'));
        const user = await users().findOne({ username, sessionToken: token }, { projection: { _id: 1 } });
        if (!user) return next(new Error('unauthorized'));
        socket.data.username = username;
        next();
    } catch (err) {
        next(new Error('unauthorized'));
    }
});

// Socket events

io.on('connection', (socket) => {
    const me = socket.data.username;
    socket.join(`user:${me}`);

    const count = (onlineCounts.get(me) || 0) + 1;
    onlineCounts.set(me, count);
    if (count === 1) io.emit('presence-changed', { username: me });

    markDeliveredFor(me).catch(err => console.error('Delivery update error:', err));

    // Wraps each handler: runs fn(payload, me) and replies through the ack callback
    const on = (name, fn) => socket.on(name, async (...args) => {
        const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        try {
            const result = await fn(args[0] || {}, me);
            if (ack) ack({ success: true, ...(result || {}) });
        } catch (err) {
            if (err.publicMessage) {
                if (ack) ack({ success: false, error: err.publicMessage });
            } else {
                console.error(`${name} error:`, err);
                if (ack) ack({ success: false, error: 'Something went wrong. Try again.' });
            }
        }
    });

    on('get-conversations', async (_d, me) => ({ conversations: await getConversations(me) }));

    on('get-user-settings', async (_d, me) => ({ settings: await getSettings(me) }));

    on('update-settings', async (d, me) => {
        const patch = sanitizeSettings(d.settings);
        if (!Object.keys(patch).length) throw fail('Nothing to save');
        await getSettings(me);
        patch.updatedAt = new Date();
        await settingsCol().updateOne({ username: me }, { $set: patch }, { upsert: true });
        io.emit('profile-updated', { username: me });
        return {};
    });

    on('get-profile', async (d, me) => {
        const target = String(d.username || '');
        if (!(await userExists(target))) throw fail('User not found');
        return { profile: await buildProfile(me, target) };
    });

    on('join-conversation', async (d, me) => {
        const target = String(d.target || '');
        if (!target || target === me) throw fail('Invalid chat');
        if (!(await userExists(target))) throw fail('User not found');

        const block = await blockState(me, target);
        const history = await messages().find({
            groupId: null,
            $or: [{ sender: me, receiver: target }, { sender: target, receiver: me }],
            hiddenFor: { $ne: me }
        }).sort({ timestamp: -1 }).limit(LIMITS.HISTORY).toArray();

        const profile = await buildProfile(me, target);
        await markReadFrom(target, me);

        const pref = await chatPrefs().findOne({ owner: me, partner: target }) || {};

        return {
            profile,
            blocked: block,
            messages: history.reverse().map(publicMessage),
            prefs: {
                pinned: !!pref.pinned,
                archived: !!pref.archived,
                color: pref.color || null,
                wallpaper: pref.wallpaper || null
            }
        };
    });

    on('set-chat-prefs', async (d, me) => {
        const target = String(d.target || '');
        if (!target || target === me || !(await userExists(target))) throw fail('User not found');

        const patch = {};

        if (typeof d.pinned === 'boolean') {
            if (d.pinned) {
                const pinnedCount = await countPinned(me, target);
                if (pinnedCount >= LIMITS.PINNED_MAX) {
                    throw fail(`You can pin up to ${LIMITS.PINNED_MAX} chats`);
                }
                patch.pinned = true;
                patch.pinnedAt = new Date();
            } else {
                patch.pinned = false;
                patch.pinnedAt = null;
            }
        }

        if (typeof d.archived === 'boolean') {
            patch.archived = d.archived;
            if (d.archived) {
                patch.pinned = false;
                patch.pinnedAt = null;
            }
        }

        if ('color' in d) {
            if (d.color === null) patch.color = null;
            else if (BUBBLE_COLORS.includes(d.color)) patch.color = d.color;
            else throw fail('Choose a colour from the list');
        }

        if ('wallpaper' in d) {
            if (d.wallpaper === null) patch.wallpaper = null;
            else if (validDataUrl(d.wallpaper, IMAGE_RE, LIMITS.IMAGE_CHARS)) patch.wallpaper = d.wallpaper;
            else throw fail('That wallpaper is too large or not supported');
        }

        if (!Object.keys(patch).length) throw fail('Nothing to save');

        patch.updatedAt = new Date();
        await chatPrefs().updateOne(
            { owner: me, partner: target },
            { $set: patch },
            { upsert: true }
        );
        return {};
    });

    on('mark-read', async (d, me) => {
        const partner = String(d.partner || '');
        if (partner) await markReadFrom(partner, me);
        return {};
    });

    on('send-private-message', async (d, me) => {
        const receiver = String(d.receiver || '');
        const text = typeof d.text === 'string' ? d.text.trim().slice(0, LIMITS.TEXT) : '';
        const image = d.image || null;
        const audio = d.audio || null;
        const oneView = d.oneView === true;
        const audioDuration = Math.min(Math.max(Number(d.audioDuration) || 0, 0), LIMITS.AUDIO_SECONDS);

        if (!receiver || receiver === me) throw fail('Choose someone to message');
        if (oneView && !image) throw fail('One-view works with photos only');
        if (!text && !image && !audio) throw fail('Message is empty');
        if (image && !validDataUrl(image, IMAGE_RE, LIMITS.IMAGE_CHARS)) throw fail('That photo is too large or not supported');
        if (audio && !validDataUrl(audio, AUDIO_RE, LIMITS.AUDIO_CHARS)) throw fail('That voice note is too long or not supported');
        if (!(await userExists(receiver))) throw fail('User not found');

        const block = await blockState(me, receiver);
        if (block.byMe) throw fail('Unblock this contact to send messages');
        if (block.byThem) throw fail("You can't message this contact");

        const online = isOnline(receiver);
        const now = new Date();
        const doc = {
            groupId: null,
            sender: me,
            receiver,
            text: oneView ? '' : text,
            image: image,
            audio: oneView ? null : audio,
            audioDuration: oneView ? 0 : audioDuration,
            oneView,
            opened: false,
            replyTo: sanitizeReply(d.replyTo),
            forwarded: d.forwarded === true,
            edited: false,
            reactions: {},
            timestamp: now,
            read: false,
            readAt: null,
            delivered: online,
            deliveredAt: online ? now : null,
            deleted: false,
            hiddenFor: []
        };

        const result = await messages().insertOne(doc);
        doc._id = result.insertedId;
        attachLinkPreview(doc._id, doc.text, [me, String(d.receiver || '')]);
        const message = publicMessage(doc);

        // Like WhatsApp: a new message brings an archived chat back to the main list,
        // unless the receiver has chosen to keep chats archived.
        const receiverSettings = await getSettings(receiver);
        if (!receiverSettings.keepArchived) {
            await chatPrefs().updateOne(
                { owner: receiver, partner: me },
                { $set: { archived: false, updatedAt: now } }
            );
        }

        emitToUser(me, 'message-saved', { tempId: d.tempId, message });
        if (online) {
            emitToUser(receiver, 'new-private-message', message);
            emitToUser(me, 'message-delivered', { messageIds: [String(doc._id)] });
        }
        return { message };
    });

    on('open-one-view', async (d, me) => {
        if (!ObjectId.isValid(d.messageId)) throw fail('Photo not found');
        const id = new ObjectId(d.messageId);
        const msg = await messages().findOne({ _id: id, oneView: true });
        if (!msg || msg.receiver !== me) throw fail('Photo not found');
        if (msg.opened || !msg.image) throw fail('This photo has already been opened');

        const image = msg.image;
        await messages().updateOne(
            { _id: id },
            {
                $set: {
                    opened: true,
                    openedAt: new Date(),
                    read: true,
                    readAt: msg.readAt || new Date(),
                    image: null
                }
            }
        );

        emitToUser(msg.sender, 'one-view-opened', { messageId: String(id) });
        return { image };
    });

    on('delete-message', async (d, me) => {
        if (!ObjectId.isValid(d.messageId)) throw fail('Message not found');
        const id = new ObjectId(d.messageId);
        const msg = await messages().findOne({ _id: id });
        if (!msg || msg.sender !== me) throw fail('You can only delete your own messages');

        await messages().updateOne(
            { _id: id },
            { $set: { deleted: true, text: '', image: null, audio: null, deletedAt: new Date() } }
        );
        const payload = { messageId: String(id) };
        emitToUser(msg.sender, 'message-deleted', payload);
        emitToUser(msg.receiver, 'message-deleted', payload);
        return {};
    });

    on('clear-chat', async (d, me) => {
        const target = String(d.target || '');
        if (!target) throw fail('Invalid chat');
        await messages().updateMany(
            { groupId: null, $or: [{ sender: me, receiver: target }, { sender: target, receiver: me }] },
            { $addToSet: { hiddenFor: me } }
        );
        emitToUser(me, 'chat-cleared', { partner: target });
        return {};
    });

    on('block-user', async (d, me) => {
        const target = String(d.target || '');
        if (!target || target === me || !(await userExists(target))) throw fail('User not found');
        await getSettings(me);
        await settingsCol().updateOne(
            { username: me },
            { $addToSet: { blockedUsers: target }, $set: { updatedAt: new Date() } }
        );
        return {};
    });

    on('unblock-user', async (d, me) => {
        const target = String(d.target || '');
        if (!target) throw fail('User not found');
        await getSettings(me);
        await settingsCol().updateOne(
            { username: me },
            { $pull: { blockedUsers: target }, $set: { updatedAt: new Date() } }
        );
        return {};
    });

    on('typing-start', async (d, me) => {
        const receiver = String(d.receiver || '');
        if (receiver) emitToUser(receiver, 'typing-start', { sender: me });
        return {};
    });

    on('typing-stop', async (d, me) => {
        const receiver = String(d.receiver || '');
        if (receiver) emitToUser(receiver, 'typing-stop', { sender: me });
        return {};
    });

    // Groups

    on('create-group', async (d, me) => {
        const name = String(d.name || '').trim().slice(0, LIMITS.GROUP_NAME);
        if (!name) throw fail('Give the group a name');

        const others = Array.isArray(d.members) ? [...new Set(d.members.map(String))].filter(u => u && u !== me) : [];
        if (!others.length) throw fail('Choose at least one person');
        if (others.length + 1 > LIMITS.GROUP_MEMBERS) throw fail(`A group can have up to ${LIMITS.GROUP_MEMBERS} members`);

        for (const u of others) {
            if (!(await userExists(u))) throw fail(`User ${u} does not exist`);
        }

        const now = new Date();
        const members = [me, ...others];
        const result = await groups().insertOne({
            name,
            description: '',
            photo: null,
            createdBy: me,
            admins: [me],
            members,
            announcementOnly: false,
            membersCanEdit: false,
            readMarks: {},
            createdAt: now,
            updatedAt: now
        });
        const g = await groups().findOne({ _id: result.insertedId });
        await groupSystemMessage(g, `${me} created the group "${name}"`);
        await emitGroup(g, 'groups-changed', {});
        return { group: groupView(g, me) };
    });

    on('get-groups', async (_d, me) => {
        const list = await groups().find({ members: me }).sort({ updatedAt: -1 }).limit(200).toArray();
        const result = [];
        for (const g of list) {
            const id = String(g._id);
            const last = await messages().find({ groupId: id, deleted: { $ne: true } })
                .sort({ timestamp: -1 }).limit(1).toArray();
            const lm = last[0];
            const since = g.readMarks?.[me] || g.createdAt;
            const unread = await messages().countDocuments({
                groupId: id,
                sender: { $ne: me },
                timestamp: { $gt: since }
            });
            result.push({
                ...groupView(g, me),
                lastMessage: lm ? {
                    text: lm.text || (lm.image ? 'Photo' : (lm.audio ? 'Voice message' : '')),
                    sender: lm.sender,
                    system: !!lm.system,
                    timestamp: lm.timestamp
                } : null,
                unreadCount: unread
            });
        }
        return { groups: result };
    });

    on('get-group-info', async (d, me) => {
        const g = await getGroupForMember(String(d.groupId || ''), me);
        const profiles = {};
        Object.assign(profiles, await batchProfiles(me, g.members));
        return { group: groupView(g, me), profiles };
    });

    on('join-group', async (d, me) => {
        const g = await getGroupForMember(String(d.groupId || ''), me);
        const id = String(g._id);
        const history = await messages().find({ groupId: id, hiddenFor: { $ne: me } })
            .sort({ timestamp: -1 }).limit(LIMITS.GROUP_HISTORY).toArray();

        await groups().updateOne({ _id: g._id }, { $set: { [`readMarks.${me}`]: new Date() } });

        const profiles = {};
        Object.assign(profiles, await batchProfiles(me, g.members));

        return {
            group: groupView(g, me),
            profiles,
            messages: history.reverse().map(publicGroupMessage)
        };
    });

    on('send-group-message', async (d, me) => {
        const g = await getGroupForMember(String(d.groupId || ''), me);
        const text = typeof d.text === 'string' ? d.text.trim().slice(0, LIMITS.TEXT) : '';
        const image = d.image || null;
        const audio = d.audio || null;
        const audioDuration = Math.min(Math.max(Number(d.audioDuration) || 0, 0), LIMITS.AUDIO_SECONDS);

        if (g.announcementOnly && !g.admins.includes(me)) {
            throw fail('Only admins can send messages in this group');
        }
        if (!text && !image && !audio) throw fail('Message is empty');
        if (image && !validDataUrl(image, IMAGE_RE, LIMITS.IMAGE_CHARS)) throw fail('That photo is too large or not supported');
        if (audio && !validDataUrl(audio, AUDIO_RE, LIMITS.AUDIO_CHARS)) throw fail('That voice note is too long or not supported');

        const doc = {
            groupId: String(g._id),
            sender: me,
            receiver: null,
            text,
            image,
            audio,
            audioDuration,
            system: false,
            replyTo: sanitizeReply(d.replyTo),
            forwarded: d.forwarded === true,
            edited: false,
            reactions: {},
            timestamp: new Date(),
            deleted: false,
            hiddenFor: []
        };
        const result = await messages().insertOne(doc);
        doc._id = result.insertedId;
        attachLinkPreview(doc._id, doc.text, g.members);
        await touchGroup(g._id);

        const message = publicGroupMessage(doc);
        await emitGroup(g, 'group-message', message);
        return { message };
    });

    on('delete-group-message', async (d, me) => {
        if (!ObjectId.isValid(d.messageId)) throw fail('Message not found');
        const msg = await messages().findOne({ _id: new ObjectId(d.messageId), groupId: { $ne: null } });
        if (!msg) throw fail('Message not found');
        const g = await getGroupForMember(msg.groupId, me);

        const isAuthor = msg.sender === me;
        if (!isAuthor && !g.admins.includes(me)) throw fail('You can only delete your own messages');

        await messages().updateOne(
            { _id: msg._id },
            { $set: { deleted: true, text: '', image: null, audio: null, deletedAt: new Date() } }
        );
        await emitGroup(g, 'group-message-deleted', { messageId: String(msg._id), groupId: msg.groupId });
        return {};
    });

    on('update-group', async (d, me) => {
        const g = await getGroupForMember(String(d.groupId || ''), me);
        const isAdmin = g.admins.includes(me);
        const patch = {};
        const changes = [];

        const wantsSettingChange = 'announcementOnly' in d || 'membersCanEdit' in d;
        if (wantsSettingChange && !isAdmin) throw fail('Only group admins can change these settings');
        if (!isAdmin && !g.membersCanEdit) throw fail('Only group admins can edit this group');

        if ('name' in d) {
            const name = String(d.name || '').trim().slice(0, LIMITS.GROUP_NAME);
            if (!name) throw fail('The group needs a name');
            if (name !== g.name) {
                patch.name = name;
                changes.push(`${me} changed the group name to "${name}"`);
            }
        }
        if ('description' in d) {
            patch.description = String(d.description || '').slice(0, LIMITS.GROUP_DESC);
        }
        if ('photo' in d) {
            if (d.photo === null) patch.photo = null;
            else if (validDataUrl(d.photo, IMAGE_RE, LIMITS.IMAGE_CHARS)) {
                patch.photo = d.photo;
                changes.push(`${me} changed the group photo`);
            } else throw fail('That photo is too large or not supported');
        }
        if (typeof d.announcementOnly === 'boolean') {
            patch.announcementOnly = d.announcementOnly;
            changes.push(d.announcementOnly ? `${me} limited messages to admins` : `${me} allowed everyone to send messages`);
        }
        if (typeof d.membersCanEdit === 'boolean') patch.membersCanEdit = d.membersCanEdit;

        if (!Object.keys(patch).length) throw fail('Nothing to save');
        patch.updatedAt = new Date();
        await groups().updateOne({ _id: g._id }, { $set: patch });

        for (const text of changes) await groupSystemMessage(g, text);
        await emitGroup(g, 'groups-changed', {});
        return {};
    });

    on('add-group-members', async (d, me) => {
        const g = await getGroupForMember(String(d.groupId || ''), me);
        requireAdmin(g, me);

        const wanted = Array.isArray(d.members) ? [...new Set(d.members.map(String))] : [];
        const toAdd = [];
        for (const u of wanted) {
            if (!u || g.members.includes(u)) continue;
            if (await userExists(u)) toAdd.push(u);
        }
        if (!toAdd.length) throw fail('Choose people who are not already in the group');
        if (g.members.length + toAdd.length > LIMITS.GROUP_MEMBERS) {
            throw fail(`A group can have up to ${LIMITS.GROUP_MEMBERS} members`);
        }

        await groups().updateOne(
            { _id: g._id },
            { $addToSet: { members: { $each: toAdd } }, $set: { updatedAt: new Date() } }
        );
        const fresh = await groups().findOne({ _id: g._id });
        await groupSystemMessage(fresh, `${me} added ${toAdd.join(', ')}`);
        await emitGroup(fresh, 'groups-changed', {});
        return {};
    });

    on('remove-group-member', async (d, me) => {
        const g = await getGroupForMember(String(d.groupId || ''), me);
        requireAdmin(g, me);
        const target = String(d.target || '');
        if (!g.members.includes(target)) throw fail('That person is not in the group');
        if (target === g.createdBy) throw fail('The group creator cannot be removed');
        if (target === me) throw fail('Use Exit group to leave');

        await groups().updateOne(
            { _id: g._id },
            { $pull: { members: target, admins: target }, $set: { updatedAt: new Date() } }
        );
        const fresh = await groups().findOne({ _id: g._id });
        await groupSystemMessage(fresh, `${me} removed ${target}`);
        await emitGroup(fresh, 'groups-changed', {});
        emitToUser(target, 'groups-changed', {});
        return {};
    });

    on('set-group-admin', async (d, me) => {
        const g = await getGroupForMember(String(d.groupId || ''), me);
        requireAdmin(g, me);
        const target = String(d.target || '');
        if (!g.members.includes(target)) throw fail('That person is not in the group');

        if (d.admin === true) {
            await groups().updateOne({ _id: g._id }, { $addToSet: { admins: target }, $set: { updatedAt: new Date() } });
        } else {
            if (target === g.createdBy) throw fail('The group creator stays an admin');
            if (g.admins.length <= 1 && g.admins.includes(target)) throw fail('A group needs at least one admin');
            await groups().updateOne({ _id: g._id }, { $pull: { admins: target }, $set: { updatedAt: new Date() } });
        }

        const fresh = await groups().findOne({ _id: g._id });
        await groupSystemMessage(fresh, d.admin === true
            ? `${me} made ${target} an admin`
            : `${me} removed ${target} as admin`);
        await emitGroup(fresh, 'groups-changed', {});
        return {};
    });

    on('leave-group', async (d, me) => {
        const g = await getGroupForMember(String(d.groupId || ''), me);
        const remaining = g.members.filter(m => m !== me);

        if (!remaining.length) {
            await messages().deleteMany({ groupId: String(g._id) });
            await groups().deleteOne({ _id: g._id });
            return {};
        }

        const update = { $pull: { members: me, admins: me }, $set: { updatedAt: new Date() } };
        await groups().updateOne({ _id: g._id }, update);

        // Keep at least one admin
        const fresh = await groups().findOne({ _id: g._id });
        if (!fresh.admins.length) {
            await groups().updateOne({ _id: g._id }, { $addToSet: { admins: fresh.members[0] } });
        }

        const after = await groups().findOne({ _id: g._id });
        await groupSystemMessage(after, `${me} left the group`);
        await emitGroup(after, 'groups-changed', {});
        emitToUser(me, 'groups-changed', {});
        return {};
    });

    on('edit-message', async (d, me) => {
        if (!ObjectId.isValid(d.messageId)) throw fail('Message not found');
        const msg = await messages().findOne({ _id: new ObjectId(d.messageId) });
        if (!msg || msg.sender !== me || msg.deleted || msg.oneView || msg.image || msg.audio) {
            throw fail('You can only edit your own text messages');
        }
        const text = typeof d.text === 'string' ? d.text.trim().slice(0, LIMITS.TEXT) : '';
        if (!text) throw fail('Message cannot be empty');

        await messages().updateOne({ _id: msg._id }, { $set: { text, edited: true, editedAt: new Date() } });
        const payload = { messageId: String(msg._id), text, groupId: msg.groupId || null };

        if (msg.groupId) {
            const g = await getGroupForMember(msg.groupId, me);
            await emitGroup(g, 'message-edited', payload);
        } else {
            emitToUser(msg.receiver, 'message-edited', payload);
            emitToUser(me, 'message-edited', payload);
        }
        return {};
    });

    on('react-message', async (d, me) => {
        if (!ObjectId.isValid(d.messageId)) throw fail('Message not found');
        const msg = await messages().findOne({ _id: new ObjectId(d.messageId) });
        if (!msg || msg.deleted) throw fail('Message not found');

        let recipients;
        if (msg.groupId) {
            const g = await getGroupForMember(msg.groupId, me);
            recipients = g.members;
        } else {
            if (msg.sender !== me && msg.receiver !== me) throw fail('Message not found');
            recipients = [msg.sender, msg.receiver];
        }

        const emoji = typeof d.emoji === 'string' && d.emoji.length > 0 && d.emoji.length <= 8 ? d.emoji : null;
        const update = emoji
            ? { $set: { [`reactions.${me}`]: emoji } }
            : { $unset: { [`reactions.${me}`]: '' } };
        await messages().updateOne({ _id: msg._id }, update);

        const fresh = await messages().findOne({ _id: msg._id }, { projection: { reactions: 1 } });
        const payload = { messageId: String(msg._id), groupId: msg.groupId || null, reactions: fresh.reactions || {} };
        for (const r of new Set(recipients)) emitToUser(r, 'message-reaction', payload);
        return {};
    });

    on('star-message', async (d, me) => {
        if (!ObjectId.isValid(d.messageId)) throw fail('Message not found');
        const id = String(d.messageId);
        if (d.on === true) {
            await starred().updateOne(
                { owner: me, messageId: id },
                { $set: { owner: me, messageId: id, at: new Date() } },
                { upsert: true }
            );
        } else {
            await starred().deleteOne({ owner: me, messageId: id });
        }
        return {};
    });

    on('get-starred-ids', async (_d, me) => {
        const rows = await starred().find({ owner: me }, { projection: { messageId: 1 } }).limit(300).toArray();
        return { ids: rows.map(r => r.messageId) };
    });

    on('get-starred', async (_d, me) => {
        const rows = await starred().find({ owner: me }).sort({ at: -1 }).limit(300).toArray();
        const ids = rows.map(r => r.messageId).filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
        const docs = await messages().find({ _id: { $in: ids }, deleted: { $ne: true } }).toArray();

        const myGroups = await groups().find({ members: me }, { projection: { name: 1 } }).toArray();
        const groupNames = new Map(myGroups.map(g => [String(g._id), g.name]));

        const items = [];
        for (const m of docs) {
            const allowed = m.groupId ? groupNames.has(m.groupId) : (m.sender === me || m.receiver === me);
            if (!allowed) continue;
            const pub = m.groupId ? publicGroupMessage(m) : publicMessage(m);
            const partner = m.sender === me ? m.receiver : m.sender;
            items.push({ ...pub, chat: m.groupId ? (groupNames.get(m.groupId) || 'Group') : partner });
        }
        items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        return { messages: items };
    });

    on('get-media', async (d, me) => {
        const common = {
            deleted: { $ne: true },
            oneView: { $ne: true },
            hiddenFor: { $ne: me },
            $and: [{ $or: [{ image: { $ne: null } }, { audio: { $ne: null } }] }]
        };
        let query;
        if (d.groupId) {
            const g = await getGroupForMember(String(d.groupId), me);
            query = { ...common, groupId: String(g._id) };
        } else {
            const target = String(d.target || '');
            if (!target) throw fail('Invalid chat');
            query = {
                ...common,
                groupId: null,
                $and: [
                    ...common.$and,
                    { $or: [{ sender: me, receiver: target }, { sender: target, receiver: me }] }
                ]
            };
        }

        const list = await messages().find(query).sort({ timestamp: -1 }).limit(300).toArray();
        return {
            media: list.map(m => ({
                _id: String(m._id),
                image: m.image || null,
                audio: m.audio || null,
                audioDuration: m.audioDuration || 0,
                sender: m.sender,
                timestamp: m.timestamp
            }))
        };
    });

    // Channels: only admins post; followers read and react

    on('create-channel', async (d, me) => {
        const name = String(d.name || '').trim().slice(0, LIMITS.GROUP_NAME);
        if (!name) throw fail('Give the channel a name');
        const description = String(d.description || '').trim().slice(0, LIMITS.GROUP_DESC);
        const photo = d.photo || null;
        if (photo && !validDataUrl(photo, IMAGE_RE, LIMITS.IMAGE_CHARS)) throw fail('That photo is too large or not supported');

        const now = new Date();
        const result = await channels().insertOne({
            name, description, photo,
            createdBy: me,
            admins: [me],
            subscribers: [me],
            lastPost: null,
            createdAt: now,
            updatedAt: now
        });
        const c = await channels().findOne({ _id: result.insertedId });
        return { channel: channelView(c, me) };
    });

    on('explore-channels', async (d, me) => {
        const q = String(d.q || '').trim().slice(0, 40);
        const query = q ? { name: { $regex: escapeRegex(q), $options: 'i' } } : {};
        const list = await channels().find(query).sort({ createdAt: -1 }).limit(100).toArray();
        return { channels: list.map(c => channelView(c, me)) };
    });

    on('get-my-channels', async (_d, me) => {
        const list = await channels().find({ subscribers: me }).limit(200).toArray();
        list.sort((a, b) => new Date(b.lastPost?.timestamp || b.createdAt) - new Date(a.lastPost?.timestamp || a.createdAt));
        return { channels: list.map(c => channelView(c, me)) };
    });

    on('get-channel', async (d, me) => {
        const c = await getChannel(String(d.channelId || ''));
        return { channel: channelView(c, me) };
    });

    on('set-channel-subscription', async (d, me) => {
        const c = await getChannel(String(d.channelId || ''));
        if (d.on === true) {
            await channels().updateOne({ _id: c._id }, { $addToSet: { subscribers: me } });
        } else {
            if (c.createdBy === me) throw fail('The owner cannot unfollow. Delete the channel instead.');
            await channels().updateOne({ _id: c._id }, { $pull: { subscribers: me, admins: me } });
        }
        const fresh = await getChannel(String(c._id));
        return { channel: channelView(fresh, me) };
    });

    on('get-channel-posts', async (d, me) => {
        const c = await getChannel(String(d.channelId || ''));
        if (!(c.subscribers || []).includes(me)) throw fail('Follow this channel to see its posts');
        const list = await channelPosts().find({ channelId: String(c._id) })
            .sort({ timestamp: -1 }).limit(200).toArray();
        return { posts: list.reverse().map(p => publicPost(p, me)) };
    });

    on('post-channel', async (d, me) => {
        const c = await getChannel(String(d.channelId || ''));
        if (!(c.admins || []).includes(me)) throw fail('Only channel admins can post');

        const text = typeof d.text === 'string' ? d.text.trim().slice(0, LIMITS.TEXT) : '';
        const image = d.image || null;
        const audio = d.audio || null;
        if (!text && !image && !audio) throw fail('Post is empty');
        if (image && !validDataUrl(image, IMAGE_RE, LIMITS.IMAGE_CHARS)) throw fail('That photo is too large or not supported');
        if (audio && !validDataUrl(audio, AUDIO_RE, LIMITS.AUDIO_CHARS)) throw fail('That voice note is too long or not supported');

        const now = new Date();
        const doc = {
            channelId: String(c._id),
            sender: me,
            text, image, audio,
            audioDuration: Math.min(Math.max(Number(d.audioDuration) || 0, 0), LIMITS.AUDIO_SECONDS),
            reactions: {},
            deleted: false,
            timestamp: now
        };
        const result = await channelPosts().insertOne(doc);
        doc._id = result.insertedId;

        await channels().updateOne({ _id: c._id }, {
            $set: {
                updatedAt: now,
                lastPost: { text: text || (image ? 'Photo' : 'Voice message'), timestamp: now }
            }
        });

        await emitChannel(c, 'channel-post', { channelId: String(c._id), post: publicPost(doc, null) });
        return { post: publicPost(doc, me) };
    });

    on('delete-channel-post', async (d, me) => {
        if (!ObjectId.isValid(d.postId)) throw fail('Post not found');
        const p = await channelPosts().findOne({ _id: new ObjectId(d.postId) });
        if (!p) throw fail('Post not found');
        const c = await getChannel(p.channelId);
        if (!(c.admins || []).includes(me)) throw fail('Only channel admins can delete posts');

        await channelPosts().updateOne({ _id: p._id }, { $set: { deleted: true, text: '', image: null, audio: null } });
        await emitChannel(c, 'channel-post-deleted', { channelId: p.channelId, postId: String(p._id) });
        return {};
    });

    on('react-channel-post', async (d, me) => {
        if (!ObjectId.isValid(d.postId)) throw fail('Post not found');
        const p = await channelPosts().findOne({ _id: new ObjectId(d.postId) });
        if (!p || p.deleted) throw fail('Post not found');
        const c = await getChannel(p.channelId);
        if (!(c.subscribers || []).includes(me)) throw fail('Follow the channel to react');

        const emoji = typeof d.emoji === 'string' && d.emoji.length > 0 && d.emoji.length <= 8 ? d.emoji : null;
        await channelPosts().updateOne(
            { _id: p._id },
            emoji ? { $set: { [`reactions.${me}`]: emoji } } : { $unset: { [`reactions.${me}`]: '' } }
        );
        const fresh = await channelPosts().findOne({ _id: p._id });
        const view = publicPost(fresh, me);
        await emitChannel(c, 'channel-post-reaction', { postId: String(p._id), channelId: p.channelId, counts: view.counts });
        return { counts: view.counts, myReaction: view.myReaction };
    });

    on('update-channel', async (d, me) => {
        const c = await getChannel(String(d.channelId || ''));
        if (!(c.admins || []).includes(me)) throw fail('Only channel admins can edit the channel');

        const patch = { updatedAt: new Date() };
        if ('name' in d) {
            const name = String(d.name || '').trim().slice(0, LIMITS.GROUP_NAME);
            if (!name) throw fail('The channel needs a name');
            patch.name = name;
        }
        if ('description' in d) patch.description = String(d.description || '').slice(0, LIMITS.GROUP_DESC);
        if ('photo' in d) {
            if (d.photo === null) patch.photo = null;
            else if (validDataUrl(d.photo, IMAGE_RE, LIMITS.IMAGE_CHARS)) patch.photo = d.photo;
            else throw fail('That photo is too large or not supported');
        }

        await channels().updateOne({ _id: c._id }, { $set: patch });
        const fresh = await getChannel(String(c._id));
        await emitChannel(fresh, 'channels-changed', { channelId: String(c._id) });
        return { channel: channelView(fresh, me) };
    });

    on('set-channel-admin', async (d, me) => {
        const c = await getChannel(String(d.channelId || ''));
        if (c.createdBy !== me) throw fail('Only the channel owner can manage admins');
        const target = String(d.target || '');
        if (!(c.subscribers || []).includes(target)) throw fail('That person does not follow the channel');

        if (d.admin === true) {
            await channels().updateOne({ _id: c._id }, { $addToSet: { admins: target } });
        } else {
            if (target === c.createdBy) throw fail('The owner stays an admin');
            await channels().updateOne({ _id: c._id }, { $pull: { admins: target } });
        }
        const fresh = await getChannel(String(c._id));
        await emitChannel(fresh, 'channels-changed', { channelId: String(c._id) });
        return { channel: channelView(fresh, me) };
    });

    on('delete-channel', async (d, me) => {
        const c = await getChannel(String(d.channelId || ''));
        if (c.createdBy !== me) throw fail('Only the channel owner can delete it');
        await emitChannel(c, 'channel-deleted', { channelId: String(c._id) });
        await channelPosts().deleteMany({ channelId: String(c._id) });
        await channels().deleteOne({ _id: c._id });
        return {};
    });

    on('report-content', async (d, me) => {
        const reasons = ['spam', 'harassment', 'hate', 'violence', 'sexual', 'scam', 'other'];
        if (!reasons.includes(d.reason)) throw fail('Choose a reason for the report');

        const type = String(d.targetType || '');
        const id = String(d.targetId || '');
        let owner;
        let snapshot = {};

        if (type === 'message') {
            if (!ObjectId.isValid(id)) throw fail('Message not found');
            const m = await messages().findOne({ _id: new ObjectId(id), deleted: { $ne: true } });
            if (!m) throw fail('Message not found');
            if (m.groupId) await getGroupForMember(m.groupId, me);
            else if (m.sender !== me && m.receiver !== me) throw fail('Message not found');
            if (m.sender === me) throw fail('You cannot report your own message');
            owner = m.sender;
            snapshot = { text: m.text || '', image: m.image || null, audio: !!m.audio, chat: m.groupId ? 'Group' : 'Private chat' };
        } else if (type === 'status') {
            if (!ObjectId.isValid(id)) throw fail('Status not found');
            const s = await statuses().findOne({ _id: new ObjectId(id), expiresAt: { $gt: new Date() } });
            if (!s || !(await canSeeStatus(me, s))) throw fail('Status not found');
            if (s.user === me) throw fail('You cannot report your own status');
            owner = s.user;
            snapshot = { text: s.text || '', image: s.image || null };
        } else if (type === 'channel-post') {
            if (!ObjectId.isValid(id)) throw fail('Post not found');
            const p = await channelPosts().findOne({ _id: new ObjectId(id), deleted: { $ne: true } });
            if (!p) throw fail('Post not found');
            const c = await getChannel(p.channelId);
            if (!(c.subscribers || []).includes(me)) throw fail('Follow the channel to report its posts');
            owner = p.sender;
            snapshot = { text: p.text || '', image: p.image || null, channel: c.name };
        } else if (type === 'profile') {
            if (!(await userExists(id))) throw fail('User not found');
            if (id === me) throw fail('You cannot report yourself');
            owner = id;
            snapshot = { username: id };
        } else {
            throw fail('Nothing to report');
        }

        const already = await reports().findOne({ reporter: me, targetId: id, status: 'open' });
        if (already) return {};

        await reports().insertOne({
            reporter: me,
            targetType: type,
            targetId: id,
            targetUser: owner,
            reason: d.reason,
            snapshot,
            status: 'open',
            createdAt: new Date()
        });
        return {};
    });

    on('load-older', async (d, me) => {
        const before = d.before ? new Date(d.before) : new Date();
        if (d.groupId) {
            const g = await getGroupForMember(String(d.groupId), me);
            const list = await messages().find({
                groupId: String(g._id),
                hiddenFor: { $ne: me },
                timestamp: { $lt: before }
            }).sort({ timestamp: -1 }).limit(LIMITS.HISTORY).toArray();
            return { messages: list.reverse().map(publicGroupMessage), hasMore: list.length === LIMITS.HISTORY };
        }

        const target = String(d.target || '');
        if (!target) throw fail('Invalid chat');
        const list = await messages().find({
            groupId: null,
            hiddenFor: { $ne: me },
            timestamp: { $lt: before },
            $or: [{ sender: me, receiver: target }, { sender: target, receiver: me }]
        }).sort({ timestamp: -1 }).limit(LIMITS.HISTORY).toArray();
        return { messages: list.reverse().map(publicMessage), hasMore: list.length === LIMITS.HISTORY };
    });

    on('search-all', async (d, me) => {
        const q = String(d.q || '').trim().slice(0, 60);
        if (q.length < 2) return { results: [] };
        const re = { $regex: escapeRegex(q), $options: 'i' };
        const myGroups = await groups().find({ members: me }, { projection: { name: 1 } }).toArray();
        const groupIds = myGroups.map(g => String(g._id));
        const names = new Map(myGroups.map(g => [String(g._id), g.name]));

        const list = await messages().find({
            deleted: { $ne: true },
            hiddenFor: { $ne: me },
            text: re,
            $or: [
                { groupId: null, $or: [{ sender: me }, { receiver: me }] },
                { groupId: { $in: groupIds } }
            ]
        }).sort({ timestamp: -1 }).limit(40).toArray();

        return {
            results: list.map(m => ({
                _id: String(m._id),
                text: m.text || '',
                timestamp: m.timestamp,
                sender: m.sender,
                groupId: m.groupId || null,
                chat: m.groupId ? (names.get(m.groupId) || 'Group') : (m.sender === me ? m.receiver : m.sender)
            }))
        };
    });

    // Phone number can be changed; it is shown only to people who share a chat or group with the user
    on('change-phone', async (d, me) => {
        const phone = String(d.phone || '').trim();
        if (phone && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) throw fail('Enter a valid phone number');
        await users().updateOne({ username: me }, { $set: { phone: phone || null } });
        io.emit('profile-updated', { username: me });
        return { phone: phone || null };
    });

    on('set-activity', async (d, me) => {
        const kind = d.kind === 'recording' ? 'recording' : 'typing';
        const on = d.on === true;

        if (d.groupId) {
            const g = await getGroupForMember(String(d.groupId), me);
            for (const m of g.members) {
                if (m !== me) emitToUser(m, 'activity', { groupId: String(g._id), from: me, kind, on });
            }
        } else {
            const target = String(d.target || '');
            if (!target || target === me) return {};
            emitToUser(target, 'activity', { from: me, kind, on });
        }
        return {};
    });

    on('mark-group-read', async (d, me) => {
        const g = await getGroupForMember(String(d.groupId || ''), me);
        await groups().updateOne({ _id: g._id }, { $set: { [`readMarks.${me}`]: new Date() } });
        return {};
    });

    on('clear-group-chat', async (d, me) => {
        const g = await getGroupForMember(String(d.groupId || ''), me);
        await messages().updateMany({ groupId: String(g._id) }, { $addToSet: { hiddenFor: me } });
        emitToUser(me, 'group-cleared', { groupId: String(g._id) });
        return {};
    });

    on('delete-group', async (d, me) => {
        const g = await getGroupForMember(String(d.groupId || ''), me);
        requireAdmin(g, me);
        const id = String(g._id);
        const members = [...g.members];
        await messages().deleteMany({ groupId: id });
        await groups().deleteOne({ _id: g._id });
        for (const m of members) emitToUser(m, 'group-deleted', { groupId: id });
        return {};
    });

    on('add-status', async (d, me) => {
        const text = typeof d.text === 'string' ? d.text.trim().slice(0, LIMITS.STATUS_TEXT) : '';
        const image = d.image || null;
        const bg = STATUS_BACKGROUNDS.includes(d.bg) ? d.bg : STATUS_BACKGROUNDS[0];

        if (!text && !image) throw fail('Add some text or a photo');
        if (image && !validDataUrl(image, IMAGE_RE, LIMITS.IMAGE_CHARS)) throw fail('That photo is too large or not supported');

        const now = new Date();
        await statuses().insertOne({
            user: me,
            text,
            image,
            bg,
            audience: (await getSettings(me)).privacy?.status === 'everyone' ? 'everyone' : 'contacts',
            views: [],
            likes: [],
            timestamp: now,
            expiresAt: new Date(now.getTime() + STATUS_TTL_MS)
        });
        io.emit('new-status', { user: me });
        return {};
    });

    on('get-statuses', async (_d, me) => {
        const list = await filterVisibleStatuses(me, await statuses().find({ expiresAt: { $gt: new Date() } })
            .sort({ timestamp: 1 }).limit(LIMITS.STATUS_LIST).toArray());

        // Profiles needed for the owners, and for the people who viewed or liked my statuses
        const names = new Set();
        for (const s of list) {
            names.add(s.user);
            if (s.user === me) {
                (s.views || []).forEach(v => names.add(v.username));
                (s.likes || []).forEach(n => names.add(n));
            }
        }
        const profiles = {};
        for (const name of names) profiles[name] = await buildProfile(me, name);

        return {
            statuses: list.map(s => {
                const views = s.views || [];
                const likes = s.likes || [];
                const mine = s.user === me;
                return {
                    _id: String(s._id),
                    user: s.user,
                    text: s.text || '',
                    hasImage: !!s.image,
                    image: null,
                    bg: s.bg || STATUS_BACKGROUNDS[0],
                    timestamp: s.timestamp,
                    expiresAt: s.expiresAt,
                    viewCount: views.length,
                    likeCount: likes.length,
                    viewedByMe: views.some(v => v.username === me),
                    likedByMe: likes.includes(me),
                    // Only the owner can see who viewed and liked a status
                    viewers: mine ? views.map(v => ({ username: v.username, at: v.at })).reverse() : undefined,
                    likers: mine ? likes : undefined
                };
            }),
            profiles
        };
    });

    on('get-status-image', async (d, me) => {
        if (!ObjectId.isValid(d.statusId)) throw fail('Status not found');
        const s = await statuses().findOne(
            { _id: new ObjectId(d.statusId), expiresAt: { $gt: new Date() } },
            { projection: { image: 1, user: 1, audience: 1 } }
        );
        if (!s || !(await canSeeStatus(me, s))) throw fail('Status not found');
        return { image: s.image || null };
    });

    on('view-status', async (d, me) => {
        if (!ObjectId.isValid(d.statusId)) throw fail('Status not found');
        const id = new ObjectId(d.statusId);
        const status = await statuses().findOne(
            { _id: id, expiresAt: { $gt: new Date() } },
            { projection: { user: 1, audience: 1 } }
        );
        if (!status || !(await canSeeStatus(me, status))) throw fail('Status not found');
        if (status.user === me) return {};

        await statuses().updateOne(
            { _id: id, 'views.username': { $ne: me } },
            { $push: { views: { username: me, at: new Date() } } }
        );
        emitToUser(status.user, 'status-activity', { statusId: String(id) });
        return {};
    });

    on('like-status', async (d, me) => {
        if (!ObjectId.isValid(d.statusId)) throw fail('Status not found');
        const id = new ObjectId(d.statusId);
        const status = await statuses().findOne(
            { _id: id, expiresAt: { $gt: new Date() } },
            { projection: { user: 1, audience: 1 } }
        );
        if (!status || !(await canSeeStatus(me, status))) throw fail('Status not found');
        if (status.user === me) throw fail('You cannot like your own status');

        if (d.liked === true) {
            await statuses().updateOne({ _id: id }, { $addToSet: { likes: me } });
        } else {
            await statuses().updateOne({ _id: id }, { $pull: { likes: me } });
        }
        emitToUser(status.user, 'status-activity', { statusId: String(id) });
        return {};
    });

    on('delete-status', async (d, me) => {
        if (!ObjectId.isValid(d.statusId)) throw fail('Status not found');
        const result = await statuses().deleteOne({ _id: new ObjectId(d.statusId), user: me });
        if (!result.deletedCount) throw fail('Status not found');
        io.emit('new-status', { user: me });
        return {};
    });

    on('delete-account', async (_d, me) => {
        await users().deleteOne({ username: me });
        await messages().deleteMany({ $or: [{ sender: me }, { receiver: me }] });
        await settingsCol().deleteOne({ username: me });
        await statuses().deleteMany({ user: me });
        await chatPrefs().deleteMany({ $or: [{ owner: me }, { partner: me }] });
        await groups().updateMany({ members: me }, { $pull: { members: me, admins: me } });
        emitToUser(me, 'account-deleted', {});
        return {};
    });

    socket.on('disconnect', async () => {
        const left = (onlineCounts.get(me) || 1) - 1;
        if (left > 0) {
            onlineCounts.set(me, left);
            return;
        }
        onlineCounts.delete(me);
        try {
            await users().updateOne({ username: me }, { $set: { lastSeen: new Date() } });
        } catch (err) {
            console.error('Disconnect error:', err);
        }
        io.emit('presence-changed', { username: me });
    });
});

// Start

connectToDatabase()
    .then(() => {
        server.listen(PORT, () => {
            console.log(`${APP_NAME} server running on port ${PORT}`);
            console.log(`Open http://localhost:${PORT} in your browser`);
        });
    })
    .catch((err) => {
        console.error('Failed to connect to MongoDB:', err);
        process.exit(1);
    });

process.on('SIGINT', async () => {
    console.log('Shutting down...');
    if (mongoClient) await mongoClient.close();
    process.exit(0);
});
