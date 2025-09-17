const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.json());
app.use(express.static('public'));

// MongoDB Connection Setup
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://ellyongiro8:QwXDXE6tyrGpUTNb@cluster0.tyxcmm9.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const DB_NAME = 'gramXDB';
const COLLECTIONS = {
    USERS: 'users',
    MESSAGES: 'messages',
    CONVERSATIONS: 'conversations',
    USER_SETTINGS: 'user_settings',
    BLOCKED_USERS: 'blocked_users',
    STATUSES: 'statuses'
};

let db;
let mongoClient;

// Connect to MongoDB
async function connectToDatabase() {
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        console.log('✅ Connected successfully to MongoDB Atlas');
        
        db = client.db(DB_NAME);
        mongoClient = client;
        
        // Create indexes for better performance
        await db.collection(COLLECTIONS.USERS).createIndex({ username: 1 }, { unique: true });
        await db.collection(COLLECTIONS.MESSAGES).createIndex({ conversationId: 1, timestamp: 1 });
        await db.collection(COLLECTIONS.MESSAGES).createIndex({ receiver: 1, read: 1 });
        await db.collection(COLLECTIONS.MESSAGES).createIndex({ sender: 1, receiver: 1 });
        await db.collection(COLLECTIONS.USER_SETTINGS).createIndex({ username: 1 }, { unique: true });
        
        return client;
    } catch (error) {
        console.error('❌ Failed to connect to MongoDB', error);
        process.exit(1);
    }
}

// In-memory storage for active users and typing status
const activeUsers = new Map(); // socket.id -> {username, userId}
const userSockets = new Map(); // username -> socket.id
const typingUsers = new Map(); // conversationId -> Set of usernames who are typing

// Generate conversation ID for two users
function getConversationId(user1, user2) {
    return [user1, user2].sort().join('_');
}

// Get user's conversation partners from DB
async function getUserConversations(username) {
    try {
        const userConversations = [];
        
        // Get all unique conversation partners
        const conversations = await db.collection(COLLECTIONS.MESSAGES)
            .aggregate([
                { 
                    $match: { 
                        $or: [{ sender: username }, { receiver: username }] 
                    } 
                },
                { 
                    $group: { 
                        _id: "$conversationId",
                        lastMessage: { $last: "$$ROOT" },
                        unreadCount: {
                            $sum: {
                                $cond: [
                                    { 
                                        $and: [
                                            { $eq: ["$receiver", username] },
                                            { $eq: ["$read", false] }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        }
                    } 
                }
            ])
            .toArray();

        for (const conv of conversations) {
            const conversationId = conv._id;
            const usersInConv = conversationId.split('_');
            const partner = usersInConv.find(user => user !== username);
            
            if (partner) {
                const partnerSetting = await db.collection(COLLECTIONS.USER_SETTINGS).findOne({ username: partner });
                userConversations.push({
                    partner,
                    lastMessage: conv.lastMessage ? {
                        text: conv.lastMessage.text,
                        timestamp: conv.lastMessage.timestamp,
                        sender: conv.lastMessage.sender
                    } : null,
                    unreadCount: conv.unreadCount,
                    avatar: partnerSetting?.avatar,
                    customAvatar: partnerSetting?.customAvatar
                });
            }
        }
        
        return userConversations.sort((a, b) => {
            const timeA = a.lastMessage ? new Date(a.lastMessage.timestamp) : new Date(0);
            const timeB = b.lastMessage ? new Date(b.lastMessage.timestamp) : new Date(0);
            return timeB - timeA;
        });
    } catch (error) {
        console.error('Error getting user conversations:', error);
        return [];
    }
}

// Get user settings or create default if not exists
async function getUserSettings(username) {
    try {
        let settings = await db.collection(COLLECTIONS.USER_SETTINGS).findOne({ username });
        
        if (!settings) {
            // Create default settings
            const defaultSettings = {
                username,
                theme: 'light',
                notifications: true,
                sound: true,
                privacy: {
                    lastSeen: 'everyone',
                    profilePhoto: 'everyone',
                    readReceipts: true
                },
                avatar: 'default1',
                customAvatar: null,
                customBackground: null,
                twoStep: false,
                mutedChats: [],
                blockedUsers: [],
                displayName: username,
                about: 'Hey there! I am using gramX.',
                createdAt: new Date(),
                updatedAt: new Date()
            };
            
            await db.collection(COLLECTIONS.USER_SETTINGS).insertOne(defaultSettings);
            settings = defaultSettings;
        }
        
        return settings;
    } catch (error) {
        console.error('Error getting user settings:', error);
        return null;
    }
}

// Check if user is blocked
async function isBlocked(blocker, blocked) {
    try {
        const settings = await db.collection(COLLECTIONS.USER_SETTINGS).findOne({ 
            username: blocker,
            blockedUsers: blocked 
        });
        return !!settings;
    } catch (error) {
        console.error('Error checking block status:', error);
        return false;
    }
}

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API Routes
app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.json({ success: false, error: 'Username and password are required' });
        }
        
        // Check if user already exists
        const existingUser = await db.collection(COLLECTIONS.USERS).findOne({ username });
        if (existingUser) {
            return res.json({ success: false, error: 'Username taken' });
        }
        
        // Create new user
        await db.collection(COLLECTIONS.USERS).insertOne({
            username,
            password, // In production, hash this password!
            createdAt: new Date(),
            lastSeen: new Date()
        });
        
        res.json({ success: true, username });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Registration failed' });
    }
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.json({ success: false, error: 'Username and password are required' });
        }
        
        const user = await db.collection(COLLECTIONS.USERS).findOne({ username, password });
        if (user) {
            // Update last seen
            await db.collection(COLLECTIONS.USERS).updateOne(
                { username },
                { $set: { lastSeen: new Date() } }
            );
            
            res.json({ success: true, username });
        } else {
            res.json({ success: false, error: 'Invalid credentials' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: 'Login failed' });
    }
});

