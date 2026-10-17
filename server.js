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
    GROUPS: 'groups'
};

const LIMITS = {
    TEXT: 2000,
    STATUS_TEXT: 500,
    NAME: 40,
    ABOUT: 140,
    PASSWORD_MIN: 6,
    PASSWORD_MAX: 100,
    HISTORY: 500,
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

    console.log(`Connected to MongoDB (${DB_NAME})`);
}

// Passwords

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

async function buildProfile(viewer, username, settings) {
    const s = settings || await getSettings(username);
    const photoOk = await visibleTo(viewer, username, s.privacy?.profilePhoto || 'everyone');
    const seenOk = await visibleTo(viewer, username, s.privacy?.lastSeen || 'everyone');

    let lastSeen = null;
    if (seenOk) {
        const u = await users().findOne({ username }, { projection: { lastSeen: 1 } });
        lastSeen = u?.lastSeen || null;
    }

    return {
        username,
        displayName: s.displayName || username,
        about: s.about || '',
        avatar: s.avatar || 'default1',
        customAvatar: photoOk ? (s.customAvatar || null) : null,
        lastSeen,
        online: seenOk && isOnline(username)
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
        opened: false
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
        audioDuration: m.audioDuration || 0
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
    const result = [];

    for (const row of rows) {
        const profile = await buildProfile(me, row._id);
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

        await users().insertOne({
            username,
            passwordHash: hashPassword(password),
            fullName: fullName || null,
            phone: phone || null,
            sessionToken: null,
            createdAt: new Date(),
            lastSeen: new Date()
        });

        await settingsCol().insertOne({ username, ...defaultSettings(fullName || null) });
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
        for (const m of g.members) profiles[m] = await buildProfile(me, m);
        return { group: groupView(g, me), profiles };
    });

    on('join-group', async (d, me) => {
        const g = await getGroupForMember(String(d.groupId || ''), me);
        const id = String(g._id);
        const history = await messages().find({ groupId: id, hiddenFor: { $ne: me } })
            .sort({ timestamp: -1 }).limit(LIMITS.GROUP_HISTORY).toArray();

        await groups().updateOne({ _id: g._id }, { $set: { [`readMarks.${me}`]: new Date() } });

        const profiles = {};
        for (const m of g.members) profiles[m] = await buildProfile(me, m);

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
            timestamp: new Date(),
            deleted: false,
            hiddenFor: []
        };
        const result = await messages().insertOne(doc);
        doc._id = result.insertedId;
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
            views: [],
            likes: [],
            timestamp: now,
            expiresAt: new Date(now.getTime() + STATUS_TTL_MS)
        });
        io.emit('new-status', { user: me });
        return {};
    });

    on('get-statuses', async (_d, me) => {
        const list = await statuses().find({ expiresAt: { $gt: new Date() } })
            .sort({ timestamp: 1 }).limit(LIMITS.STATUS_LIST).toArray();

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
                    image: s.image || null,
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

    on('view-status', async (d, me) => {
        if (!ObjectId.isValid(d.statusId)) throw fail('Status not found');
        const id = new ObjectId(d.statusId);
        const status = await statuses().findOne(
            { _id: id, expiresAt: { $gt: new Date() } },
            { projection: { user: 1 } }
        );
        if (!status) throw fail('Status not found');
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
            { projection: { user: 1 } }
        );
        if (!status) throw fail('Status not found');
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
