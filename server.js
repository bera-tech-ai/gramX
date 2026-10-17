require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'gramXDB';
const PORT = process.env.PORT || 3000;

if (!MONGODB_URI) {
    console.error('MONGODB_URI is not set. Add it to your .env file or your hosting environment.');
    process.exit(1);
}

const COLLECTIONS = {
    USERS: 'users',
    MESSAGES: 'messages',
    USER_SETTINGS: 'user_settings',
    STATUSES: 'statuses'
};

const LIMITS = {
    TEXT: 2000,
    STATUS_TEXT: 500,
    NAME: 40,
    ABOUT: 140,
    IMAGE_CHARS: 3 * 1024 * 1024,
    PASSWORD_MIN: 6,
    PASSWORD_MAX: 100,
    HISTORY: 500
};

const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const IMAGE_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,/;
const PRIVACY_VALUES = ['everyone', 'contacts', 'nobody'];
const THEMES = ['light', 'dark', 'auto'];

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5 * 1024 * 1024 });

app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db;
let mongoClient;

const users = () => db.collection(COLLECTIONS.USERS);
const messages = () => db.collection(COLLECTIONS.MESSAGES);
const settingsCol = () => db.collection(COLLECTIONS.USER_SETTINGS);
const statuses = () => db.collection(COLLECTIONS.STATUSES);

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
    await statuses().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await statuses().createIndex({ user: 1, timestamp: -1 });

    console.log('Connected to MongoDB');
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
    } catch (e) {
        return false;
    }
}

// Helpers

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isValidImage(value) {
    return typeof value === 'string' && value.length <= LIMITS.IMAGE_CHARS && IMAGE_RE.test(value);
}

async function userExists(username) {
    return !!(await users().findOne({ username }, { projection: { _id: 1 } }));
}