// Get online users
app.get('/online-users', (req, res) => {
    const onlineUsers = Array.from(activeUsers.values()).map(user => user.username);
    res.json({ users: onlineUsers });
});

// Get user's conversations
app.get('/user-conversations/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const conversations = await getUserConversations(username);
        res.json({ conversations });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get conversations' });
    }
});

// Search messages
app.get('/search-messages/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const { query, conversationId } = req.query;
        
        if (!query) {
            return res.json({ messages: [] });
        }
        
        let searchFilter = { 
            $text: { $search: query } 
        };
        
        if (conversationId) {
            searchFilter.conversationId = conversationId;
        } else {
            // Search across all user's conversations
            searchFilter.$or = [
                { sender: username },
                { receiver: username }
            ];
        }
        
        const messages = await db.collection(COLLECTIONS.MESSAGES)
            .find(searchFilter)
            .sort({ timestamp: -1 })
            .limit(50)
            .toArray();
        
        res.json({ messages });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Search failed' });
    }
});

// Get user settings
app.get('/user-settings/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const settings = await getUserSettings(username);
        res.json({ success: true, settings });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to get settings' });
    }
});

// Update user settings
app.post('/user-settings/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const { settings } = req.body;
        
        await db.collection(COLLECTIONS.USER_SETTINGS).updateOne(
            { username },
            { 
                $set: { 
                    ...settings,
                    updatedAt: new Date()
                } 
            },
            { upsert: true }
        );
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to update settings' });
    }
});

// Block user
app.post('/block-user/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const { userToBlock } = req.body;
        
        await db.collection(COLLECTIONS.USER_SETTINGS).updateOne(
            { username },
            { 
                $addToSet: { blockedUsers: userToBlock },
                $set: { updatedAt: new Date() }
            },
            { upsert: true }
        );
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to block user' });
    }
});

// Unblock user
app.post('/unblock-user/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const { userToUnblock } = req.body;
        
        await db.collection(COLLECTIONS.USER_SETTINGS).updateOne(
            { username },
            { 
                $pull: { blockedUsers: userToUnblock },
                $set: { updatedAt: new Date() }
            }
        );
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to unblock user' });
    }
});

// Get blocked users
app.get('/blocked-users/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const settings = await getUserSettings(username);
        res.json({ success: true, blockedUsers: settings.blockedUsers || [] });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to get blocked users' });
    }
});

