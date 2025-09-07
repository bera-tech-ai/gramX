const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { OpenAI } = require('openai');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// OpenAI Setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'your-openai-api-key-here'
});

// MongoDB Connection Setup
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://ellyongiro8:QwXDXE6tyrGpUTNb@cluster0.tyxcmm9.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const DB_NAME = 'gramXDB';
const COLLECTIONS = {
    USERS: 'users',
    MESSAGES: 'messages',
    CONVERSATIONS: 'conversations',
    USER_SETTINGS: 'user_settings',
    BLOCKED_USERS: 'blocked_users',
    AI_CONVERSATIONS: 'ai_conversations',
    BANNED_USERS: 'banned_users',
    MODERATION_REPORTS: 'moderation_reports'
};

let db;
let mongoClient;

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/profile_pictures';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'profile-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

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
        await db.collection(COLLECTIONS.USERS).createIndex({ email: 1 }, { unique: true });
        await db.collection(COLLECTIONS.MESSAGES).createIndex({ conversationId: 1, timestamp: 1 });
        await db.collection(COLLECTIONS.MESSAGES).createIndex({ receiver: 1, read: 1 });
        await db.collection(COLLECTIONS.MESSAGES).createIndex({ sender: 1, receiver: 1 });
        await db.collection(COLLECTIONS.MESSAGES).createIndex({ text: 'text' });
        await db.collection(COLLECTIONS.USER_SETTINGS).createIndex({ username: 1 }, { unique: true });
        await db.collection(COLLECTIONS.AI_CONVERSATIONS).createIndex({ userId: 1, timestamp: 1 });
        await db.collection(COLLECTIONS.BANNED_USERS).createIndex({ username: 1 }, { unique: true });
        await db.collection(COLLECTIONS.BANNED_USERS).createIndex({ email: 1 }, { unique: true });
        
        return client;
    } catch (error) {
        console.error('❌ Failed to connect to MongoDB', error);
        process.exit(1);
    }
}

// In-memory storage for active users and typing status
const activeUsers = new Map(); // socket.id -> {username, userId, displayName}
const userSockets = new Map(); // username -> socket.id
const typingUsers = new Map(); // conversationId -> Set of usernames who are typing

// Generate conversation ID for two users
function getConversationId(user1, user2) {
    return [user1, user2].sort().join('_');
}

// Authentication middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
}

// Admin authentication middleware
function authenticateAdmin(req, res, next) {
    const { adminPassword } = req.body;
    
    if (adminPassword === ADMIN_PASSWORD) {
        next();
    } else {
        res.status(403).json({ error: 'Invalid admin password' });
    }
}

