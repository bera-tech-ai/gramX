const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb'); // 1. Import MongoClient and ObjectId

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.json());
app.use(express.static('public'));

// 2. MongoDB Connection Setup
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://ellyongiro8:QwXDXE6tyrGpUTNb@cluster0.tyxcmm9.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const DB_NAME = 'gramXDB'; // You can change this to whatever you want
const COLLECTIONS = {
    USERS: 'users',
    CONVERSATIONS: 'conversations',
    MESSAGES: 'messages' // Alternative approach: storing messages in separate collection
};

let db; // This will hold our database connection

// 3. Connect to MongoDB
async function connectToDatabase() {
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        console.log('✅ Connected successfully to MongoDB Atlas');
        
        db = client.db(DB_NAME);
        
        // Create indexes for better performance
        await db.collection(COLLECTIONS.USERS).createIndex({ username: 1 }, { unique: true });
        await db.collection(COLLECTIONS.MESSAGES).createIndex({ conversationId: 1, timestamp: 1 });
        await db.collection(COLLECTIONS.MESSAGES).createIndex({ receiver: 1, read: 1 });
        
        return client;
    } catch (error) {
        console.error('❌ Failed to connect to MongoDB', error);
        process.exit(1);
    }
}

// In-memory storage for active users (still useful for real-time features)
const activeUsers = new Map(); // socket.id -> {username, userId}
const userSockets = new Map(); // username -> socket.id

// Generate conversation ID for two users (unchanged)
function getConversationId(user1, user2) {
    return [user1, user2].sort().join('_');
}

// 4. Modified: Get user's conversation partners from DB
async function getUserConversations(username) {
    try {
        // Get all conversations where this user is involved
        const userConversations = [];
        
        // Get distinct conversation partners from messages
        const conversations = await db.collection(COLLECTIONS.MESSAGES)
            .aggregate([
                { $match: { $or: [{ sender: username }, { receiver: username }] } },
                { $group: { _id: "$conversationId" } }
            ])
            .toArray();
        
        // For each conversation, get the last message and unread count
        for (const conv of conversations) {
            const conversationId = conv._id;
            const usersInConv = conversationId.split('_');
            const partner = usersInConv.find(user => user !== username);
            
            if (partner) {
                // Get last message
                const lastMessage = await db.collection(COLLECTIONS.MESSAGES)
                    .find({ conversationId })
                    .sort({ timestamp: -1 })
                    .limit(1)
                    .next();
                
                // Get unread count
                const unreadCount = await db.collection(COLLECTIONS.MESSAGES)
                    .countDocuments({ 
                        conversationId, 
                        receiver: username, 
                        read: false 
                    });
                
                userConversations.push({
                    partner,
                    lastMessage: lastMessage ? {
                        text: lastMessage.text,
                        timestamp: lastMessage.timestamp,
                        sender: lastMessage.sender
                    } : null,
                    unreadCount
                });
            }
        }
        
        return userConversations.sort((a, b) => {
            const timeA = a.lastMessage ? new Date(a.lastMessage.timestamp) : new Date(0);
            const timeB = b.lastMessage ? new Date(b.lastMessage.timestamp) : new Date(0);
            return timeB - timeA; // Most recent first
        });
    } catch (error) {
        console.error('Error getting user conversations:', error);
        return [];
    }
}

// Serve main page (unchanged)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 5. Modified: API Routes with MongoDB

app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        // Check if user already exists
        const existingUser = await db.collection(COLLECTIONS.USERS).findOne({ username });
        if (existingUser) {
            return res.json({ success: false, error: 'Username taken' });
        }
        
        // Create new user
        await db.collection(COLLECTIONS.USERS).insertOne({
            username,
            password, // In production, you should hash passwords!
            createdAt: new Date()
        });
        
        res.json({ success: true, username });
    } catch (error) {
        res.json({ success: false, error: 'Registration failed' });
    }
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const user = await db.collection(COLLECTIONS.USERS).findOne({ username, password });
        if (user) {
            res.json({ success: true, username });
        } else {
            res.json({ success: false, error: 'Invalid credentials' });
        }
    } catch (error) {
        res.json({ success: false, error: 'Login failed' });
    }
});

// Get online users (unchanged - still in-memory)
app.get('/online-users', (req, res) => {
    const onlineUsers = Array.from(activeUsers.values()).map(user => user.username);
    res.json({ users: onlineUsers });
});

// Modified: Get user's conversations from DB
app.get('/user-conversations/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const conversations = await getUserConversations(username);
        res.json({ conversations });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get conversations' });
    }
});

// 6. Modified: Socket.io handling with MongoDB

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('user-login', async (username) => {
        const userData = { username, userId: socket.id };
        activeUsers.set(socket.id, userData);
        userSockets.set(username, socket.id);
        
        // Notify all users about new online user
        io.emit('user-online', username);
        
        // Send list of online users to the new user
        const onlineUsers = Array.from(activeUsers.values()).map(user => user.username);
        socket.emit('online-users', onlineUsers);
        
        // Send user's conversation history from DB
        try {
            const userConversations = await getUserConversations(username);
            socket.emit('user-conversations', userConversations);
        } catch (error) {
            console.error('Error getting conversations:', error);
            socket.emit('user-conversations', []);
        }
    });

    socket.on('join-conversation', async (data) => {
        try {
            const { currentUser, targetUser } = data;
            const conversationId = getConversationId(currentUser, targetUser);
            
            // Get conversation messages from DB
            const conversationMessages = await db.collection(COLLECTIONS.MESSAGES)
                .find({ conversationId })
                .sort({ timestamp: 1 })
                .toArray();
            
            // Mark messages as read when user opens conversation
            await db.collection(COLLECTIONS.MESSAGES).updateMany(
                { conversationId, receiver: currentUser, read: false },
                { $set: { read: true } }
            );

            socket.emit('conversation-history', {
                conversationId,
                messages: conversationMessages,
                targetUser: targetUser
            });
        } catch (error) {
            console.error('Error joining conversation:', error);
        }
    });

    socket.on('send-private-message', async (data) => {
        try {
            const { sender, receiver, text } = data;
            const conversationId = getConversationId(sender, receiver);
            
            const message = {
                text,
                sender,
                receiver,
                timestamp: new Date(),
                conversationId,
                read: false
            };

            // Save message to database
            const result = await db.collection(COLLECTIONS.MESSAGES).insertOne(message);
            message._id = result.insertedId; // Add the generated ID

            // Send to sender immediately
            socket.emit('new-private-message', message);
            
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
                io.to(receiverSocketId).emit('new-private-message', message);
                
                // Update receiver's conversation list
                try {
                    const receiverConversations = await getUserConversations(receiver);
                    io.to(receiverSocketId).emit('user-conversations', receiverConversations);
                } catch (error) {
                    console.error('Error updating receiver conversations:', error);
                }
            }
        } catch (error) {
            console.error('Error sending message:', error);
        }
    });

    socket.on('disconnect', () => {
        const userData = activeUsers.get(socket.id);
        if (userData) {
            const { username } = userData;
            activeUsers.delete(socket.id);
            userSockets.delete(username);
            io.emit('user-offline', username);
        }
    });
});

// 7. Start server after database connection
const PORT = process.env.PORT || 3000;

connectToDatabase().then((client) => {
    server.listen(PORT, () => {
        console.log(`🚀 gramX server running on port ${PORT}`);
        console.log(`📱 Open http://localhost:${PORT} in your browser`);
        console.log(`💾 MongoDB persistence: ENABLED`);
    });
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        await client.close();
        console.log('MongoDB connection closed.');
        process.exit(0);
    });
});