// Get users
app.get('/users', async (req, res) => {
    try {
        const users = await db.collection(COLLECTIONS.USERS).find({}).toArray();
        const settings = await db.collection(COLLECTIONS.USER_SETTINGS).find({}).toArray();
        const merged = users.map(u => {
            const s = settings.find(s => s.username === u.username) || {};
            return {
                username: u.username,
                displayName: s.displayName,
                about: s.about,
                avatar: s.avatar,
                customAvatar: s.customAvatar
            };
        });
        res.json(merged);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get users' });
    }
});

// Socket.io handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('user-login', async (username) => {
        try {
            const userData = { username, userId: socket.id };
            activeUsers.set(socket.id, userData);
            userSockets.set(username, socket.id);
            
            // Update last seen
            await db.collection(COLLECTIONS.USERS).updateOne(
                { username },
                { $set: { lastSeen: new Date() } }
            );
            
            // Notify all users about new online user
            io.emit('user-online', username);
            
            // Send list of online users to the new user
            const onlineUsers = Array.from(activeUsers.values()).map(user => user.username);
            socket.emit('online-users', onlineUsers);
            
            // Send user's conversation history
            const userConversations = await getUserConversations(username);
            socket.emit('user-conversations', userConversations);
            
        } catch (error) {
            console.error('Login error:', error);
        }
    });

    socket.on('get-user-settings', async (username, callback) => {
        callback(await getUserSettings(username));
    });

    socket.on('update-user-settings', async (data) => {
        const { username, settings } = data;
        await db.collection(COLLECTIONS.USER_SETTINGS).updateOne({ username }, { $set: settings });
    });

    socket.on('join-conversation', async ({ currentUser, targetUser }) => {
        try {
            const conversationId = getConversationId(currentUser, targetUser);
            
            // Check if users are blocked
            const isUserBlocked = await isBlocked(targetUser, currentUser);
            const isTargetBlocked = await isBlocked(currentUser, targetUser);
            
            if (isUserBlocked || isTargetBlocked) {
                socket.emit('conversation-error', { 
                    error: 'Cannot message this user' 
                });
                return;
            }
            
            // Get conversation messages from DB
            const conversationMessages = await db.collection(COLLECTIONS.MESSAGES)
                .find({ conversationId })
                .sort({ timestamp: 1 })
                .toArray();
            
            // Mark messages as read when user opens conversation
            if (conversationMessages.length > 0) {
                await db.collection(COLLECTIONS.MESSAGES).updateMany(
                    { 
                        conversationId, 
                        receiver: currentUser, 
                        read: false 
                    },
                    { $set: { read: true, readAt: new Date() } }
                );
                
                // Notify sender that messages were read
                const unreadMessages = conversationMessages.filter(m => 
                    m.receiver === currentUser && !m.read
                );
                
                if (unreadMessages.length > 0) {
                    const targetSocketId = userSockets.get(targetUser);
                    if (targetSocketId) {
                        io.to(targetSocketId).emit('messages-read', {
                            conversationId,
                            reader: currentUser,
                            messageIds: unreadMessages.map(m => m._id)
                        });
                    }
                }
            }

            socket.emit('conversation-history', {
                conversationId,
                messages: conversationMessages,
                targetUser: targetUser
            });
            
        } catch (error) {
            console.error('Join conversation error:', error);
            socket.emit('conversation-error', { error: 'Failed to load conversation' });
        }
    });

    socket.on('send-private-message', async (data) => {
        try {
            const { sender, receiver, text } = data;
            
            // Check if users are blocked
            const isUserBlocked = await isBlocked(receiver, sender);
            const isTargetBlocked = await isBlocked(sender, receiver);
            
            if (isUserBlocked || isTargetBlocked) {
                socket.emit('message-error', { 
                    error: 'Cannot send message to this user' 
                });
                return;
            }
            
            const conversationId = getConversationId(sender, receiver);
            
            const message = {
                text,
                sender,
                receiver,
                timestamp: new Date(),
                conversationId,
                read: false,
                delivered: false
            };

            // Save message to database
            const result = await db.collection(COLLECTIONS.MESSAGES).insertOne(message);
            message._id = result.insertedId;
            
            // Send to sender immediately with temporary ID
            const tempMessage = { ...message, tempId: data.tempId };
            socket.emit('new-private-message', tempMessage);
            
            // Update sender's conversation list
            try {
                const senderConversations = await getUserConversations(sender);
                socket.emit('user-conversations', senderConversations);
            } catch (error) {
                console.error('Error updating sender conversations:', error);
            }

            // Send to receiver if online
            const receiverSocketId = userSockets.get(receiver);
            if (receiverSocketId) {
                // Mark as delivered
                await db.collection(COLLECTIONS.MESSAGES).updateOne(
                    { _id: message._id },
                    { $set: { delivered: true, deliveredAt: new Date() } }
                );
                
                message.delivered = true;
                io.to(receiverSocketId).emit('new-private-message', message);
                
                // Update receiver's conversation list
                try {
                    const receiverConversations = await getUserConversations(receiver);
                    io.to(receiverSocketId).emit('user-conversations', receiverConversations);
                } catch (error) {
                    console.error('Error updating receiver conversations:', error);
                }
                
                // Send delivery confirmation to sender
                socket.emit('message-delivered', { 
                    messageId: message._id,
                    tempId: data.tempId 
                });
            }
            
        } catch (error) {
            console.error('Error sending message:', error);
            socket.emit('message-error', { error: 'Failed to send message' });
        }
    });

    socket.on('typing-start', async (data) => {
        try {
            const { receiver } = data;
            const senderData = activeUsers.get(socket.id);
            
            if (!senderData) return;
            
            const conversationId = getConversationId(senderData.username, receiver);
            
            // Add to typing users
            if (!typingUsers.has(conversationId)) {
                typingUsers.set(conversationId, new Set());
            }
            typingUsers.get(conversationId).add(senderData.username);
            
            // Notify receiver
            const receiverSocketId = userSockets.get(receiver);
            if (receiverSocketId) {
                io.to(receiverSocketId).emit('typing-start', {
                    sender: senderData.username,
                    conversationId
                });
            }
            
        } catch (error) {
            console.error('Typing start error:', error);
        }
    });

    socket.on('typing-stop', async (data) => {
        try {
            const { receiver } = data;
            const senderData = activeUsers.get(socket.id);
            
            if (!senderData) return;
            
            const conversationId = getConversationId(senderData.username, receiver);
            
            // Remove from typing users
            if (typingUsers.has(conversationId)) {
                typingUsers.get(conversationId).delete(senderData.username);
                
                if (typingUsers.get(conversationId).size === 0) {
                    typingUsers.delete(conversationId);
                }
                
                // Notify receiver
                const receiverSocketId = userSockets.get(receiver);
                if (receiverSocketId) {
                    io.to(receiverSocketId).emit('typing-stop', {
                        sender: senderData.username,
                        conversationId
                    });
                }
            }
            
        } catch (error) {
            console.error('Typing stop error:', error);
        }
    });

    socket.on('message-read', async (data) => {
        try {
            const { messageId } = data;
            const userData = activeUsers.get(socket.id);
            
            if (!userData) return;
            
            // Update message as read
            const result = await db.collection(COLLECTIONS.MESSAGES).updateOne(
                { _id: new ObjectId(messageId), receiver: userData.username },
                { $set: { read: true, readAt: new Date() } }
            );
            
            if (result.modifiedCount > 0) {
                // Notify sender
                const message = await db.collection(COLLECTIONS.MESSAGES).findOne({ 
                    _id: new ObjectId(messageId) 
                });
                
                if (message) {
                    const senderSocketId = userSockets.get(message.sender);
                    if (senderSocketId) {
                        io.to(senderSocketId).emit('message-read', { messageId });
                    }
                }
            }
            
        } catch (error) {
            console.error('Message read error:', error);
        }
    });

    socket.on('delete-message', async (data) => {
        try {
            const { messageId } = data;
            const userData = activeUsers.get(socket.id);
            
            if (!userData) return;
            
            // Check if user owns the message
            const message = await db.collection(COLLECTIONS.MESSAGES).findOne({ 
                _id: new ObjectId(messageId) 
            });
            
            if (message && message.sender === userData.username) {
                // Soft delete (you might want to implement actual deletion or archival)
                await db.collection(COLLECTIONS.MESSAGES).updateOne(
                    { _id: new ObjectId(messageId) },
                    { $set: { deleted: true, deletedAt: new Date() } }
                );
                
                // Notify both users
                const conversationId = message.conversationId;
                const users = conversationId.split('_');
                
                users.forEach(username => {
                    const userSocketId = userSockets.get(username);
                    if (userSocketId) {
                        io.to(userSocketId).emit('message-deleted', { messageId });
                    }
                });
            }
            
        } catch (error) {
            console.error('Delete message error:', error);
        }
    });

    socket.on('clear-chat', async ({ user, target }) => {
        const conversationId = getConversationId(user, target);
        await db.collection(COLLECTIONS.MESSAGES).deleteMany({ conversationId });
        io.to(userSockets.get(user)).emit('chat-cleared', { target });
        io.to(userSockets.get(target)).emit('chat-cleared', { user });
    });

    socket.on('add-status', async (status) => {
        await db.collection(COLLECTIONS.STATUSES).insertOne(status);
        setTimeout(async () => await db.collection(COLLECTIONS.STATUSES).deleteOne({ _id: status._id }), 24 * 60 * 60 * 1000);
        io.emit('new-status');
    });

    socket.on('get-statuses', async (callback) => {
        let statuses = await db.collection(COLLECTIONS.STATUSES).find({}).sort({ timestamp: -1 }).toArray();
        for (let s of statuses) {
            const setting = await db.collection(COLLECTIONS.USER_SETTINGS).findOne({ username: s.user });
            s.avatar = setting?.avatar;
            s.customAvatar = setting?.customAvatar;
        }
        callback(statuses);
    });

    socket.on('delete-account', async (username) => {
        await db.collection(COLLECTIONS.USERS).deleteOne({ username });
        await db.collection(COLLECTIONS.MESSAGES).deleteMany({ $or: [{ sender: username }, { receiver: username }] });
        await db.collection(COLLECTIONS.USER_SETTINGS).deleteOne({ username });
        await db.collection(COLLECTIONS.STATUSES).deleteMany({ user: username });
        io.emit('account-deleted', username);
    });

    socket.on('disconnect', async () => {
        try {
            const userData = activeUsers.get(socket.id);
            if (userData) {
                const { username } = userData;
                
                // Update last seen
                await db.collection(COLLECTIONS.USERS).updateOne(
                    { username },
                    { $set: { lastSeen: new Date() } }
                );
                
                activeUsers.delete(socket.id);
                userSockets.delete(username);
                
                // Remove from typing indicators
                for (const [conversationId, users] of typingUsers.entries()) {
                    if (users.has(username)) {
                        users.delete(username);
                        if (users.size === 0) {
                            typingUsers.delete(conversationId);
                        }
                        
                        // Notify other users in conversation
                        const otherUser = conversationId.split('_').find(user => user !== username);
                        if (otherUser) {
                            const otherSocketId = userSockets.get(otherUser);
                            if (otherSocketId) {
                                io.to(otherSocketId).emit('typing-stop', {
                                    sender: username,
                                    conversationId
                                });
                            }
                        }
                    }
                }
                
                io.emit('user-offline', username);
            }
        } catch (error) {
            console.error('Disconnect error:', error);
        }
    });
});

// Start server after database connection
const PORT = process.env.PORT || 3000;

connectToDatabase().then((client) => {
    server.listen(PORT, () => {
        console.log(`🚀 gramX server running on port ${PORT}`);
        console.log(`📱 Open http://localhost:${PORT} in your browser`);
        console.log(`💾 MongoDB persistence: ENABLED`);
        console.log(`🔍 Text search: ENABLED`);
        console.log(`⚙️ Settings system: ENABLED`);
    });
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log('Shutting down gracefully...');
        await client.close();
        console.log('MongoDB connection closed.');
        process.exit(0);
    });
});