// Check if user is banned
async function isUserBanned(username, email) {
    try {
        const bannedUser = await db.collection(COLLECTIONS.BANNED_USERS).findOne({
            $or: [{ username }, { email }]
        });
        return !!bannedUser;
    } catch (error) {
        console.error('Error checking ban status:', error);
        return false;
    }
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
                        $or: [{ sender: username }, { receiver: username }],
                        deletedForEveryone: { $ne: true }
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
                // Get partner user details
                const partnerUser = await db.collection(COLLECTIONS.USERS).findOne(
                    { username: partner },
                    { projection: { displayName: 1, profilePicture: 1, status: 1, lastSeen: 1 } }
                );
                
                userConversations.push({
                    partner,
                    displayName: partnerUser?.displayName || partner,
                    profilePicture: partnerUser?.profilePicture || null,
                    status: partnerUser?.status || '',
                    lastSeen: partnerUser?.lastSeen || new Date(),
                    lastMessage: conv.lastMessage ? {
                        text: conv.lastMessage.text,
                        timestamp: conv.lastMessage.timestamp,
                        sender: conv.lastMessage.sender
                    } : null,
                    unreadCount: conv.unreadCount
                });
            }
        }
        
        // Add Bera AI as the first conversation
        userConversations.unshift({
            partner: 'bera_ai',
            displayName: 'Bera AI',
            profilePicture: '/ai-assistant-icon.png',
            status: 'Online',
            lastSeen: new Date(),
            lastMessage: null,
            unreadCount: 0,
            isAI: true
        });
        
        return userConversations.sort((a, b) => {
            if (a.partner === 'bera_ai') return -1;
            if (b.partner === 'bera_ai') return 1;
            
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
                blockedUsers: [],
                aiSettings: {
                    assistantName: 'Bera AI',
                    personality: 'friendly'
                },
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

// Process message with AI for moderation
async function moderateMessage(text) {
    try {
        // Simple keyword-based moderation (replace with more sophisticated AI moderation if needed)
        const bannedWords = ['spam', 'scam', 'fraud', 'hate', 'violence', 'harassment'];
        const foundWords = bannedWords.filter(word => 
            text.toLowerCase().includes(word.toLowerCase())
        );
        
        return {
            isOffensive: foundWords.length > 0,
            offensiveWords: foundWords,
            confidence: foundWords.length > 0 ? 0.8 : 0.1
        };
    } catch (error) {
        console.error('Moderation error:', error);
        return { isOffensive: false, offensiveWords: [], confidence: 0 };
    }
}

// Process AI response
async function getAIResponse(userId, username, message, personality = 'friendly') {
    try {
        // Get conversation history
        const conversationHistory = await db.collection(COLLECTIONS.AI_CONVERSATIONS)
            .find({ userId })
            .sort({ timestamp: 1 })
            .limit(10)
            .toArray();
        
        // Prepare messages for OpenAI
        const messages = [
            {
                role: "system",
                content: `You are Bera AI, a helpful AI assistant. Your personality is ${personality}. 
                Respond to the user in a ${personality} manner. Keep responses concise and helpful.`
            }
        ];
        
        // Add conversation history
        conversationHistory.forEach(msg => {
            messages.push({
                role: msg.sender === 'ai' ? 'assistant' : 'user',
                content: msg.text
            });
        });
        
        // Add current message
        messages.push({
            role: 'user',
            content: message
        });
        
        // Get response from OpenAI
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: messages,
            max_tokens: 150
        });
        
        const aiResponse = completion.choices[0].message.content;
        
        // Save both user message and AI response to database
        await db.collection(COLLECTIONS.AI_CONVERSATIONS).insertMany([
            {
                userId,
                username,
                text: message,
                sender: 'user',
                timestamp: new Date()
            },
            {
                userId,
                username,
                text: aiResponse,
                sender: 'ai',
                timestamp: new Date()
            }
        ]);
        
        return aiResponse;
    } catch (error) {
        console.error('AI response error:', error);
        return "I'm sorry, I'm having trouble processing your request right now. Please try again later.";
    }
}

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve PWA manifest
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