async function eitherBlocked(a, b) {
    const found = await settingsCol().findOne({
        $or: [{ username: a, blockedUsers: b }, { username: b, blockedUsers: a }]
    }, { projection: { _id: 1 } });
    return !!found;
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

function defaultSettings() {
    return {
        theme: 'auto',
        notifications: true,
        sound: true,
        privacy: { lastSeen: 'everyone', profilePhoto: 'everyone', readReceipts: true },
        avatar: 'default1',
        customAvatar: null,
        customBackground: null,
        twoStep: false,
        mutedChats: [],
        blockedUsers: [],
        displayName: null,
        about: 'Hey there! I am using gramX.',
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

    if (input.displayName !== undefined) {
        patch.displayName = input.displayName === null
            ? null
            : (String(input.displayName).trim().slice(0, LIMITS.NAME) || null);
    }
    if (input.about !== undefined) {
        patch.about = String(input.about ?? '').slice(0, LIMITS.ABOUT);
    }
    if (input.avatar !== undefined) {
        patch.avatar = String(input.avatar).slice(0, 20);
    }
    if (input.customAvatar !== undefined) {
        if (input.customAvatar === null) patch.customAvatar = null;
        else if (isValidImage(input.customAvatar)) patch.customAvatar = input.customAvatar;
        else throw fail('That profile photo is too large or not supported');
    }
    if (input.customBackground !== undefined) {
        if (input.customBackground === null) patch.customBackground = null;
        else if (isValidImage(input.customBackground)) patch.customBackground = input.customBackground;
        else throw fail('That wallpaper is too large or not supported');
    }
    if (THEMES.includes(input.theme)) patch.theme = input.theme;
    if (typeof input.notifications === 'boolean') patch.notifications = input.notifications;
    if (typeof input.sound === 'boolean') patch.sound = input.sound;
    if (typeof input.twoStep === 'boolean') patch.twoStep = input.twoStep;

    if (input.privacy && typeof input.privacy === 'object') {
        if (PRIVACY_VALUES.includes(input.privacy.lastSeen)) patch['privacy.lastSeen'] = input.privacy.lastSeen;
        if (PRIVACY_VALUES.includes(input.privacy.profilePhoto)) patch['privacy.profilePhoto'] = input.privacy.profilePhoto;
        if (typeof input.privacy.readReceipts === 'boolean') patch['privacy.readReceipts'] = input.privacy.readReceipts;
    }
    return patch;
}

// Visibility and profiles

async function visibleTo(viewer, owner, setting) {
    if (viewer === owner || setting === 'everyone') return true;
    if (setting === 'nobody') return false;
    const chatted = await messages().findOne({
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
    return { ...base, text: m.text || '', image: m.image || null };
}

// Conversations

async function getConversations(me) {
    const rows = await messages().aggregate([
        { $match: { $or: [{ sender: me }, { receiver: me }], hiddenFor: { $ne: me } } },
        { $addFields: { partner: { $cond: [{ $eq: ['$sender', me] }, '$receiver', '$sender'] } } },
        { $sort: { timestamp: -1 } },
        {
            $group: {
                _id: '$partner',
                last: { $first: '$$ROOT' },
                unread: {
                    $sum: { $cond: [{ $and: [{ $eq: ['$receiver', me] }, { $eq: ['$read', false] }] }, 1, 0] }
                }
            }
        },
        { $sort: { 'last.timestamp': -1 } },
        { $limit: 200 }
    ]).toArray();

    const result = [];
    for (const row of rows) {
        const profile = await buildProfile(me, row._id);
        result.push({
            partner: row._id,
            profile,
            lastMessage: {
                text: row.last.deleted ? '' : (row.last.text || ''),
                hasImage: !!row.last.image && !row.last.deleted,
                deleted: !!row.last.deleted,
                sender: row.last.sender,
                timestamp: row.last.timestamp
            },
            unreadCount: row.unread
        });
    }
    return result;
}

async function markReadFrom(partner, me) {
    const settings = await getSettings(me);
    const unread = await messages().find(
        { sender: partner, receiver: me, read: false },
        { projection: { _id: 1 } }
    ).toArray();
    if (!unread.length) return;

    const ids = unread.map(m => m._id);
    await messages().updateMany({ _id: { $in: ids } }, { $set: { read: true, readAt: new Date() } });

    if (settings.privacy?.readReceipts) {
        emitToUser(partner, 'messages-read', { reader: me, messageIds: ids.map(String) });
    }
}

async function markDeliveredFor(me) {
    const pending = await messages().find(
        { receiver: me, delivered: false },
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

// Auth middleware for HTTP routes

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

        if (!USERNAME_RE.test(username)) {
            return res.json({ success: false, error: 'Usernames use 3 to 20 letters, numbers, or underscores' });
        }
        if (password.length < LIMITS.PASSWORD_MIN || password.length > LIMITS.PASSWORD_MAX) {
            return res.json({ success: false, error: 'Password must be 6 to 100 characters' });
        }

        await users().insertOne({
            username,
            passwordHash: hashPassword(password),
            sessionToken: null,
            createdAt: new Date(),
            lastSeen: new Date()
        });
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
            // Accounts created before hashing: upgrade the stored password on first login
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
            .limit(500).toArray();
        const profiles = [];
        for (const u of list) profiles.push(await buildProfile(me, u.username));
        res.json({ success: true, users: profiles });
    } catch (err) {
        console.error('Users error:', err);
        res.status(500).json({ success: false, error: 'Could not load users' });
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

    // Wraps a handler: runs fn(payload, me) and replies through the ack callback if one was sent
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
        if (await eitherBlocked(me, target)) throw fail("You can't message this user");

        const history = await messages().find({
            $or: [{ sender: me, receiver: target }, { sender: target, receiver: me }],
            hiddenFor: { $ne: me }
        }).sort({ timestamp: 1 }).limit(LIMITS.HISTORY).toArray();

        const profile = await buildProfile(me, target);
        await markReadFrom(target, me);

        return { profile, messages: history.map(publicMessage) };
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

        if (!receiver || receiver === me) throw fail('Choose someone to message');
        if (!text && !image) throw fail('Message is empty');
        if (image && !isValidImage(image)) throw fail('That photo is too large or not supported');
        if (!(await userExists(receiver))) throw fail('User not found');
        if (await eitherBlocked(me, receiver)) throw fail("You can't message this user");

        const online = isOnline(receiver);
        const doc = {
            sender: me,
            receiver,
            text,
            image,
            timestamp: new Date(),
            read: false,
            readAt: null,
            delivered: online,
            deliveredAt: online ? new Date() : null,
            deleted: false,
            hiddenFor: []
        };
        const result = await messages().insertOne(doc);
        doc._id = result.insertedId;
        const message = publicMessage(doc);

        emitToUser(me, 'message-saved', { tempId: d.tempId, message });
        if (online) {
            emitToUser(receiver, 'new-private-message', message);
            emitToUser(me, 'message-delivered', { messageIds: [String(doc._id)] });
        }
        return { message };
    });

    on('delete-message', async (d, me) => {
        if (!ObjectId.isValid(d.messageId)) throw fail('Message not found');
        const id = new ObjectId(d.messageId);
        const msg = await messages().findOne({ _id: id });
        if (!msg || msg.sender !== me) throw fail('You can only delete your own messages');

        await messages().updateOne(
            { _id: id },
            { $set: { deleted: true, text: '', image: null, deletedAt: new Date() } }
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
            { $or: [{ sender: me, receiver: target }, { sender: target, receiver: me }] },
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

    on('add-status', async (d, me) => {
        const text = typeof d.text === 'string' ? d.text.trim().slice(0, LIMITS.STATUS_TEXT) : '';
        const image = d.image || null;
        if (!text && !image) throw fail('Add some text or a photo');
        if (image && !isValidImage(image)) throw fail('That photo is too large or not supported');

        const now = new Date();
        await statuses().insertOne({
            user: me,
            text,
            image,
            timestamp: now,
            expiresAt: new Date(now.getTime() + STATUS_TTL_MS)
        });
        io.emit('new-status', { user: me });
        return {};
    });

    on('get-statuses', async (_d, me) => {
        const list = await statuses().find({ expiresAt: { $gt: new Date() } })
            .sort({ timestamp: 1 }).limit(300).toArray();

        const owners = [...new Set(list.map(s => s.user))];
        const profiles = {};
        for (const owner of owners) profiles[owner] = await buildProfile(me, owner);

        return {
            statuses: list.map(s => ({
                _id: String(s._id),
                user: s.user,
                text: s.text || '',
                image: s.image || null,
                timestamp: s.timestamp,
                expiresAt: s.expiresAt
            })),
            profiles
        };
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
            console.log(`gramX server running on port ${PORT}`);
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