// Serve service worker
app.get('/sw.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// API Routes
app.post('/register', async (req, res) => {
    try {
        const { username, email, password, displayName } = req.body;
        
        if (!username || !email || !password || !displayName) {
            return res.json({ success: false, error: 'All fields are required' });
        }
        
        // Check if user is banned
        const isBanned = await isUserBanned(username, email);
        if (isBanned) {
            return res.json({ success: false, error: 'This account has been banned' });
        }
        
        // Check if user already exists
        const existingUser = await db.collection(COLLECTIONS.USERS).findOne({
            $or: [{ username }, { email }]
        });
        
        if (existingUser) {
            if (existingUser.username === username) {
                return res.json({ success: false, error: 'Username taken' });
            } else {
                return res.json({ success: false, error: 'Email already registered' });
            }
        }
        
        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Create new user
        await db.collection(COLLECTIONS.USERS).insertOne({
            username,
            email,
            password: hashedPassword,
            displayName,
            profilePicture: null,
            status: 'Hey there! I am using gramX',
            createdAt: new Date(),
            lastSeen: new Date()
        });
        
        // Generate JWT token
        const token = jwt.sign({ username, email }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({ success: true, username, displayName, token });
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
        
        // Check if user is banned
        const user = await db.collection(COLLECTIONS.USERS).findOne({ 
            $or: [{ username }, { email: username }]
        });
        
        if (!user) {
            return res.json({ success: false, error: 'Invalid credentials' });
        }
        
        const isBanned = await isUserBanned(user.username, user.email);
        if (isBanned) {
            return res.json({ success: false, error: 'This account has been banned' });
        }
        
        // Check password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.json({ success: false, error: 'Invalid credentials' });
        }
        
        // Update last seen
        await db.collection(COLLECTIONS.USERS).updateOne(
            { username: user.username },
            { $set: { lastSeen: new Date() } }
        );
        
        // Generate JWT token
        const token = jwt.sign({ username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({ 
            success: true, 
            username: user.username, 
            displayName: user.displayName,
            profilePicture: user.profilePicture,
            status: user.status,
            token 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Login failed' });
    }
});

// Get all users (contacts)
app.get('/users', authenticateToken, async (req, res) => {
    try {
        const users = await db.collection(COLLECTIONS.USERS)
            .find({}, { projection: { password: 0 } })
            .sort({ displayName: 1 })
            .toArray();
        
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch users' });
    }
});

// Get online users
app.get('/online-users', authenticateToken, (req, res) => {
    const onlineUsers = Array.from(activeUsers.values()).map(user => ({
        username: user.username,
        displayName: user.displayName
    }));
    res.json({ success: true, users: onlineUsers });
});

// Get user's conversations
app.get('/user-conversations/:username', authenticateToken, async (req, res) => {
    try {
        const { username } = req.params;
        const conversations = await getUserConversations(username);
        res.json({ success: true, conversations });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to get conversations' });
    }
});

// Search messages
app.get('/search-messages/:username', authenticateToken, async (req, res) => {
    try {
        const { username } = req.params;
        const { query, conversationId } = req.query;
        
        if (!query) {
            return res.json({ success: true, messages: [] });
        }
        
        let searchFilter = { 
            $text: { $search: query },
            deletedForEveryone: { $ne: true }
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
        
        res.json({ success: true, messages });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ success: false, error: 'Search failed' });
    }
});

// Get user settings
app.get('/user-settings/:username', authenticateToken, async (req, res) => {
    try {
        const { username } = req.params;
        const settings = await getUserSettings(username);
        res.json({ success: true, settings });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to get settings' });
    }
});

// Update user settings
app.post('/user-settings/:username', authenticateToken, async (req, res) => {
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

// Update user profile
app.post('/update-profile/:username', authenticateToken, upload.single('profilePicture'), async (req, res) => {
    try {
        const { username } = req.params;
        const { displayName, status } = req.body;
        const profilePicture = req.file ? `/uploads/profile_pictures/${req.file.filename}` : null;
        
        const updateData = { 
            displayName, 
            status,
            updatedAt: new Date()
        };
        
        if (profilePicture) {
            // Delete old profile picture if exists
            const user = await db.collection(COLLECTIONS.USERS).findOne({ username });
            if (user && user.profilePicture && user.profilePicture.startsWith('/uploads/')) {
                const oldImagePath = path.join(__dirname, user.profilePicture);
                if (fs.existsSync(oldImagePath)) {
                    fs.unlinkSync(oldImagePath);
                }
            }
            
            updateData.profilePicture = profilePicture;
        }
        
        await db.collection(COLLECTIONS.USERS).updateOne(
            { username },
            { $set: updateData }
        );
        
        res.json({ success: true, profilePicture: updateData.profilePicture });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to update profile' });
    }
});

// Block user
app.post('/block-user/:username', authenticateToken, async (req, res) => {
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
app.post('/unblock-user/:username', authenticateToken, async (req, res) => {
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
app.get('/blocked-users/:username', authenticateToken, async (req, res) => {
    try {
        const { username } = req.params;
        const settings = await getUserSettings(username);
        res.json({ success: true, blockedUsers: settings.blockedUsers || [] });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to get blocked users' });
    }
});

// Clear chat history
app.post('/clear-chat/:username', authenticateToken, async (req, res) => {
    try {
        const { username } = req.params;
        const { targetUser } = req.body;
        const conversationId = getConversationId(username, targetUser);
        
        // Mark messages as deleted for the user
        await db.collection(COLLECTIONS.MESSAGES).updateMany(
            { 
                conversationId,
                $or: [{ sender: username }, { receiver: username }]
            },
            { $set: { deletedForMe: true } }
        );
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to clear chat' });
    }
});

// Admin authentication
app.post('/admin-auth', authenticateAdmin, (req, res) => {
    res.json({ success: true });
});

// Admin dashboard stats
app.get('/admin/stats', async (req, res) => {
    try {
        const totalUsers = await db.collection(COLLECTIONS.USERS).countDocuments();
        const totalMessages = await db.collection(COLLECTIONS.MESSAGES).countDocuments();
        const activeConnections = activeUsers.size;
        
        res.json({ success: true, totalUsers, totalMessages, activeConnections });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to get stats' });
    }
});

// Admin get users
app.get('/admin/users', async (req, res) => {
    try {
        const users = await db.collection(COLLECTIONS.USERS)
            .find({}, { projection: { password: 0 } })
            .sort({ createdAt: -1 })
            .toArray();
        
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to get users' });
    }
});

// Admin ban user
app.post('/admin/ban-user', async (req, res) => {
    try {
        const { username, reason } = req.body;
        
        // Get user details
        const user = await db.collection(COLLECTIONS.USERS).findOne({ username });
        if (!user) {
            return res.json({ success: false, error: 'User not found' });
        }
        
        // Add to banned users
        await db.collection(COLLECTIONS.BANNED_USERS).insertOne({
            username: user.username,
            email: user.email,
            displayName: user.displayName,
            reason,
            bannedAt: new Date(),
            bannedBy: 'admin'
        });
        
        // Disconnect user if online
        const userSocketId = userSockets.get(username);
        if (userSocketId) {
            io.to(userSocketId).emit('user-banned', { reason });
            io.sockets.sockets.get(userSocketId)?.disconnect();
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to ban user' });
    }
});

// Admin get reported messages
app.get('/admin/reported-messages', async (req, res) => {
    try {
        const reportedMessages = await db.collection(COLLECTIONS.MODERATION_REPORTS)
            .aggregate([
                {
                    $lookup: {
                        from: COLLECTIONS.MESSAGES,
                        localField: 'messageId',
                        foreignField: '_id',
                        as: 'message'
                    }
                },
                { $unwind: '$message' },
                { $sort: { reportedAt: -1 } }
            ])
            .toArray();
        
        res.json({ success: true, reportedMessages });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to get reported messages' });
    }
});

// Socket.io handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('user-login', async (data) => {
        try {
            const { username, displayName } = data;
            const userData = { username, displayName, userId: socket.id };
            activeUsers.set(socket.id, userData);
            userSockets.set(username, socket.id);
            
            // Update last seen
            await db.collection(COLLECTIONS.USERS).updateOne(
                { username },
                { $set: { lastSeen: new Date() } }
            );
            
            // Notify all users about new online user
            io.emit('user-online', { username, displayName });
            
            // Send list of online users to the new user
            const onlineUsers = Array.from(activeUsers.values()).map(user => ({
                username: user.username,
                displayName: user.displayName
            }));
            socket.emit('online-users', onlineUsers);
            
            // Send user's conversation history
            const userConversations = await getUserConversations(username);
            socket.emit('user-conversations', userConversations);
            
        } catch (error) {
            console.error('Login error:', error);
        }
    });

    socket.on('join-conversation', async (data) => {
        try {
            const { currentUser, targetUser } = data;
            
            // Handle Bera AI conversation
            if (targetUser === 'bera_ai') {
                // Get AI conversation history
                const aiConversation = await db.collection(COLLECTIONS.AI_CONVERSATIONS)
                    .find({ username: currentUser })
                    .sort({ timestamp: 1 })
                    .toArray();
                
                socket.emit('conversation-history', {
                    conversationId: 'bera_ai',
                    messages: aiConversation,
                    targetUser: 'bera_ai',
                    isAI: true
                });
                return;
            }
            
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
                .find({ 
                    conversationId,
                    deletedForEveryone: { $ne: true },
                    $or: [
                        { deletedForMe: { $ne: currentUser } },
                        { deletedForMe: { $exists: false } }
                    ]
                })
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
            const { sender, receiver, text, tempId } = data;
            
            // Handle Bera AI messages
            if (receiver === 'bera_ai') {
                const userSettings = await getUserSettings(sender);
                const personality = userSettings.aiSettings.personality || 'friendly';
                
                const aiResponse = await getAIResponse(socket.id, sender, text, personality);
                
                // Send AI response to user
                const aiMessage = {
                    text: aiResponse,
                    sender: 'bera_ai',
                    receiver: sender,
                    timestamp: new Date(),
                    conversationId: 'bera_ai',
                    read: false,
                    delivered: true
                };
                
                socket.emit('new-private-message', { ...aiMessage, tempId });
                return;
            }
            
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
            
            // Moderate message for offensive content
            const moderationResult = await moderateMessage(text);
            if (moderationResult.isOffensive) {
                // Store moderation report
                await db.collection(COLLECTIONS.MODERATION_REPORTS).insertOne({
                    messageText: text,
                    sender,
                    receiver,
                    conversationId,
                    offensiveWords: moderationResult.offensiveWords,
                    confidence: moderationResult.confidence,
                    reportedAt: new Date()
                });
                
                socket.emit('message-error', { 
                    error: 'Message contains inappropriate content and was flagged for review' 
                });
                return;
            }
            
            const message = {
                text,
                sender,
                receiver,
                timestamp: new Date(),
                conversationId,
                read: false,
                delivered: false,
                edited: false
            };

            // Save message to database
            const result = await db.collection(COLLECTIONS.MESSAGES).insertOne(message);
            message._id = result.insertedId;
            
            // Send to sender immediately with temporary ID
            const tempMessage = { ...message, tempId };
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
                    tempId 
                });
            }
            
        } catch (error) {
            console.error('Error sending message:', error);
            socket.emit('message-error', { error: 'Failed to send message' });
        }
    });

    socket.on('edit-message', async (data) => {
        try {
            const { messageId, newText, conversationId } = data;
            const userData = activeUsers.get(socket.id);
            
            if (!userData) return;
            
            // Check if user owns the message
            const message = await db.collection(COLLECTIONS.MESSAGES).findOne({ 
                _id: new ObjectId(messageId) 
            });
            
            if (message && message.sender === userData.username) {
                // Update message
                await db.collection(COLLECTIONS.MESSAGES).updateOne(
                    { _id: new ObjectId(messageId) },
                    { 
                        $set: { 
                            text: newText,
                            edited: true,
                            editedAt: new Date()
                        } 
                    }
                );
                
                // Notify both users
                const users = conversationId.split('_');
                
                users.forEach(username => {
                    const userSocketId = userSockets.get(username);
                    if (userSocketId) {
                        io.to(userSocketId).emit('message-edited', { 
                            messageId, 
                            newText,
                            editedAt: new Date()
                        });
                    }
                });
            }
            
        } catch (error) {
            console.error('Edit message error:', error);
        }
    });

    socket.on('delete-message', async (data) => {
        try {
            const { messageId, deleteForEveryone } = data;
            const userData = activeUsers.get(socket.id);
            
            if (!userData) return;
            
            // Check if user owns the message
            const message = await db.collection(COLLECTIONS.MESSAGES).findOne({ 
                _id: new ObjectId(messageId) 
            });
            
            if (!message) return;
            
            if (message.sender === userData.username) {
                if (deleteForEveryone) {
                    // Delete for everyone
                    await db.collection(COLLECTIONS.MESSAGES).updateOne(
                        { _id: new ObjectId(messageId) },
                        { $set: { deletedForEveryone: true, deletedAt: new Date() } }
                    );
                    
                    // Notify both users
                    const users = message.conversationId.split('_');
                    
                    users.forEach(username => {
                        const userSocketId = userSockets.get(username);
                        if (userSocketId) {
                            io.to(userSocketId).emit('message-deleted', { messageId, deleteForEveryone });
                        }
                    });
                } else {
                    // Delete for me only
                    await db.collection(COLLECTIONS.MESSAGES).updateOne(
                        { _id: new ObjectId(messageId) },
                        { 
                            $addToSet: { deletedForMe: userData.username },
                            $set: { deletedAt: new Date() }
                        }
                    );
                    
                    // Notify only the current user
                    socket.emit('message-deleted', { messageId, deleteForEveryone });
                }
            }
            
        } catch (error) {
            console.error('Delete message error:', error);
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
        console.log(`🤖 Bera AI Assistant: ENABLED`);
        console.log(`👮 Admin Dashboard: ENABLED`);
        console.log(`📲 PWA Features: ENABLED`);
    });
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log('Shutting down gracefully...');
        await client.close();
        console.log('MongoDB connection closed.');
        process.exit(0);
    });
});
